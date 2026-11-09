/**
 * rms-wechat-session — 可移植清单 + 零依赖实现。契约见 docs/dsh-plugin-spec.md §3。
 *
 * 作用：读取本机微信 4.x（Windows PC 版）的会话内容。
 * 原理：微信 4.x 把会话/消息存在 SQLCipher 4 加密的本地库里
 *   %USERPROFILE%\Documents\xwechat_files\<wxid>\db_storage\{session,message_*,contact}.db
 * 密钥（每库一份）常驻在 Weixin.exe 进程内存中，可只读扫描取出——**无需管理员权限、不改客户端**。
 *
 * 分工：本文件保持零依赖，只做「参数校验 + 调边车 + 渲染」；
 * 真正解密读库的重活在 scripts/wechat_sidecar.py（Python，跑在专用 venv 里，用 wechatauto-replica）。
 * 二者以 JSON 经 stdin/stdout 通信，故 Node 侧不碰任何命令行引号问题。
 *
 * @module rms-wechat-session
 */

import { runSidecar } from './lib/sidecar.mjs'
import {
  SYNC_DEFAULTS,
  noteActivity,
  schedulerStatus,
  startScheduler,
  stopScheduler,
  syncOnce,
} from './lib/scheduler.mjs'

/** 插件标识，kebab-case，与目录名一致。 */
export const id = 'rms-wechat-session'

/** 插件类别：与 rms 领域无关、脱离本项目仍可原样复用 → generic。 */
export const kind = 'generic'

/** 一句话说明。 */
export const description =
  '读写本机微信 4.x（Windows PC 版）：解密本地 SQLCipher 数据库列出会话、增量采集消息、把全部历史连同媒体全量回溯导出；也可经 UI 自动化发送文本/图片/文件。'

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
  const hints = res && res.wechat_running === false ? '\n提示：微信 PC 版当前未运行——密钥常驻进程内存，必须先登录微信。' : ''
  return `${title}失败。${extra}${hints}`
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

const wechatStatus = {
  name: 'wechat_status',
  description:
    '检查本机微信 4.x 采集链路是否可用：微信进程是否运行、当前登录账号、SQLCipher 数据库密钥能否取出、会话总数、边车环境。触发场景：微信插件体检、读不到消息、密钥是否可用、排查采集失败。Keywords: wechat status, doctor, health check, sqlcipher key, troubleshooting, 微信 体检',
  parameters: {
    type: 'object',
    properties: {
      account: { type: 'string', description: '读库账号（xwechat_files 下的目录名，如 BurstM_792c）；缺省 = 插件默认账号' },
      python_exe: { type: 'string', description: '边车 Python 解释器路径（默认专用 venv）' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar('doctor', { account: args.account }, { python_exe: args.python_exe, timeout_ms: 120000 })
    if (res.ok !== true) return errorText('微信采集链路体检', res)

    const pids = (res.wechat_process_pids || []).join(', ')
    const self = res.self || {}
    const lines = [
      '微信采集链路体检：**正常**',
      line('· 微信进程：', res.wechat_running ? `运行中（pid ${pids}）` : '未运行'),
      line('· 本机账号：', `${self.nick_name || '?'}（${self.username || '?'}）`),
      line('· 数据库密钥：', res.db_key_ok ? '已从进程内存取出，可解密读库' : '不可用'),
      line('· 会话总数：', res.session_count ?? '(未取到)'),
      line('· 边车：', `Python ${res.python_version} / wechatauto-replica ${res.wechatauto_version}`),
      line('· 解释器：', res.python),
      line('· 读库账号：', res.account),
      line('· 账号目录：', res.account_dir),
      line('· 数据目录：', res.config && res.config.data_dir),
      line('· 游标文件：', res.cursor_path),
    ]
    const insts = res.instances || []
    if (insts.length > 1) {
      lines.push(`· 微信实例：**${insts.length} 个（多开）**`)
      for (const it of insts) {
        const mark = it.account === res.account ? ' ← 当前读库/发送账号' : ''
        lines.push(
          `    hwnd=${it.hwnd} pid=${it.pid} 账号=${it.account || `未识别(${it.wxid || '-'})`}` +
            `${it.minimized ? '（已最小化，发送前需还原）' : ''}${mark}`,
        )
      }
    } else if (insts.length === 1) {
      const it = insts[0]
      lines.push(line('· 微信实例：', `1 个（hwnd=${it.hwnd} pid=${it.pid} 账号=${it.account || it.wxid || '未识别'}）`))
    }
    return lines.join('\n')
  },
}

const wechatSessions = {
  name: 'wechat_sessions',
  description:
    '列出本机微信的会话列表：会话名、未读数、最近一条消息摘要与时间。触发场景：微信会话列表、最近聊天、未读消息概览、有哪些群。Keywords: wechat sessions, chat list, conversations, unread, 微信 会话 列表',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '最多返回多少条会话（默认 50）' },
      account: { type: 'string', description: '读库账号（xwechat_files 下的目录名）；缺省 = 插件默认账号' },
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
    if (res.ok !== true) return errorText('读取微信会话列表', res)

    const rows = res.sessions || []
    const head = `微信会话（显示 ${rows.length} 条，已加载 ${res.total_listed} 条）：\n`
    const body = rows
      .map(s => {
        const unread = Number(s.unread) > 0 ? `未读 ${s.unread}` : '已读'
        const muted = s.muted ? '[消息免打扰]' : ''
        return line(`· ${s.name || s.username}`, `[${unread}]`, muted, s.last_datetime, s.summary ? `｜${s.summary.slice(0, 60)}` : '')
      })
      .map(l => l.replace(/\s+/g, ' ').trim())
      .join('\n')
    return head + body
  },
}

