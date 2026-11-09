/**
 * rms-dingtalk-session — 可移植清单 + 零依赖实现。契约见 docs/dsh-plugin-spec.md §3。
 *
 * 作用：读取本机钉钉（Windows PC 版）的会话内容，并可经 UI 自动化发送文本消息。
 * 原理：钉钉把会话/消息存在 AES-128-ECB 整文件加密的 SQLite 库里
 *   %APPDATA%\DingTalk\<account>_v3\DBFiles\dingtalk.db (+ -wal)
 * 密钥常驻在 DingTalk.exe 进程内存中，可只读扫描取出——**无需管理员权限、不改客户端**。
 * WAL 的校验和是对加密页计算的，解密后 SQLite 会丢弃这些帧，故边车按帧头页号手工合并解密页。
 *
 * 分工：本文件保持零依赖，只做「参数校验 + 调边车 + 渲染」；
 * 真正解密读库与 UI 自动化的重活在 scripts/dingtalk_sidecar.py（Python，跑在专用 venv 里）。
 *
 * @module rms-dingtalk-session
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 插件标识，kebab-case，与目录名一致。 */
export const id = 'rms-dingtalk-session'

/** 插件类别：与 rms 领域无关、脱离本项目仍可原样复用 → generic。 */
export const kind = 'generic'

/** 一句话说明。 */
export const description =
  '读写本机钉钉（Windows PC 版）：解密本地 AES 加密数据库列出会话、增量采集消息、按会话导出 NDJSON；也可经 UI 自动化发送文本消息。'

/* ------------------------------------------------------------------ */
/* 边车调用                                                            */
/* ------------------------------------------------------------------ */

/** 边车脚本路径（相对本文件）。 */
const SIDECAR = fileURLToPath(new URL('./scripts/dingtalk_sidecar.py', import.meta.url))

/** 专用 venv 的 Python 解释器（cryptography / psutil / uiautomation 只装在这里）。 */
const DEFAULT_PYTHON = 'C:/Users/admin/.wechat-session-venv/Scripts/python.exe'

const DEFAULT_TIMEOUT_MS = 180000

/**
 * 调用边车：把 {cmd,args} 写进子进程 stdin，读回一个 JSON 文档。
 * 用管道而非参数传 JSON，避免 Windows 上 cmd.exe 对引号的二次解析。
 */
