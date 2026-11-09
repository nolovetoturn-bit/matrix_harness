/**
 * 微信动态同步常驻进程（独立于 dsh / MCP 宿主）。
 *
 * 用途：不重启 Trae 也想让调度器跑起来时，直接以独立进程拉起：
 *   node plugins/generic/rms-wechat-session/scripts/sync_daemon.mjs
 * 停止：
 *   node plugins/generic/rms-wechat-session/scripts/sync_daemon.mjs --stop
 *
 * 单例：沿用每个账号的 sync.lock，与 dsh / MCP 平面的调度器互斥；pid 另记在
 * <LOCALAPPDATA>\rms-wechat-session\sync-daemon.pid，供 --stop 精确停掉。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { startScheduler, schedulerStatus, stopScheduler } from '../lib/scheduler.mjs'

const appDir = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'rms-wechat-session')
const pidFile = join(appDir, 'sync-daemon.pid')

if (process.argv.includes('--stop')) {
  if (!existsSync(pidFile)) {
    console.log('没有运行中的同步守护进程（缺少 pid 文件）。')
    process.exit(0)
  }
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try {
    process.kill(pid)
    console.log(`已通知同步守护进程退出：pid ${pid}`)
  } catch (error) {
    console.log(`pid ${pid} 已不存在（${error.message}）`)
    try {
      unlinkSync(pidFile)
    } catch {
      /* noop */
    }
  }
  process.exit(0)
}

const controller = startScheduler({ owner: 'daemon' })
if (!controller.running) {
  console.error(`[sync-daemon] 启动失败：${controller.reason || '未知原因'}`)
  for (const a of controller.accounts || []) {
    if (a.reason) console.error(`[sync-daemon] ${a.account}：${a.reason}`)
  }
  process.exit(1)
}

mkdirSync(appDir, { recursive: true })
writeFileSync(pidFile, String(process.pid), 'utf8')
console.log(`[sync-daemon] pid ${process.pid} 已启动：${controller.accounts.join(', ')}`)

let stopping = false
function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(`[sync-daemon] 收到 ${signal}，正在停止并从状态落盘…`)
  try {
    stopScheduler()
  } catch (error) {
    console.error(`[sync-daemon] 停止失败：${error.message}`)
  }
  try {
    unlinkSync(pidFile)
  } catch {
    /* noop */
  }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))

// 调度器内部的定时器都是 unref 的（避免拖住宿主退出），故这里显式保活。
setInterval(() => {}, 1 << 30)

// 每 10 分钟在日志里落一行状态，便于排查。
setInterval(() => {
  try {
    const st = schedulerStatus({})
    for (const a of st.accounts) {
      const r = a.last_result || {}
      console.log(
        `[sync-daemon] ${a.account} 运行=${a.running} 跟踪=${a.counts?.tracked} 到期=${a.counts?.due} ` +
          `上轮=${r.chats || 0}会话/${r.new || 0}条 错误=${a.last_error || '-'}`,
      )
    }
  } catch (error) {
    console.error(`[sync-daemon] 状态输出失败：${error.message}`)
  }
}, 10 * 60 * 1000).unref()
