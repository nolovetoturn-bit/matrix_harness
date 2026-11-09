/**
 * 边车调用（零依赖）：把 {cmd,args} 写进 Python 子进程 stdin，读回一个 JSON 文档。
 *
 * 单独成模块是为了让 plugin.mjs（工具）与 lib/scheduler.mjs（定时同步）共用同一份
 * 调用实现，避免循环依赖。契约见 docs/dsh-plugin-spec.md §3。
 *
 * @module rms-wechat-session/sidecar
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 边车脚本路径。 */
export const SIDECAR = fileURLToPath(new URL('../scripts/wechat_sidecar.py', import.meta.url))

/** 专用 venv 的 Python 解释器（wechatauto-replica 只装在这里，不污染全局）。 */
export const DEFAULT_PYTHON = 'C:/Users/admin/.wechat-session-venv/Scripts/python.exe'

const DEFAULT_TIMEOUT_MS = 180000

/**
 * 调用边车。
 * @param {string} cmd 子命令
 * @param {object} [args] 载荷
 * @param {{python_exe?: string, timeout_ms?: number}} [opts]
 * @returns {Promise<object>} 边车输出的 JSON（失败时 `{ok:false,error}`）
 */
export function runSidecar(cmd, args, opts = {}) {
  const pythonExe = (opts.python_exe || DEFAULT_PYTHON).replace(/\\/g, '/')
  const timeoutMs = Number(opts.timeout_ms) > 0 ? Number(opts.timeout_ms) : DEFAULT_TIMEOUT_MS

  if (!existsSync(pythonExe)) {
    return Promise.resolve({
      ok: false,
      error:
        `未找到边车 Python 解释器：${pythonExe}\n` +
        '该路径是专用 venv（wechatauto-replica 装在这里）。重建方式：\n' +
        '  C:\\Python314\\python.exe -m venv C:\\Users\\admin\\.wechat-session-venv\n' +
        '  C:\\Users\\admin\\.wechat-session-venv\\Scripts\\python.exe -m pip install wechatauto-replica\n' +
        '或用 python_exe 参数指定其它含 wechatauto 的解释器。',
    })
  }

  return new Promise(resolve => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = spawn(pythonExe, [SIDECAR], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      done({ ok: false, error: `启动边车失败：${err.message}` })
      return
    }

    const outChunks = []
    const errChunks = []
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* noop */
      }
    }, timeoutMs)

    child.stdout.on('data', d => outChunks.push(d))
    child.stderr.on('data', d => errChunks.push(d))
    child.on('error', err => {
      clearTimeout(timer)
      done({ ok: false, error: `边车进程错误：${err.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      const stdout = Buffer.concat(outChunks).toString('utf8').trim()
      const stderr = Buffer.concat(errChunks).toString('utf8').trim()
      if (code !== 0 && !stdout) {
        done({ ok: false, error: `边车退出码 ${code}：${stderr || '(无输出)'}` })
        return
      }
      // 边车只在 stdout 打一个 JSON 文档；仍取最后一个可解析的行兜底，防止有杂项输出。
      let parsed = null
      const lines = stdout.split(/\r?\n/).filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          parsed = JSON.parse(lines[i])
          break
        } catch {
          /* 继续向前找 */
        }
      }
      if (!parsed) {
        try {
          parsed = JSON.parse(stdout)
        } catch {
          done({ ok: false, error: `无法解析边车输出：${(stderr || stdout).slice(0, 800)}` })
          return
        }
      }
      done(parsed)
    })

    child.stdin.end(JSON.stringify({ cmd, args: args || {} }))
  })
}