function runSidecar(cmd, args, opts = {}) {
  const pythonExe = (opts.python_exe || DEFAULT_PYTHON).replace(/\\/g, '/')
  const timeoutMs = Number(opts.timeout_ms) > 0 ? Number(opts.timeout_ms) : DEFAULT_TIMEOUT_MS

  if (!existsSync(pythonExe)) {
    return Promise.resolve({
      ok: false,
      error:
        `未找到边车 Python 解释器：${pythonExe}\n` +
        '该路径是专用 venv（cryptography / psutil / uiautomation 装在这里）。重建方式：\n' +
        '  C:\\Python314\\python.exe -m venv C:\\Users\\admin\\.wechat-session-venv\n' +
        '  C:\\Users\\admin\\.wechat-session-venv\\Scripts\\python.exe -m pip install cryptography psutil uiautomation pillow\n' +
        '或用 python_exe 参数指定其它已装上述依赖的解释器。',
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

/* ------------------------------------------------------------------ */
/* 渲染辅助                                                            */
/* ------------------------------------------------------------------ */

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function line(...parts) {
  return parts.filter(p => p !== undefined && p !== null && p !== '').join('  ')
}

function errorText(title, res) {
  const extra = res && res.error ? `\n${res.error}` : ''
  const hints = res && res.dingtalk_running === false
    ? '\n提示：钉钉 PC 版当前未运行——密钥常驻进程内存，必须先登录钉钉。'
    : ''
  return `${title}失败。${extra}${hints}`
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

const dingtalkStatus = {
  name: 'dingtalk_status',
  description:
    '检查本机钉钉采集链路是否可用：钉钉进程是否运行、当前账号、数据库密钥能否取出、会话总数、边车环境。触发场景：钉钉插件体检、读不到消息、密钥是否可用、排查采集失败。Keywords: dingtalk status, doctor, health check, db key, troubleshooting, 钉钉 体检',
  parameters: {
    type: 'object',
    properties: {
      account: { type: 'string', description: '钉钉账号数据目录名（%APPDATA%\\DingTalk 下的 *_v3）；缺省 = 自动选最近活跃的账号' },
      python_exe: { type: 'string', description: '边车 Python 解释器路径（默认专用 venv）' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar('doctor', { account: args.account }, { python_exe: args.python_exe, timeout_ms: 240000 })
    if (res.ok !== true) return errorText('钉钉采集链路体检', res)

    const pids = (res.dingtalk_pids || []).join(', ')
    const lines = [
      '钉钉采集链路体检：**正常**',
      line('· 钉钉进程：', res.dingtalk_running ? `运行中（pid ${pids}）` : '未运行'),
      line('· 本机账号：', `${res.self_name || '?'}（uid ${res.self_uid || '?'}）`),
      line('· 数据库密钥：', res.db_key_ok ? '已就绪，可解密读库' : '不可用'),
      line('· 会话总数：', res.conversation_count ?? '(未取到)'),
      line('· 消息分片：', res.message_shards),
      line('· 联系人档案：', res.profile_count),
      line('· 边车：', `Python ${res.python_version} / cryptography ${res.cryptography_version || '?'}`),
      line('· 解释器：', res.python),
      line('· 账号目录：', res.account),
      line('· 数据库：', res.db_path),
      line('· 数据目录：', res.config && res.config.data_dir),
      line('· 游标文件：', res.cursor_path),
    ]
    const dirs = res.account_dirs || []
    if (dirs.length > 1) lines.push(`· 可用账号目录：${dirs.join(', ')}（可用 account 指定）`)
    return lines.join('\n')
  },
}

const dingtalkSessions = {
  name: 'dingtalk_sessions',
  description:
    '列出本机钉钉的会话列表：会话名、未读数、成员数、最近一条消息摘要与时间。1:1 会话会自动把 uid 解析成联系人昵称。触发场景：钉钉会话列表、最近聊天、未读消息概览、有哪些群。Keywords: dingtalk sessions, chat list, conversations, unread, 钉钉 会话 列表',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '最多返回多少条会话（默认 50）' },
      account: { type: 'string', description: '钉钉账号数据目录名；缺省 = 自动选最近活跃的账号' },
      python_exe: { type: 'string', description: '边车 Python 解释器路径' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar(
      'sessions',
      { limit: Number(args.limit) > 0 ? Number(args.limit) : 50, account: args.account },
      { python_exe: args.python_exe, timeout_ms: 120000 },
    )
    if (res.ok !== true) return errorText('读取钉钉会话列表', res)

    const rows = res.sessions || []
    const head = `钉钉会话（显示 ${rows.length} 条，共 ${res.total_listed} 条）：\n`
    const body = rows
      .map(s => {
        const unread = Number(s.unread) > 0 ? `未读 ${s.unread}` : '已读'
        const kind = s.type === 2 ? `群 ${s.member_count} 人` : '单聊'
        return line(`· ${s.name || s.cid}`, `[${kind}]`, `[${unread}]`, s.last_datetime,
          s.summary ? `｜${s.summary.slice(0, 60)}` : '')
      })
      .map(l => l.replace(/\s+/g, ' ').trim())
      .join('\n')
    return head + body
  },
}

const dingtalkFetch = {
  name: 'dingtalk_fetch',
  description:
    '执行一轮钉钉会话内容采集（增量）：解密本地数据库，把范围内全部会话的**新**消息归一化为 NDJSON 落盘，并返回新增统计。已采集过的消息按游标跳过，重复调用不产生重复数据。触发场景：获取钉钉聊天记录、采集/同步会话内容、定时导出、增量拉取消息。Keywords: dingtalk fetch, collect, chat history, messages, export, incremental, 钉钉 采集 聊天记录',
  parameters: {
    type: 'object',
    properties: {
      max_chats: { type: 'integer', description: '最多采集多少个会话（0 或缺省 = 全部）' },
      limit_per_chat: { type: 'integer', description: '首次采集每个会话最多回溯多少条（默认 200）' },
      chats: {
        type: 'array',
        items: { type: 'string' },
        description: '只采集这些会话（可填会话名 / 联系人昵称 / cid）；缺省 = 全部会话',
      },
      skip_chats: {
        type: 'array',
        items: { type: 'string' },
        description: '跳过这些会话（可填会话名 / 联系人昵称 / cid）；用于排除超大群等',
      },
      account: { type: 'string', description: '钉钉账号数据目录名；缺省 = 自动选最近活跃的账号' },
      python_exe: { type: 'string', description: '边车 Python 解释器路径' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar(
      'fetch',
      {
        max_chats: Number(args.max_chats) || 0,
        limit_per_chat: Number(args.limit_per_chat) || 0,
        chats: Array.isArray(args.chats) ? args.chats : [],
        skip_chats: Array.isArray(args.skip_chats) ? args.skip_chats : [],
        account: args.account,
      },
      { python_exe: args.python_exe, timeout_ms: 600000 },
    )
    if (res.ok !== true) return errorText('钉钉会话内容采集', res)

    const top = res.per_chat_top || []
    const lines = [
      '钉钉会话内容采集完成。',
      line('· 扫描会话：', `${res.chats_read}/${res.chats_total}`),
      line('· 新增消息：', `${res.messages_new} 条（已写入 ${res.written} 行）`),
      line('· 落盘文件：', res.output_file),
      line('· 游标：', '已更新，重复调用不会重复采集'),
    ]
    if (top.length) {
      lines.push('· 新增最多的会话：')
      for (const r of top) lines.push(`    - ${r.chat}：+${r.new}`)
    }
    if ((res.errors || []).length) {
      lines.push(`· 读取失败的会话（${res.errors.length} 个）：`)
      for (const e of res.errors.slice(0, 10)) lines.push(`    - ${e.chat}：${e.error}`)
    }
    return lines.join('\n')
  },
}

const dingtalkSend = {
  name: 'dingtalk_send',
  description:
    '发送钉钉文本消息到指定会话/联系人。**走 UI 自动化**：会还原并置顶钉钉窗口，点击搜索框、在搜索面板里精确点选目标、聚焦输入框后经剪贴板粘贴并回车发送，期间真实占用鼠标键盘（请勿同时操作电脑）。仅支持纯文本，不支持图片/文件。建议 verify=true 回读数据库确认已落库。触发场景：发钉钉消息、给某联系人/群发消息、在当前会话回复、自测发送链路。Keywords: dingtalk send, send message, text, ui automation, 钉钉 发送 消息',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要发送的文本内容' },
      to: { type: 'string', description: '目标会话名称（联系人或群名，也可填 cid）' },
      verify: { type: 'boolean', description: '发送后回读数据库确认已落库（默认 false；建议开启）' },
      wait_ms: { type: 'integer', description: '搜索面板等待结果的最长时间（毫秒，默认 8000）' },
      account: { type: 'string', description: '回读校验用的账号数据目录名；缺省 = 自动选最近活跃的账号' },
      python_exe: { type: 'string', description: '边车 Python 解释器路径' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar(
      'send',
      {
        to: args.to,
        text: args.text,
        verify: args.verify === true,
        wait_ms: Number(args.wait_ms) || 0,
        account: args.account,
      },
      { python_exe: args.python_exe, timeout_ms: 300000 },
    )
    if (res.ok !== true) return errorText('发送钉钉消息', res)

    const lines = [
      '钉钉发送结果（UI 自动化）。',
      line('· 目标会话：', res.to),
      line('· 解析 cid：', res.resolved_cid || '(未解析到)'),
      line('· 发送账号：', res.account),
      line('· 回读确认：', res.verify ? (res.verified ? '已确认落库' : '已开启但未确认') : '未开启（建议 verify=true）'),
    ]
    const steps = (res.steps || []).map(s => s.step)
    if (steps.length) lines.push(`· 执行步骤：${steps.join(' → ')}`)
    if (res.verified && (res.db_tail || []).length) {
      lines.push('· 库内最后几条：')
      for (const r of res.db_tail.slice(0, 3)) lines.push(`    - ${r.text}`)
    }
    return lines.join('\n')
  },
}

const dingtalkConfig = {
  name: 'dingtalk_config',
  description:
    '读取或修改钉钉采集边车配置：数据落盘目录、每会话回溯条数、会话上限、采集白名单、跳过会话。不带 set 时只读。触发场景：配置钉钉采集、改数据目录、限定只采集某些会话。Keywords: dingtalk config, settings, data dir, whitelist, 钉钉 配置',
  parameters: {
    type: 'object',
    properties: {
      set: {
        type: 'object',
        description: '要写入的配置项（键：account / data_dir / limit_per_chat / max_chats / chats / skip_chats / content_max_chars）',
      },
      python_exe: { type: 'string', description: '边车 Python 解释器路径' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar(
      'config',
      { set: args.set && typeof args.set === 'object' ? args.set : undefined },
      { python_exe: args.python_exe, timeout_ms: 120000 },
    )
    if (res.ok !== true) return errorText('读取钉钉采集配置', res)

    const c = res.config || {}
    return [
      '钉钉采集配置：',
      line('· 账号：', c.account || '（自动）'),
      line('· 数据目录：', c.data_dir),
      line('· 每会话回溯条数：', c.limit_per_chat),
      line('· 会话上限：', c.max_chats === 0 ? '0（全部）' : c.max_chats),
      line('· 采集白名单：', (c.chats || []).length ? c.chats.join(', ') : '（空 = 全部会话）'),
      line('· 跳过会话：', (c.skip_chats || []).length ? c.skip_chats.join(', ') : '（空）'),
      line('· 单条内容截断：', c.content_max_chars),
      line('· 配置文件：', res.config_path),
    ].join('\n')
  },
}

/** 工具清单（两平面共用的唯一契约）。 */
export const tools = [dingtalkStatus, dingtalkSessions, dingtalkFetch, dingtalkSend, dingtalkConfig]
