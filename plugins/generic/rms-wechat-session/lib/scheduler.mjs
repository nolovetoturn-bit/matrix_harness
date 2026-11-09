/**
 * 动态同步调度器（零依赖，仅 node: 内置模块）。
 *
 * 目标：按「每个会话的交互频次」自动调整微信增量同步的时间间隔。
 *
 *   · 活跃度分数 score：EWMA，收到消息 +1、自己发消息 +3，半衰期可配（默认 3h）；
 *   · 间隔 interval = clamp(base / (1 + score), min, max)；
 *     无新消息的轮次再乘 1.2 做空闲退避，最终收敛到 max；
 *   · 每个会话独立 next_due，tick 只同步到期的会话，单次上限 max_per_tick；
 *   · 「消息免打扰」的群直接排除：不扫、不推进游标（解禁后从旧游标继续补）；
 *   · 单聊不判断免打扰（contact.chat_room_notify 对单聊恒为 0，不具语义）。
 *
 * 单例：`<data_dir>/<account>/sync.lock` 记录 pid + heartbeat，dsh 与 MCP 两个平面
 * 同时加载时只有一个真正运行，避免重复 spawn 边车。
 *
 * 状态：`<data_dir>/<account>/sync_state.json`（原子写），可随时重建。
 *
 * @module rms-wechat-session/scheduler
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PYTHON, runSidecar } from './sidecar.mjs'

const DEFAULT_ACCOUNT = 'BurstM_792c'
const APP_NAME = 'rms-wechat-session'
const STATE_FILE = 'sync_state.json'
const LOCK_FILE = 'sync.lock'

/** 调度参数默认值；与边车 DEFAULTS 保持一致（边车负责持久化）。 */
export const SYNC_DEFAULTS = {
  sync_enabled: true,
  sync_tick_seconds: 60,
  sync_scan_seconds: 300,
  sync_base_interval: 3600,
  sync_min_interval: 120,
  sync_max_interval: 7200,
  sync_half_life: 10800,
  sync_activity_window: 3600,
  sync_max_per_tick: 20,
  sync_skip_muted: true,
  sync_include_service: false,
  muted_chats: [],
  limit_per_chat: 200,
  skip_chats: [],
  sync_accounts: [],
}

/** 首次纳入调度的会话，把 next_due 打散在这一段时间内（秒），避免一次性全量拉取。 */
const INITIAL_SPREAD_SECONDS = 600

/* ------------------------------------------------------------------ */
/* 路径与配置                                                          */
/* ------------------------------------------------------------------ */

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi)
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 解析应用目录、配置与账号数据目录。 */
export function appPaths(account) {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const appDir = join(local, APP_NAME)
  const configPath = join(appDir, 'config.json')
  let cfg = {}
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8')) || {}
  } catch {
    cfg = {}
  }
  const acct = account || cfg.account || DEFAULT_ACCOUNT
  const dataDir = cfg.data_dir || join(appDir, 'data')
  const accountDir = join(dataDir, acct)
  return { appDir, configPath, cfg, account: acct, dataDir, accountDir }
}

/** 合并同步参数（配置缺项用默认值补齐）。 */
function syncConfig(paths) {
  const raw = paths.cfg || {}
  const cfg = { ...SYNC_DEFAULTS }
  for (const key of Object.keys(SYNC_DEFAULTS)) {
    if (raw[key] !== undefined && raw[key] !== null) cfg[key] = raw[key]
  }
  cfg.sync_tick_seconds = Math.max(15, num(cfg.sync_tick_seconds, 60))
  cfg.sync_scan_seconds = Math.max(cfg.sync_tick_seconds, num(cfg.sync_scan_seconds, 300))
  cfg.sync_min_interval = Math.max(30, num(cfg.sync_min_interval, 120))
  cfg.sync_base_interval = Math.max(cfg.sync_min_interval, num(cfg.sync_base_interval, 3600))
  cfg.sync_max_interval = Math.max(cfg.sync_base_interval, num(cfg.sync_max_interval, 7200))
  cfg.sync_half_life = Math.max(600, num(cfg.sync_half_life, 10800))
  cfg.sync_activity_window = Math.max(60, num(cfg.sync_activity_window, 3600))
  cfg.sync_max_per_tick = Math.max(1, num(cfg.sync_max_per_tick, 20))
  cfg.limit_per_chat = Math.max(1, num(cfg.limit_per_chat, 200))
  cfg.sync_enabled = cfg.sync_enabled !== false
  cfg.sync_skip_muted = cfg.sync_skip_muted !== false
  cfg.sync_include_service = cfg.sync_include_service === true
  cfg.muted_chats = Array.isArray(cfg.muted_chats) ? cfg.muted_chats : []
  cfg.skip_chats = Array.isArray(cfg.skip_chats) ? cfg.skip_chats : []
  cfg.sync_accounts = Array.isArray(cfg.sync_accounts) ? cfg.sync_accounts.filter(Boolean) : []
  return cfg
}