const wechatFetch = {
  name: 'wechat_fetch',
  description:
    '执行一轮微信会话内容采集（增量）：解密本地数据库，把范围内全部会话的**新**消息归一化为 NDJSON 落盘，并返回新增统计。已采集过的消息按游标跳过，重复调用不产生重复数据。触发场景：获取微信聊天记录、采集/同步会话内容、定时导出、增量拉取消息。Keywords: wechat fetch, collect, chat history, messages, export, incremental, 微信 采集 聊天记录',
  parameters: {
    type: 'object',
    properties: {
      max_chats: { type: 'integer', description: '最多采集多少个会话（0 或缺省 = 全部）' },
      limit_per_chat: { type: 'integer', description: '首次采集每个会话最多回溯多少条（默认 200）' },
      chats: {
        type: 'array',
        items: { type: 'string' },
        description: '只采集这些会话（可填会话名/昵称/备注/username）；缺省 = 全部会话',
      },
      skip_chats: {
        type: 'array',
        items: { type: 'string' },
        description: '跳过这些会话（可填会话名/昵称/备注/username）；用于排除超大群等',
      },
      account: { type: 'string', description: '读库账号（xwechat_files 下的目录名）；缺省 = 插件默认账号' },
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
    if (res.ok !== true) return errorText('微信会话内容采集', res)

    const top = res.per_chat_top || []
    const lines = [
      '微信会话内容采集完成。',
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

const wechatNew = {
  name: 'wechat_new',
  description:
    '检测本机微信哪些会话**有新消息**：读会话库的未读数，返回「会话 + 未读数 + 最后一条摘要与时间」，并把本次新出现/有变化的会话追加到按账号隔离的 NDJSON 存档。纯只读、不驱动微信窗口，微信最小化时同样可用；重复调用不会重复落盘。默认剔除公众号/服务号推送，只留真人会话与群聊。触发场景：检查有没有新微信消息、未读提醒、谁给我发消息了、新消息通知、消息到达检测。Keywords: wechat new messages, unread count, notification check, incoming, 微信 新消息 未读 提醒',
  parameters: {
    type: 'object',
    properties: {
      exclude_service: {
        type: 'boolean',
        description: '是否剔除公众号/服务号/系统通知推送（默认 true，只留真人会话与群聊）',
      },
      min_unread: { type: 'integer', description: '未读数达到多少才算「有新消息」（默认 1）' },
      max: { type: 'integer', description: '本次最多返回多少个会话明细（默认 50）' },
      limit: { type: 'integer', description: '最多扫描多少个会话（0 或缺省 = 全部）' },
      account: { type: 'string', description: '读库账号（xwechat_files 下的目录名）；缺省 = 插件默认账号' },
      python_exe: { type: 'string', description: '边车 Python 解释器路径' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar(
      'new',
      {
        exclude_service: typeof args.exclude_service === 'boolean' ? args.exclude_service : undefined,
        min_unread: Number(args.min_unread) || 0,
        max: Number(args.max) || 0,
        limit: Number(args.limit) || 0,
        account: args.account,
      },
      { python_exe: args.python_exe, timeout_ms: 120000 },
    )
    if (res.ok !== true) return errorText('微信新消息检测', res)

    const rows = res.sessions || []
    const scope = `扫描 ${res.scanned} 个会话` +
      (res.exclude_service ? `，已剔除服务号推送 ${res.skipped_service} 个` : '（未剔除服务号推送）')
    const tail = []
    if (res.output_file) tail.push(line('· 存档文件：', res.output_file))
    tail.push(line('· 快照文件：', res.state_file))

    if (!rows.length) {
      return ['微信新消息检测完成：**当前没有未读消息**。', `· ${scope}`, ...tail].join('\n')
    }

    const lines = [
      `微信新消息检测：**${res.unread_chats} 个会话有新消息**（未读合计 ${res.total_unread} 条）。`,
      line('· 本次新增/有变化：', `${res.changed} 个`),
      `· ${scope}`,
    ]
    for (const r of rows) {
      lines.push(
        line(
          `· ${r.chat_name || r.chat_username}`,
          `[未读 ${r.unread}]`,
          r.last_datetime,
          r.last_sender ? `｜${r.last_sender}` : '',
        ),
      )
      if (r.summary) lines.push(`    ${String(r.summary).replace(/\s+/g, ' ').slice(0, 80)}`)
    }
    if (res.sessions_truncated) lines.push(`· （仅显示前 ${rows.length} 个，可用 max 调整）`)
    return [...lines, ...tail].join('\n')
  },
}

const wechatBackfill = {
  name: 'wechat_backfill',
  description:
    '把本机微信指定会话（缺省 = 全部）的历史消息**从最新翻到最老全量导出**，逐会话落一份 NDJSON，可选一并下载图片/语音/视频/文件。与 wechat_fetch 互补：增量采集受游标限制无法补历史，回溯模式不受限。按会话幂等落盘，中断/超时后重跑会自动跳过已完成的会话、继续补采。触发场景：全量导出微信聊天记录、补采历史消息、翻历史、连同媒体一起归档。Keywords: wechat backfill, full history export, archive, media download, 微信 全量 回溯 历史 导出',
  parameters: {
    type: 'object',
    properties: {
      chats: {
        type: 'array',
        items: { type: 'string' },
        description: '只回溯这些会话（可填会话名/昵称/备注/username）；缺省 = 全部会话',
      },
      max_chats: { type: 'integer', description: '本次最多处理多少个会话（0 或缺省 = 全部）' },
      download_media: { type: 'boolean', description: '是否一并下载图片/语音/视频/文件（默认 true）' },
      force: { type: 'boolean', description: '对已完成的会话强制重做（默认 false，即断点续跑）' },
      skip_chats: {
        type: 'array',
        items: { type: 'string' },
        description: '跳过这些会话（可填会话名/昵称/备注/username）；用于排除超大群等',
      },
      account: { type: 'string', description: '读库账号（xwechat_files 下的目录名）；缺省 = 插件默认账号' },
      python_exe: { type: 'string', description: '边车 Python 解释器路径' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar(
      'backfill',
      {
        chats: Array.isArray(args.chats) ? args.chats : [],
        max_chats: Number(args.max_chats) || 0,
        download_media: typeof args.download_media === 'boolean' ? args.download_media : undefined,
        force: args.force === true,
        skip_chats: Array.isArray(args.skip_chats) ? args.skip_chats : [],
        account: args.account,
      },
      { python_exe: args.python_exe, timeout_ms: 600000 },
    )
    if (res.ok !== true) return errorText('微信历史全量回溯', res)

    const done = res.done || []
    const lines = [
      '微信历史全量回溯完成。',
      line('· 会话：', `${res.chats_backfilled} 完成 / ${res.chats_skipped} 跳过（已完成）/ 共 ${res.chats_total}`),
      line('· 导出消息：', `${res.messages} 条`),
      line('· 媒体：', res.download_media ? `下载 ${res.media_downloaded}，失败 ${res.media_failed}` : '未下载'),
      line('· 落盘目录：', res.backfill_dir),
    ]
    if (res.chats_empty) lines.push(`· 空会话（不落文件，留待重跑）：${res.chats_empty}`)
    if (done.length) {
      lines.push('· 消息最多的会话：')
      for (const r of done.slice(0, 15)) {
        lines.push(`    - ${r.chat}：${r.messages} 条${r.media ? `（媒体 ${r.media}）` : ''}`)
      }
    }
    if ((res.errors || []).length) {
      lines.push(`· 失败的会话（${res.errors.length} 个）：`)
      for (const e of res.errors.slice(0, 10)) lines.push(`    - ${e.chat}：${e.error}`)
    }
    if (res.chats_skipped || res.errors.length) {
      lines.push('提示：回溯按会话幂等，重复调用本工具即可继续补采未完成的会话。')
    }
    return lines.join('\n')
  },
}

const wechatSend = {
  name: 'wechat_send',
  description:
    '发送微信消息（文本 / 图片 / 文件）到指定会话或当前打开的会话。**走 UI 自动化**：会把遮挡窗口最小化、置顶微信并真实驱动鼠标键盘，要求微信窗口可见且未锁屏，发送期间电脑无法正常使用；因此只适合手动、低频调用，请勿高频或群发（有触发微信风控的风险）。quiet=true 时改走静默路线：不移动鼠标、不点击、不置顶，微信可被别的窗口盖住（仅支持纯文本、不支持 reply；切换目标会话时会短暂占用前台 1-2 秒）。触发场景：发微信消息、给某好友/群发消息、把图片或文件发到微信、在当前会话回复、后台静默发送。Keywords: wechat send, send message, send image, send file, reply, quiet, background, 微信 发送 消息 图片 文件 静默 后台',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要发送的文本内容（与 image/file 可同时给，按 文本→图片→文件 顺序发送）' },
      to: { type: 'string', description: '目标会话名称（好友昵称/备注/群名）；缺省 = 当前已打开的会话' },
      image: { type: 'string', description: '要发送的本地图片路径' },
      file: { type: 'string', description: '要发送的本地文件路径' },
      reply: { type: 'boolean', description: '以「回复最近一条消息」的方式发送文本（默认 false，即普通发送）' },
      verify: { type: 'boolean', description: '发送后回读数据库确认已落库（默认 false；开启更稳妥但更慢）' },
      quiet: { type: 'boolean', description: '静默发送（默认 false）：不移动鼠标、不点击、不置顶，微信可被别的窗口盖住。仅支持纯文本、不支持 reply；切换目标会话时会短暂占用前台 1-2 秒' },
      account: { type: 'string', description: '回读校验用的账号（xwechat_files 下的目录名）；缺省 = 插件默认账号' },
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
        image: args.image,
        file: args.file,
        reply: args.reply === true,
        verify: args.verify === true,
        quiet: args.quiet === true,
        account: args.account,
      },
      { python_exe: args.python_exe, timeout_ms: 600000 },
    )
    if (res.ok !== true) return errorText('发送微信消息', res)

    const rows = res.results || []
    const label = { text: '文本', image: '图片', file: '文件' }
    const lines = [
      `微信发送结果（${res.quiet ? '静默模式，不占用鼠标与窗口' : 'UI 自动化'}）。`,
      line('· 目标会话：', res.to),
      line('· 发送账号：', res.account),
    ]
    if (res.instance) {
      lines.push(line('· 实例窗口：', `hwnd=${res.instance.hwnd} pid=${res.instance.pid}`))
    }
    lines.push(
      line('· 成功：', `${res.sent}/${res.total}`),
      line('· 回读确认：', res.verify ? '已开启' : '未开启'),
    )
    for (const r of rows) {
      const t = r.target ? `：${r.target}` : ''
      lines.push(`    - [${label[r.kind] || r.kind}] ${r.status}${t}${r.message ? `｜${r.message}` : ''}`)
    }
    if (res.sent < res.total) {
      lines.push(res.quiet
        ? '提示：静默失败多半是微信窗口被最小化，或目标会话名不匹配（可先用 wechat_sessions 核对名称）。'
        : '提示：失败多半是微信窗口不可见/被锁屏，或目标会话名不匹配（可先用 wechat_sessions 核对名称）。')
    }
    if (res.sent > 0 && res.to) {
      // 主动发消息 = 强交互信号：让该会话在动态调度里更快被同步。
      try {
        noteActivity(res.to, 5, res.account || args.account)
      } catch {
        /* 调度状态更新失败不影响发送结果 */
      }
    }
    return lines.join('\n')
  },
}

/* ------------------------------------------------------------------ */
/* 动态同步调度器                                                      */
/* ------------------------------------------------------------------ */

/** 秒 → 人类可读时长。 */
function durText(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  if (s < 60) return `${Math.round(s)} 秒`
  if (s < 3600) return `${Math.round(s / 60)} 分钟`
  const h = s / 3600
  return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`
}

/** epoch 秒 → 本地时间串。 */
function tsText(seconds) {
  const s = Number(seconds) || 0
  if (!s) return '—'
  const d = new Date(s * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 单个账号的调度明细。 */
function syncAccountText(a, detail) {
  const c = a.config || {}
  const n = a.counts || {}
  const lines = [
    `**${a.account}**：${a.running ? '运行中' : '未运行'}`,
    line('  · 单例锁：', a.lock_holder_alive
      ? `被 pid ${a.lock.pid}（${a.lock.owner || '?'}）持有`
      : (a.lock ? '残留（持有进程已退出，可重新启动）' : '空闲')),
    line('  · 会话：', `跟踪 ${n.tracked ?? 0} / 活跃 ${n.active ?? 0} / 免打扰 ${n.muted ?? 0} / 当前到期 ${n.due ?? 0}`),
    line('  · 扫描间隔：', `${c.sync_scan_seconds}s`, '｜上次扫描：', tsText(a.last_scan), '｜上次同步：', tsText(a.last_fetch)),
  ]
  const r = a.last_result
  if (r) {
    lines.push(line('  · 最近一轮：', `${r.chats} 个会话，新增 ${r.new} 条（自己 ${r.self} / 他人 ${r.in}），写入 ${r.written} 行（${tsText(r.at)}）`))
  }
  if (a.last_error) lines.push(`  · 最近错误：${a.last_error}`)
  if (detail && (a.hot || []).length) {
    lines.push('  · 间隔最短（最活跃）的会话：')
    for (const h of a.hot.slice(0, 5)) {
      lines.push(`      - ${h.name}：每 ${durText(h.interval)}（score ${h.score}）｜下次 ${tsText(h.next_due)}｜上轮新增 ${h.last_new}`)
    }
  }
  if (detail && (a.muted || []).length) {
    lines.push('  · 消息免打扰（不参与同步、游标不推进）：')
    for (const m of a.muted) lines.push(`      - ${m.name}`)
    if (n.muted > a.muted.length) lines.push(`      - …另有 ${n.muted - a.muted.length} 个`)
  }
  return lines
}

function syncStatusText(st, detail = true) {
  const accounts = st.accounts || []
  const c = st.config || {}
  const lines = [`微信动态同步：**${st.running ? '运行中' : '未运行'}**（${accounts.length} 个账号）`]
  if (accounts.length) {
    lines.push(line('· 调度参数：',
      `tick ${c.sync_tick_seconds}s / 扫描 ${c.sync_scan_seconds}s / 基准 ${durText(c.sync_base_interval)} / ` +
      `范围 ${durText(c.sync_min_interval)}–${durText(c.sync_max_interval)} / 半衰期 ${durText(c.sync_half_life)} / 单轮 ${c.sync_max_per_tick} 个`))
  }
  for (const a of accounts) {
    lines.push('')
    lines.push(...syncAccountText(a, detail))
  }
  if ((st.discovered || []).length > accounts.length) {
    lines.push('', line('· 本机发现但未纳入同步的账号：',
      (st.discovered || []).filter(x => !accounts.some(a => a.account === x)).join(', ')))
  }
  return lines.join('\n')
}

const wechatSync = {
  name: 'wechat_sync',
  description:
    '动态同步调度器（支持微信多开）：按每个会话的交互频次（收到消息 +1、自己发消息 +3，半衰期衰减）自动缩短/拉长微信增量同步间隔；无新消息时逐轮退避到上限；「消息免打扰」的群不参与同步且游标不推进（单聊不判断）。缺省同步本机全部账号目录（每个账号独立状态与单例锁），传 account 只作用于该账号。action=status 查看状态，start 启动后台常驻，stop 停止，once 立即执行一轮。触发场景：自动同步微信、调整同步频率、多开账号同步、查看同步调度状态、停止自动采集、立即同步一次。Keywords: wechat sync, scheduler, auto sync, interval, dynamic frequency, mute, multi account, 微信 自动同步 调度 频率 间隔 免打扰 多开',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'start', 'stop', 'once'],
        description: 'status（默认）= 查看；start = 启动后台调度；stop = 停止；once = 立即执行一轮（不常驻）',
      },
      account: { type: 'string', description: '只作用于该账号（xwechat_files 下的目录名）；缺省 = 全部账号' },
      python_exe: { type: 'string', description: '边车 Python 解释器路径' },
    },
  },
  output: textOutput,
  async run(args) {
    const action = args.action || 'status'
    const opts = { account: args.account, python_exe: args.python_exe }

    if (action === 'stop') {
      const r = stopScheduler(args.account)
      if (!r.stopped) {
        return `微信动态同步未停止：${r.reason || '未启动'}。`
      }
      const list = args.account ? [args.account] : (r.accounts || [])
      return [`微信动态同步已停止（${list.length} 个账号）。`, line('· 账号：', list.join(', ') || '—')].join('\n')
    }

    if (action === 'start') {
      const r = startScheduler({ ...opts, owner: 'mcp', force: true })
      if (!r.running) {
        return [
          `微信动态同步启动失败：${r.reason || '未知原因'}`,
          ...(r.accounts || []).filter(a => a.reason).map(a => `· ${a.account}：${a.reason}`),
          r.holder ? line('· 当前持有者：', `pid ${r.holder.pid}（${r.holder.owner || '?'}）`) : '',
          '提示：同一账号只允许一个调度器；先停止持有它的进程，或直接用它查看状态。',
        ].filter(Boolean).join('\n')
      }
      return syncStatusText(r.status(), false)
    }

    if (action === 'once') {
      const r = await syncOnce({ ...opts, owner: 'mcp' })
      const lines = [`微信动态同步：**${r.ok ? '已执行一轮' : '部分账号失败'}**`]
      for (const a of r.accounts || []) {
        if (!a.ok) {
          lines.push(`· ${a.account}：失败（${a.error || '未知原因'}）`)
          continue
        }
        const res = a.result || {}
        lines.push(line(`· ${a.account}：`,
          `${res.chats ?? 0} 个会话，新增 ${res.new ?? 0} 条（自己 ${res.self ?? 0} / 他人 ${res.in ?? 0}），写入 ${res.written ?? 0} 行`))
        if (res.skipped) lines.push(`    跳过：${res.reason}`)
      }
      lines.push('', syncStatusText(r.status, false))
      return lines.join('\n')
    }

    return syncStatusText(schedulerStatus(opts))
  },
}

const wechatConfig = {
  name: 'wechat_config',
  description:
    '读取或修改微信采集边车配置：数据落盘目录、每会话回溯条数、会话上限、采集白名单，以及动态同步参数（间隔上下限、tick、免打扰开关、手动排除会话）。不带 set 时只读。触发场景：配置微信采集、改数据目录、限定只采集某些会话、调整自动同步频率。Keywords: wechat config, settings, data dir, whitelist, sync interval, 微信 配置 同步 频率',
  parameters: {
    type: 'object',
    properties: {
      set: {
        type: 'object',
        description:
          '要写入的配置项（键：account / data_dir / limit_per_chat / max_chats / chats / skip_chats / content_max_chars / download_media / sync_enabled / sync_accounts / sync_tick_seconds / sync_scan_seconds / sync_base_interval / sync_min_interval / sync_max_interval / sync_half_life / sync_activity_window / sync_max_per_tick / sync_skip_muted / sync_include_service / muted_chats）',
      },
      python_exe: { type: 'string', description: '边车 Python 解释器路径' },
    },
  },
  output: textOutput,
  async run(args) {
    const res = await runSidecar(
      'config',
      { set: args.set && typeof args.set === 'object' ? args.set : undefined, account: args.account },
      { python_exe: args.python_exe, timeout_ms: 120000 },
    )
    if (res.ok !== true) return errorText('读取微信采集配置', res)

    const c = res.config || {}
    return [
      '微信采集配置：',
      line('· 读库账号：', c.account),
      line('· 数据目录：', c.data_dir),
      line('· 每会话回溯条数：', c.limit_per_chat),
      line('· 会话上限：', c.max_chats === 0 ? '0（全部）' : c.max_chats),
      line('· 采集白名单：', (c.chats || []).length ? c.chats.join(', ') : '（空 = 全部会话）'),
      line('· 跳过会话：', (c.skip_chats || []).length ? c.skip_chats.join(', ') : '（空）'),
      line('· 单条内容截断：', c.content_max_chars),
      '',
      '动态同步：',
      line('· 自动同步：', c.sync_enabled ? '开启' : '关闭'),
      line('· 同步账号：', (c.sync_accounts || []).length ? (c.sync_accounts || []).join(', ') : '自动发现本机全部账号目录'),
      line('· tick / 扫描：', `${c.sync_tick_seconds}s / ${c.sync_scan_seconds}s`),
      line('· 间隔基准：', `${durText(c.sync_base_interval)}（活跃度越高越短）`),
      line('· 间隔范围：', `${durText(c.sync_min_interval)} – ${durText(c.sync_max_interval)}`),
      line('· 活跃度半衰期：', durText(c.sync_half_life)),
      line('· 活跃度统计窗口：', `最近 ${durText(c.sync_activity_window)} 的消息`),
      line('· 单轮上限：', `${c.sync_max_per_tick} 个会话`),
      line('· 跳过免打扰群：', c.sync_skip_muted ? '是（游标不推进）' : '否'),
      line('· 包含公众号：', c.sync_include_service ? '是' : '否'),
      line('· 手动排除：', (c.muted_chats || []).length ? c.muted_chats.join(', ') : '（空）'),
      line('· 配置文件：', res.config_path),
      '（sync_* 参数在调度器下一轮 tick 生效；改 account 需重新启动调度器）',
    ].join('\n')
  },
}

/** 动态同步调度器的默认参数（供宿主 / 文档复用）。 */
export const syncDefaults = SYNC_DEFAULTS

/** 供 dsh 宿主启动后台调度器。 */
export function startSyncScheduler(opts) {
  return startScheduler(opts)
}

/** 工具清单（两平面共用的唯一契约）。 */
export const tools = [wechatStatus, wechatSessions, wechatNew, wechatFetch, wechatBackfill, wechatSend, wechatSync, wechatConfig]