/* ------------------------------------------------------------------ */
/* 多账号：发现与选择                                                  */
/* ------------------------------------------------------------------ */

/** 微信账号目录可能所在的根目录（4.x 用 xwechat_files，旧版为 WeChat Files）。 */
function accountRoots() {
  const home = homedir()
  return [
    join(home, 'Documents', 'xwechat_files'),
    join(home, 'Documents', 'WeChat Files'),
  ]
}

/**
 * 发现本机全部「有本地库」的微信账号目录名（= `<xwechat_files>\<account>`）。
 * 只认含 `db_storage` 的目录，避免把日志/备份目录误当账号。
 */
export function discoverAccounts() {
  const found = []
  for (const root of accountRoots()) {
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(root, entry.name, 'db_storage'))) found.push(entry.name)
    }
  }
  return [...new Set(found)]
}

/**
 * 决定本次要同步哪些账号。
 *   1. opts.account 显式指定 → 只同步它；
 *   2. 配置 `sync_accounts` 非空 → 按列表；
 *   3. 否则自动发现本机账号（优先取已有密钥缓存的，其次全部），并确保默认账号在内。
 */
export function resolveAccounts(opts = {}, cfg = null) {
  if (opts.account) return [opts.account]
  if (Array.isArray(opts.accounts) && opts.accounts.length) return [...new Set(opts.accounts)]
  const conf = cfg || appPaths().cfg || {}
  const listed = Array.isArray(conf.sync_accounts) ? conf.sync_accounts.filter(Boolean) : []
  if (listed.length) return [...new Set(listed)]

  const def = conf.account || DEFAULT_ACCOUNT
  const found = discoverAccounts()
  if (!found.length) return [def]

  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const keysDir = process.env.WECHATAUTO_KEYS_DIR || join(local, 'wechatauto_keys')
  const withKey = found.filter(a => existsSync(join(keysDir, `${a}.json`)))
  const chosen = withKey.length ? withKey : found
  return chosen.includes(def) ? chosen : [def, ...chosen]
}

/* ------------------------------------------------------------------ */
/* 状态文件                                                            */
/* ------------------------------------------------------------------ */

function emptyState(account) {
  return {
    version: 1,
    account,
    updated_at: '',
    last_scan: 0,
    last_fetch: 0,
    last_error: '',
    last_result: null,
    muted: [],
    scan_info: null,
    chats: {},
  }
}

function statePath(paths) {
  return join(paths.accountDir, STATE_FILE)
}

function loadState(paths) {
  try {
    const st = JSON.parse(readFileSync(statePath(paths), 'utf8'))
    if (!st || typeof st !== 'object') return emptyState(paths.account)
    st.chats = st.chats && typeof st.chats === 'object' ? st.chats : {}
    return { ...emptyState(paths.account), ...st }
  } catch {
    return emptyState(paths.account)
  }
}

function saveState(paths, state) {
  mkdirSync(paths.accountDir, { recursive: true })
  state.updated_at = new Date().toISOString()
  const file = statePath(paths)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}

/* ------------------------------------------------------------------ */
/* 单例锁                                                              */
/* ------------------------------------------------------------------ */

function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

function lockPath(paths) {
  return join(paths.accountDir, LOCK_FILE)
}

function readLock(paths) {
  try {
    return JSON.parse(readFileSync(lockPath(paths), 'utf8'))
  } catch {
    return null
  }
}

function acquireLock(paths, owner, tickSeconds) {
  mkdirSync(paths.accountDir, { recursive: true })
  const cur = readLock(paths)
  const now = nowSec()
  const staleAfter = Math.max(tickSeconds * 3, 180)
  if (
    cur &&
    cur.pid !== process.pid &&
    processAlive(cur.pid) &&
    now - num(cur.heartbeat, 0) < staleAfter
  ) {
    return { ok: false, holder: cur }
  }
  writeFileSync(
    lockPath(paths),
    JSON.stringify({ pid: process.pid, owner, started_at: now, heartbeat: now }, null, 2),
    'utf8',
  )
  return { ok: true, previous: cur }
}

function heartbeatLock(paths, owner, startedAt) {
  try {
    writeFileSync(
      lockPath(paths),
      JSON.stringify({ pid: process.pid, owner, started_at: startedAt, heartbeat: nowSec() }, null, 2),
      'utf8',
    )
  } catch {
    /* 心跳写失败不阻塞同步 */
  }
}

function releaseLock(paths) {
  const cur = readLock(paths)
  if (!cur || cur.pid !== process.pid) return
  try {
    unlinkSync(lockPath(paths))
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ */
/* 活跃度与间隔                                                        */
/* ------------------------------------------------------------------ */

function decayedScore(chat, cfg, now) {
  const elapsed = Math.max(0, now - num(chat.last_fetch, now))
  const factor = Math.pow(0.5, elapsed / cfg.sync_half_life)
  return Math.max(0, num(chat.score, 0) * factor)
}

function targetInterval(score, cfg) {
  const v = cfg.sync_base_interval / (1 + Math.max(0, score))
  return clamp(v, cfg.sync_min_interval, cfg.sync_max_interval)
}

function jitter(seconds) {
  return Math.max(30, Math.round(seconds * (0.9 + Math.random() * 0.2)))
}

/**
 * 把一次同步结果折算成活跃度，并算出下一次到期时间。
 * @param {object} chat 状态里的会话记录
 * @param {object} cfg 同步配置
 * @param {{new?: number, self_new?: number, in_new?: number}} result 本轮结果
 * @param {number} now 当前秒
 */
function applySyncResult(chat, cfg, result, now) {
  chat.score = decayedScore(chat, cfg, now)
  chat.self_new = Math.max(0, num(result.self_new, 0))
  chat.in_new = Math.max(0, num(result.in_new, 0))
  chat.last_new = Math.max(0, num(result.new, 0))
  chat.last_fetch = now
  chat.score += chat.self_new * 3 + chat.in_new * 1

  const target = targetInterval(chat.score, cfg)
  if (chat.last_new === 0) {
    // 空闲退避：连续没有新消息时逐步拉长间隔，最多到 max。
    chat.empty_rounds = num(chat.empty_rounds, 0) + 1
    chat.interval = clamp(Math.max(target, num(chat.interval, cfg.sync_base_interval) * 1.2),
      cfg.sync_min_interval, cfg.sync_max_interval)
  } else {
    chat.empty_rounds = 0
    chat.interval = target
  }
  chat.next_due = now + jitter(chat.interval)
}

function backoff(chat, cfg, now, factor = 2) {
  chat.interval = clamp(num(chat.interval, cfg.sync_base_interval) * factor,
    cfg.sync_min_interval, cfg.sync_max_interval)
  chat.next_due = now + jitter(chat.interval)
}

/* ------------------------------------------------------------------ */
/* 扫描与同步                                                          */
/* ------------------------------------------------------------------ */

async function scanChats(ctx, force) {
  const { cfg, paths, state, opts } = ctx
  const now = nowSec()
  if (!force && now - num(state.last_scan, 0) < cfg.sync_scan_seconds) return
  const res = await runSidecar(
    'sync_scan',
    {
      account: paths.account,
      skip_chats: cfg.skip_chats,
      muted_chats: cfg.muted_chats,
      include_muted: !cfg.sync_skip_muted,
      include_service: cfg.sync_include_service,
    },
    { python_exe: opts.python_exe, timeout_ms: 180000 },
  )
  if (res.ok !== true) {
    ctx.last_error = `扫描会话失败：${res.error || '未知错误'}`
    return
  }

  state.last_scan = now
  for (const chat of Object.values(state.chats)) chat.active = false
  for (const row of res.chats || []) {
    let chat = state.chats[row.username]
    if (!chat) {
      chat = state.chats[row.username] = {
        name: row.name || row.username,
        score: 0,
        interval: cfg.sync_base_interval,
        next_due: now + Math.floor(Math.random() * Math.min(cfg.sync_base_interval, INITIAL_SPREAD_SECONDS)),
        last_fetch: 0,
        last_new: 0,
        self_new: 0,
        in_new: 0,
        empty_rounds: 0,
        active: true,
        muted: false,
      }
    }
    chat.name = row.name || row.username
    chat.username = row.username
    chat.active = true
    chat.muted = row.muted === true
    if (!chat.interval) chat.interval = cfg.sync_base_interval
    if (!chat.next_due) chat.next_due = now
  }
  state.muted = (res.muted || []).map(m => ({ username: m.username, name: m.name }))
  state.scan_info = {
    chats_total: res.chats_total,
    eligible: (res.chats || []).length,
    muted_count: res.muted_count,
    skipped_service: res.skipped_service,
  }
}

async function fetchDue(ctx, force = false) {
  const { cfg, paths, state, opts } = ctx
  const now = nowSec()
  const candidates = Object.entries(state.chats)
    .filter(([, chat]) => chat.active !== false && chat.muted !== true)
    .sort((a, b) => num(a[1].next_due, 0) - num(b[1].next_due, 0))
  // 手动 once：按「最久未同步」取一批，不等 next_due 到期。
  const due = (force ? candidates : candidates.filter(([, chat]) => num(chat.next_due, 0) <= now))
    .slice(0, cfg.sync_max_per_tick)
  if (!due.length) return { chats: 0, new: 0 }

  const res = await runSidecar(
    'fetch',
    {
      account: paths.account,
      chats: due.map(([username]) => username),
      limit_per_chat: cfg.limit_per_chat,
      skip_chats: cfg.skip_chats,
      activity_since: now - cfg.sync_activity_window,
    },
    { python_exe: opts.python_exe, timeout_ms: 600000 },
  )
  const doneAt = nowSec()

  if (res.ok !== true) {
    ctx.last_error = `同步会话失败：${res.error || '未知错误'}`
    for (const [, chat] of due) backoff(chat, cfg, doneAt)
    return { chats: due.length, new: 0, error: res.error }
  }

  const per = new Map()
  for (const row of res.per_chat || []) {
    if (row.username) per.set(row.username, row)
  }

  let totalNew = 0
  let totalSelf = 0
  let totalIn = 0
  for (const [username, chat] of due) {
    const row = per.get(username)
    if (!row || row.error) {
      backoff(chat, cfg, doneAt)
      continue
    }
    applySyncResult(chat, cfg, row, doneAt)
    totalNew += num(row.new, 0)
    totalSelf += num(row.self_new, 0)
    totalIn += num(row.in_new, 0)
  }

  state.last_fetch = doneAt
  state.last_result = {
    at: doneAt,
    chats: due.length,
    new: totalNew,
    self: totalSelf,
    in: totalIn,
    written: num(res.written, 0),
    output_file: res.output_file || '',
  }
  ctx.last_error = ''
  return state.last_result
}

async function cycle(ctx, trigger) {
  if (ctx.busy) return { skipped: true, reason: '上一轮尚未结束' }
  ctx.busy = true
  const started = nowSec()
  try {
    if (ctx.lockHeld) heartbeatLock(ctx.paths, ctx.owner, ctx.startedAt)
    // 每轮重新读配置：改 sync_* 参数无需重启调度器即可生效。
    const configured = appPaths()
    const allowed = resolveAccounts(ctx.opts, configured.cfg)
    if (!allowed.includes(ctx.paths.account)) {
      ctx.last_error = `账号 ${ctx.paths.account} 已不在同步账号列表中，该账号调度已停止；请重新启动`
      stopAccount(ctx.paths.account)
      return { error: ctx.last_error }
    }
    ctx.cfg = syncConfig(configured)
    if (!ctx.cfg.sync_enabled && trigger === 'timer') {
      ctx.last_error = 'sync_enabled=false，调度器已停止'
      stopScheduler()
      return { stopped: true }
    }
    await scanChats(ctx, trigger === 'manual' || trigger === 'start')
    const result = await fetchDue(ctx, trigger === 'manual')
    ctx.state.last_error = ctx.last_error || ''
    saveState(ctx.paths, ctx.state)
    ctx.lastCycle = { trigger, at: started, result }
    return result
  } catch (err) {
    ctx.last_error = `${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : err}`
    try {
      ctx.state.last_error = ctx.last_error
      saveState(ctx.paths, ctx.state)
    } catch {
      /* noop */
    }
    return { error: ctx.last_error }
  } finally {
    ctx.busy = false
  }
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 运行中的调度管理器：一个进程内按账号维护多个 ctx，共用一个 timer。 */
let manager = null

/** 两个账号集合是否一致（顺序无关）。 */
function sameAccounts(running, targets) {
  if (running.length !== targets.length) return false
  const set = new Set(running)
  return targets.every(a => set.has(a))
}

/**
 * 启动后台调度器（幂等，支持微信多开）。
 *
 * 账号来源优先级：`opts.account` > 配置 `sync_accounts` > 自动发现本机账号目录。
 * 每个账号有独立的状态文件与单例锁；dsh 与 MCP 两个平面同时加载时，同一账号只会有一个真正运行。
 *
 * @param {{account?: string, accounts?: string[], owner?: string, python_exe?: string, force?: boolean}} [opts]
 */
export function startScheduler(opts = {}) {
  const configured = appPaths(opts.account)
  const cfg = syncConfig(configured)
  const targets = resolveAccounts(opts, configured.cfg)
  if (!opts.force && !cfg.sync_enabled) {
    return {
      running: false,
      reason: 'sync_enabled=false',
      accounts: targets.map(account => ({ account, running: false, reason: 'sync_enabled=false' })),
      config: cfg,
    }
  }

  if (manager && manager.running) {
    if (sameAccounts([...manager.accounts.keys()], targets)) return controller(manager)
    stopScheduler()
  }

  const m = {
    accounts: new Map(),
    opts: { ...opts },
    owner: opts.owner || 'dsh',
    running: true,
    busy: false,
    startedAt: nowSec(),
    last_error: '',
    lastCycle: null,
    timer: null,
  }
  for (const account of targets) startAccount(m, account)
  manager = m

  if (!m.accounts.size) {
    manager = null
    const paths = appPaths(targets[0] || configured.account)
    const lock = readLock(paths)
    return {
      running: false,
      reason: lock
        ? `已有调度器在运行（pid ${lock.pid}，owner ${lock.owner || '?'}）`
        : '没有可同步的账号',
      holder: lock,
      accounts: targets.map(account => ({ account, running: false })),
      config: cfg,
    }
  }

  const first = [...m.accounts.keys()][0]
  const tickMs = syncConfig(appPaths(first)).sync_tick_seconds * 1000
  m.timer = setInterval(() => {
    void tick(m)
  }, tickMs)
  if (typeof m.timer.unref === 'function') m.timer.unref()

  // 启动时延后一拍，避免拖慢宿主启动。
  const kick = setTimeout(() => {
    void tick(m, 'start')
  }, 3000)
  if (typeof kick.unref === 'function') kick.unref()

  return controller(m)
}

/** 为单个账号建立调度上下文；拿锁失败则跳过，不影响其他账号。 */
function startAccount(m, account) {
  const paths = appPaths(account)
  const cfg = syncConfig(paths)
  const lock = acquireLock(paths, m.owner, cfg.sync_tick_seconds)
  if (!lock.ok) return null
  const ctx = {
    paths,
    cfg,
    opts: m.opts,
    owner: m.owner,
    state: loadState(paths),
    busy: false,
    running: true,
    lockHeld: true,
    startedAt: nowSec(),
    last_error: '',
    lastCycle: null,
  }
  m.accounts.set(account, ctx)
  return ctx
}

/**
 * 一轮 tick：先按当前配置对齐账号集合（新登录的账号自动纳入、被移除的停止），
 * 再逐个账号同步。账号之间串行，避免多个边车同时抢读同一个微信库。
 */
async function tick(m, trigger = 'timer') {
  if (m.busy) return { skipped: true, reason: '上一轮尚未结束' }
  m.busy = true
  try {
    const targets = resolveAccounts(m.opts)
    for (const account of [...m.accounts.keys()]) {
      if (!targets.includes(account)) stopAccount(account)
    }
    for (const account of targets) {
      if (!m.accounts.has(account)) startAccount(m, account)
    }
    const results = []
    for (const ctx of m.accounts.values()) {
      if (!ctx.running) continue
      results.push({ account: ctx.paths.account, result: await cycle(ctx, trigger) })
    }
    return { accounts: results }
  } finally {
    m.busy = false
  }
}

function controller(m) {
  const accounts = [...m.accounts.keys()]
  const first = [...m.accounts.values()][0]
  return {
    running: m.running && m.accounts.size > 0,
    account: accounts.length === 1 ? accounts[0] : null,
    accounts,
    config: first ? first.cfg : {},
    status: account => schedulerStatus({ account }),
    runOnce: account => {
      const ctx = account ? m.accounts.get(account) : null
      if (ctx) return cycle(ctx, 'manual')
      if (account) return syncOnce({ ...m.opts, account })
      return tick(m, 'manual')
    },
    noteActivity: (nameOrUsername, weight, account) => noteActivity(nameOrUsername, weight, account),
    stop: account => stopScheduler(account),
  }
}

/** 停止单个账号的调度器并释放它的锁。 */
function stopAccount(account) {
  if (!manager) return { stopped: false, account }
  const ctx = manager.accounts.get(account)
  if (!ctx) return { stopped: false, account }
  ctx.running = false
  try {
    saveState(ctx.paths, ctx.state)
  } catch {
    /* noop */
  }
  if (ctx.lockHeld) releaseLock(ctx.paths)
  manager.accounts.delete(account)
  return { stopped: true, account }
}

/**
 * 停止调度器并释放单例锁。
 * @param {string} [account] 只停这个账号；缺省 = 全部停止。
 */
export function stopScheduler(account) {
  if (!manager) return { running: false, stopped: false, reason: '未启动' }
  const m = manager
  if (account) return stopAccount(account)
  const accounts = [...m.accounts.keys()]
  for (const name of accounts) stopAccount(name)
  m.running = false
  if (m.timer) clearInterval(m.timer)
  manager = null
  return { running: false, stopped: true, accounts }
}

/** 读取状态（不启动调度器）。多账号时 accounts 是每个账号的明细。 */
export function schedulerStatus(opts = {}) {
  const configured = appPaths(opts.account)
  const cfg = syncConfig(configured)
  const targets =
    manager && manager.running && !opts.account
      ? [...manager.accounts.keys()]
      : resolveAccounts(opts, configured.cfg)
  const accounts = targets.map(account => {
    const ctx = manager && manager.accounts.get(account)
    if (ctx) return describe(ctx)
    const paths = appPaths(account)
    const state = loadState(paths)
    const lock = readLock(paths)
    return describe({
      paths,
      cfg: syncConfig(paths),
      state,
      running: false,
      lock,
      holderAlive: !!(lock && processAlive(lock.pid)),
      last_error: state.last_error || '',
    })
  })
  return {
    running: accounts.some(a => a.running),
    accounts,
    config: cfg,
    sync_accounts: targets,
    discovered: discoverAccounts(),
  }
}

function describe(ctx) {
  const { paths, cfg, state } = ctx
  const now = nowSec()
  const lock = ctx.lock !== undefined ? ctx.lock : readLock(paths)
  const holderAlive = ctx.holderAlive !== undefined ? ctx.holderAlive : !!(lock && processAlive(lock.pid))
  const chats = Object.values(state.chats || {})
  const active = chats.filter(c => c.active !== false && c.muted !== true)
  const due = active.filter(c => num(c.next_due, 0) <= now)
  const hot = [...active]
    .sort((a, b) => num(a.interval, 0) - num(b.interval, 0))
    .slice(0, 10)
    .map(c => ({
      username: c.username,
      name: c.name,
      interval: num(c.interval, 0),
      score: Number(num(c.score, 0).toFixed(2)),
      next_due: num(c.next_due, 0),
      last_new: num(c.last_new, 0),
    }))
  return {
    running: ctx.running === true,
    account: paths.account,
    state_file: statePath(paths),
    lock_file: lockPath(paths),
    lock,
    lock_holder_alive: holderAlive,
    config: cfg,
    last_scan: num(state.last_scan, 0),
    last_fetch: num(state.last_fetch, 0),
    updated_at: state.updated_at || '',
    last_error: ctx.last_error || '',
    last_result: state.last_result || null,
    scan_info: state.scan_info || null,
    counts: {
      tracked: chats.length,
      active: active.length,
      muted: (state.muted || []).length,
      due: due.length,
    },
    hot,
    muted: (state.muted || []).slice(0, 20),
  }
}

/** 手动执行一轮（不常驻）：逐账号拿锁 → 扫描 → 同步到期会话 → 放锁。 */
export async function syncOnce(opts = {}) {
  const targets =
    manager && manager.running && !opts.account
      ? [...manager.accounts.keys()]
      : resolveAccounts(opts)
  const results = []
  for (const account of targets) {
    const running = manager && manager.accounts.get(account)
    if (running) {
      results.push({ account, ok: true, running: true, result: await cycle(running, 'manual') })
      continue
    }
    results.push(await onceAccount({ ...opts, account }))
  }
  return {
    ok: results.every(r => r.ok),
    accounts: results,
    status: schedulerStatus(opts),
  }
}

/** 单账号的一次性执行（无常驻调度器时使用）。 */
async function onceAccount(opts) {
  const paths = appPaths(opts.account)
  const cfg = syncConfig(paths)
  const lock = acquireLock(paths, opts.owner || 'once', cfg.sync_tick_seconds)
  if (!lock.ok) {
    return {
      account: paths.account,
      ok: false,
      running: false,
      error: `已有调度器在运行（pid ${(lock.holder || {}).pid}）`,
      holder: lock.holder,
    }
  }
  const ctx = {
    paths,
    cfg,
    opts,
    owner: opts.owner || 'once',
    state: loadState(paths),
    busy: false,
    running: false,
    lockHeld: true,
    startedAt: nowSec(),
    last_error: '',
    lastCycle: null,
  }
  try {
    const result = await cycle(ctx, 'manual')
    return { account: paths.account, ok: !ctx.last_error, result, status: describe(ctx) }
  } finally {
    releaseLock(paths)
  }
}

/**
 * 记录一次手动交互（发消息 / 主动采集），让该会话更早被同步。
 * @param {string} nameOrUsername 会话 username 或名称
 * @param {number} [weight] 活跃度增量（自己发消息默认 5）
 * @param {string} [account] 只作用于该账号；缺省 = 全部运行中的账号
 */
export function noteActivity(nameOrUsername, weight = 5, account) {
  if (!nameOrUsername) return { updated: 0, accounts: [] }
  const targets = account
    ? [account]
    : manager && manager.running
      ? [...manager.accounts.keys()]
      : resolveAccounts({})
  let updated = 0
  for (const name of targets) {
    const paths = appPaths(name)
    const cfg = syncConfig(paths)
    const ctx = manager && manager.accounts.get(name)
    const state = ctx ? ctx.state : loadState(paths)
    const r = noteInState(state, cfg, nameOrUsername, weight)
    updated += r.updated
    if (!ctx && r.updated) {
      try {
        saveState(paths, state)
      } catch {
        /* noop */
      }
    }
  }
  return { updated, weight: num(weight, 5), accounts: targets }
}

function noteInState(state, cfg, nameOrUsername, weight) {
  const key = String(nameOrUsername || '').trim()
  if (!key) return { updated: 0 }
  const now = nowSec()
  let updated = 0
  for (const [username, chat] of Object.entries(state.chats || {})) {
    if (username !== key && chat.name !== key) continue
    chat.score = decayedScore(chat, cfg, now) + Math.max(0, num(weight, 5))
    chat.interval = targetInterval(chat.score, cfg)
    chat.next_due = now + jitter(chat.interval)
    updated += 1
  }
  return { updated, weight: num(weight, 5) }
}

/** 供工具侧渲染：默认边车解释器。 */
export { DEFAULT_PYTHON }
