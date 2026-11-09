/**
 * rms-front-service — 可移植清单 + 零依赖实现。契约见 docs/dsh-plugin-spec.md §3。
 *
 * 作用：在本地「完整启动」rms-front（Spring Boot + Thymeleaf 前后端一体工程）：
 *   ① frontend-ui 的 Vite dev server（5174，前端源码与 HMR 资产源）
 *   ② 后端 RmsApplication（80，页面与 /rms API 由后端渲染/服务）
 * 只有两者同时起来，http://rms.dev.huizhi-intl.com/rms/ui/#/dashboard 才能渲染出真实页面。
 *
 * 只允许 node: 内置导入。进程不用 detached 拉起（detached 会让输出全部丢失，见 spawnService 注释）；
 * 代价是包装用的 cmd.exe 会随 MCP server 退出而结束，故 stop/status 额外按端口兜底，见 portOwners。
 *
 * @module rms-front-service
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 插件标识，kebab-case，与目录名一致。 */
export const id = 'rms-front-service'

/** 插件类别。 */
export const kind = 'project'

/** 一句话说明。 */
export const description =
  '完整启动 rms-front（Spring Boot + Thymeleaf 前后端一体工程）的本地服务，并管理其状态、日志与停止。'

/* ------------------------------------------------------------------ */
/* 运行时常量                                                          */
/* ------------------------------------------------------------------ */

const STATE_DIR = join(tmpdir(), 'rms-front-service')
const STATE_FILE = join(STATE_DIR, 'state.json')
const LOG_FILE = { backend: join(STATE_DIR, 'backend.log'), frontend: join(STATE_DIR, 'frontend.log') }

/** 本机默认值（均可在入参覆盖）。 */
const DEFAULT_PROJECT_ROOT = 'C:/Users/admin/IdeaProjects/rms-front'
const DEFAULT_FRONTEND_DIR = 'frontend-ui'
/** 项目 pom 指定 java.version=11，必须用 JDK11 启动，否则 Spring Boot 2.5 可能起不来。 */
const DEFAULT_JAVA_HOME = 'C:/Users/admin/.jdks/ms-11.0.29'

const BACKEND_PORT = 80
const FRONTEND_PORT = 5174
const BACKEND_PROBE_PATH = '/rms/ui/'
/** 后端启动参数（AGENTS.md「本地启动与验证方法」指定，缺一会连错环境或启动失败）。 */
const SPRING_CONFIG_ARG =
  '--spring.config.location=classpath:base-config.yml,classpath:application-dev.yml'

/** 补齐 PATH 的已知目录，避免 MCP server 的宿主环境里 mvn/npm/java 不在 PATH。 */
const EXTRA_PATH_DIRS = [
  'C:/Program Files/nodejs',
  'C:/ProgramData/chocolatey/lib/maven/apache-maven-3.9.12/bin',
]

/* ------------------------------------------------------------------ */
/* 状态读写                                                            */
/* ------------------------------------------------------------------ */

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeState(state) {
  ensureStateDir()
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

/** 进程是否存活（EPERM=存在但无权限发信号，同样算存活）。 */
function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/* ------------------------------------------------------------------ */
/* 探活                                                                */
/* ------------------------------------------------------------------ */

function portOpen(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = ok => {
      try {
        socket.destroy()
      } catch {
        /* noop */
      }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function httpProbe(path, port) {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: 4000 }, res => {
      res.resume()
      resolve({ status: res.statusCode })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ error: 'timeout' })
    })
    req.on('error', err => resolve({ error: err.code || err.message }))
    req.end()
  })
}

/* ------------------------------------------------------------------ */
/* 日志读取                                                            */
/* ------------------------------------------------------------------ */

/** Maven/Java 在中文 Windows 上可能输出 GBK；先按 UTF-8 严格解码，失败再退 GBK。 */
function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

function readTail(file, maxLines, filter) {
  if (!existsSync(file)) return null
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return null
  }
  const CAP = 512 * 1024
  const start = Math.max(0, size - CAP)
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return null
  }
  buf = start > 0 ? buf.subarray(start) : buf
  let lines = decodeText(buf).split(/\r?\n/)
  if (start > 0) lines = lines.slice(1) // 丢弃可能被截断的首行
  if (filter) lines = lines.filter(line => line.includes(filter))
  if (lines.length > maxLines) lines = lines.slice(-maxLines)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 进程拉起与结束                                                      */
/* ------------------------------------------------------------------ */

function buildEnv(javaHome) {
  const env = { ...process.env }
  const dirs = [...EXTRA_PATH_DIRS]
  if (javaHome) dirs.unshift(`${javaHome}/bin`)
  const avail = dirs.filter(dir => existsSync(dir))
  if (avail.length) {
    const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path'
    env[key] = `${avail.join(';')};${env[key] || ''}`
  }
  if (javaHome) env.JAVA_HOME = javaHome
  return env
}

/**
 * 拉起一个服务进程，stdout/stderr 直接落盘。
 *
 * 两个 Windows 实测坑（都已验证，勿回退）：
 *  1. 不要用 `shell:true`：Node 已弃用该组合，且这里改为显式 `cmd.exe /d /s /c "<命令行>"` + shell:false，
 *     既能解析 mvn/npm 这类 .cmd（Node 禁止 shell:false 直接 spawn .cmd），又避免了参数拼接。
 *  2. `detached` 必须为 false：实测 `detached:true`（无论 windowsHide、无论 fd 还是 `>` 重定向）
 *     都会让 node/mvn 这类**外部程序**的输出全部丢失（cmd 内建命令除外），日志恒为 0 字节。
 *     子进程在父进程（MCP server）退出后依然存活，故无需 detached。
 */
function spawnService({ cmdline, cwd, env, logFile }) {
  ensureStateDir()
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdline], {
      cwd,
      env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    return { pid: child.pid, logFile }
  } finally {
    closeSync(fd)
  }
}

/**
 * 查端口的 LISTENING 持有者 PID，返回 Map<"端口", Set<pid>>。
 *
 * 为什么需要：本插件用 `detached:false` 拉起（detached 会丢日志，见 spawnService），
 * 包装用的 cmd.exe 会随 MCP server 退出而一并被结束，但它启动的 java/vite 仍存活，
 * 于是 state.json 里记录的 PID 失效而端口仍被占用 —— stop/start 必须能按端口兜底释放。
 */
function portOwners(ports) {
  const wanted = new Set(ports.map(String))
  const found = new Map()
  const res = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  for (const line of `${res.stdout || ''}`.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue
    const local = parts[1] || ''
    const port = local.slice(local.lastIndexOf(':') + 1)
    const pid = Number(parts[4])
    if (!wanted.has(port) || !pid) continue
    if (!found.has(port)) found.set(port, new Set())
    found.get(port).add(pid)
  }
  return found
}

/** 结束占用这些端口的进程树，返回 [{ port, pid, ok }]。 */
function killPortOwners(ports, skipPids = new Set()) {
  const killed = []
  for (const [port, pids] of portOwners(ports)) {
    for (const pid of pids) {
      if (skipPids.has(pid)) continue
      const res = killTree(pid)
      killed.push({ port, pid, ok: res.ok })
    }
  }
  return killed
}

/** 结束整棵进程树（Windows 用 taskkill /T）。 */
function killTree(pid) {
  if (!pid) return { ok: false, out: 'no pid' }
  const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim()
  return { ok: res.status === 0, out }
}

/* ------------------------------------------------------------------ */
/* 工具公共部分                                                        */
/* ------------------------------------------------------------------ */

function resolveConfig(args = {}) {
  const projectRoot = (args.project_root || DEFAULT_PROJECT_ROOT).replace(/\\/g, '/')
  const frontendDir = (args.frontend_dir || DEFAULT_FRONTEND_DIR).replace(/\\/g, '/')
  const javaHome = (args.java_home || DEFAULT_JAVA_HOME).replace(/\\/g, '/')
  return { projectRoot, frontendDir, javaHome, frontendPath: `${projectRoot}/${frontendDir}` }
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

async function startService(args = {}) {
  const { projectRoot, javaHome, frontendPath } = resolveConfig(args)
  const state = readState()
  const lines = []

  const running = {
    backend: isAlive(state.backend && state.backend.pid),
    frontend: isAlive(state.frontend && state.frontend.pid),
  }

  if ((running.backend || running.frontend) && !args.force) {
    return [
      'rms-front 已有存活实例，未重复启动（需要重启请传 force: true）。',
      `backend  pid=${state.backend?.pid || '-'} alive=${running.backend}`,
      `frontend pid=${state.frontend?.pid || '-'} alive=${running.frontend}`,
      '如需查看探活与日志，直接调用 rms_front_status。',
    ].join('\n')
  }

  if (!existsSync(projectRoot)) {
    return `启动失败：project_root 不存在 → ${projectRoot}`
  }

  const next = { ...state, projectRoot, startedAt: new Date().toISOString() }

  // 清理：① force 时结束仍存活的记录进程；② 结束仍占用 80/5174 的残留实例。
  // ② 必须做：MCP server 重启后记录的 cmd 包装 PID 会失效，而 java/vite 仍在监听；
  // 若不清掉，新 vite 会因 strictPort:false 静默漂移到 5175，而后端仍指向 5174 的旧实例。
  const portsToClear = [
    ...(args.skip_frontend !== true ? [FRONTEND_PORT] : []),
    ...(args.skip_backend !== true ? [BACKEND_PORT] : []),
  ]
  const stalePids = new Set()
  if (args.force) {
    if (running.frontend) stalePids.add(state.frontend.pid)
    if (running.backend) stalePids.add(state.backend.pid)
  }
  for (const pid of stalePids) {
    const res = killTree(pid)
    lines.push(`已结束记录中的存活进程 pid=${pid}（taskkill ${res.ok ? '成功' : '失败'}）`)
  }
  for (const s of killPortOwners(portsToClear, stalePids)) {
    lines.push(`已释放 :${s.port} 上的残留实例 pid=${s.pid}（taskkill ${s.ok ? '成功' : '失败'}）`)
  }

  if (args.skip_frontend !== true) {
    if (!existsSync(`${frontendPath}/node_modules/vite`)) {
      lines.push(`⚠ 前端未安装依赖（缺 ${frontendPath}/node_modules/vite），已在 ${frontendPath} 跳过；请先 npm install。`)
      next.frontend = null
    } else {
      const started = spawnService({
        cmdline: 'npm run dev',
        cwd: frontendPath,
        env: buildEnv(javaHome),
        logFile: LOG_FILE.frontend,
      })
      next.frontend = { pid: started.pid, cmd: 'npm run dev', cwd: frontendPath, log: LOG_FILE.frontend }
      lines.push(`已拉起前端 dev server  pid=${started.pid}  (npm run dev @ ${frontendPath} → :${FRONTEND_PORT})`)
    }
  } else {
    next.frontend = null
    lines.push('已跳过前端（skip_frontend: true）。')
  }

  if (args.skip_backend !== true) {
    const cmdline = `mvn spring-boot:run -Dspring-boot.run.arguments=${SPRING_CONFIG_ARG}`
    const started = spawnService({
      cmdline,
      cwd: projectRoot,
      env: buildEnv(javaHome),
      logFile: LOG_FILE.backend,
    })
    next.backend = { pid: started.pid, cmd: cmdline, cwd: projectRoot, log: LOG_FILE.backend }
    lines.push(`已拉起后端          pid=${started.pid}  (mvn spring-boot:run @ ${projectRoot} → :${BACKEND_PORT})`)
    lines.push(`后端 JAVA_HOME=${javaHome}`)
  } else {
    next.backend = null
    lines.push('已跳过后端（skip_backend: true）。')
  }

  writeState(next)

  const waitSeconds = Number(args.wait_seconds || 0)
  if (waitSeconds > 0) {
    const deadline = Date.now() + waitSeconds * 1000
    let backendReady = false
    let frontendReady = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500))
      frontendReady = frontendReady || (await portOpen(FRONTEND_PORT))
      if (!backendReady && (await portOpen(BACKEND_PORT))) {
        const probe = await httpProbe(BACKEND_PROBE_PATH, BACKEND_PORT)
        backendReady = probe.status === 200 || probe.status === 302 || probe.status === 401
      }
      if (backendReady && frontendReady) break
    }
    lines.push(`等待 ${waitSeconds}s 后就绪情况：backend=${backendReady ? 'ready' : 'not-ready'} frontend=${frontendReady ? 'ready' : 'not-ready'}`)
  }

  lines.push('')
  lines.push(`访问入口：http://rms.dev.huizhi-intl.com${BACKEND_PROBE_PATH}#/dashboard  （80 端口，页面由后端渲染、资产由 ${FRONTEND_PORT} 提供）`)
  lines.push(`日志：${LOG_FILE.backend} / ${LOG_FILE.frontend}`)
  lines.push('后端首次启动需 Maven 编译与依赖加载，通常需要数十秒；用 rms_front_status 或 rms_front_logs 观察。')
  return lines.join('\n')
}

async function serviceStatus(args = {}) {
  const state = readState()
  const tailLines = Number(args.tail ?? 12)
  const out = []

  out.push(`状态目录：${STATE_DIR}`)
  out.push(`project_root：${state.projectRoot || DEFAULT_PROJECT_ROOT}`)

  const owners = portOwners([BACKEND_PORT, FRONTEND_PORT])
  const rows = [
    { name: 'backend', port: BACKEND_PORT, rec: state.backend },
    { name: 'frontend', port: FRONTEND_PORT, rec: state.frontend },
  ]
  const strayNotes = []
  for (const row of rows) {
    const recPid = row.rec && row.rec.pid
    const alive = isAlive(recPid)
    const listening = await portOpen(row.port)
    const owner = [...(owners.get(String(row.port)) || [])]
    out.push(
      `- ${row.name.padEnd(8)} pid=${String(recPid || '-').padEnd(7)} 进程=${alive ? 'alive' : 'dead'} 端口:${row.port}=${listening ? 'listening' : 'closed'}${owner.length ? ` 持有者=${owner.join(',')}` : ''}`,
    )
    // 端口持有者通常是记录 PID 的孙进程（cmd → mvn/npm → java/vite），故只在“记录进程已死”时才判为残留。
    if (!alive && owner.length) strayNotes.push(`:${row.port} 记录进程已死但仍被 pid=${owner.join(',')} 占用`)
  }
  if (strayNotes.length) {
    out.push(`⚠ ${strayNotes.join('；')}（残留实例：MCP server 重启后记录的 PID 会失效；rms_front_start 会自动清理，rms_front_stop 也会按端口释放）`)
  }

  const probe = await httpProbe(BACKEND_PROBE_PATH, BACKEND_PORT)
  out.push(
    `- 后端 HTTP 探活 GET ${BACKEND_PROBE_PATH} → ${probe.status ? `status ${probe.status}` : `不可达(${probe.error})`}`,
  )

  if (tailLines > 0) {
    for (const key of ['backend', 'frontend']) {
      const tail = readTail(LOG_FILE[key], tailLines, null)
      out.push('')
      out.push(`----- ${key}.log 末 ${tailLines} 行 -----`)
      out.push(tail === null ? '(暂无日志文件)' : tail || '(空)')
    }
  }
  return out.join('\n')
}

function stopService() {
  const state = readState()
  const out = []
  const killed = new Set()

  for (const key of ['frontend', 'backend']) {
    const rec = state[key]
    if (!rec || !rec.pid) {
      out.push(`- ${key}：无记录的 PID，跳过。`)
      continue
    }
    if (!isAlive(rec.pid)) {
      out.push(`- ${key}：记录 pid=${rec.pid} 已不存在（多因 MCP server 重启而结束），改按端口兜底释放。`)
      continue
    }
    const res = killTree(rec.pid)
    killed.add(rec.pid)
    out.push(`- ${key}：pid=${rec.pid} taskkill ${res.ok ? '成功' : '失败'}${res.out ? ` (${res.out.replace(/\s+/g, ' ').trim()})` : ''}`)
  }

  const stray = killPortOwners([BACKEND_PORT, FRONTEND_PORT], killed)
  if (stray.length) {
    for (const s of stray) out.push(`- 兜底：:${s.port} 持有者 pid=${s.pid} taskkill ${s.ok ? '成功' : '失败'}`)
  } else {
    out.push('- 兜底：80/5174 已无残留监听进程。')
  }

  writeState({ ...state, backend: null, frontend: null, stoppedAt: new Date().toISOString() })
  out.push('')
  out.push('已清空记录并释放 80 / 5174。')
  return out.join('\n')
}

function readLogs(args = {}) {
  const target = args.target || 'backend'
  const lines = Number(args.lines || 80)
  const filter = args.filter && String(args.filter)
  const keys = target === 'both' ? ['backend', 'frontend'] : [target]
  const out = []
  for (const key of keys) {
    const tail = readTail(LOG_FILE[key], lines, filter)
    out.push(`----- ${key}.log${filter ? ` (含 "${filter}")` : ''} 末 ${lines} 行 -----`)
    out.push(tail === null ? `(暂无日志文件：${LOG_FILE[key]})` : tail || '(空)')
    out.push('')
  }
  return out.join('\n')
}

/* ------------------------------------------------------------------ */
/* 工具清单                                                            */
/* ------------------------------------------------------------------ */

/** 模型可见工具清单。 */
export const tools = [
  {
    name: 'rms_front_start',
    description:
      '完整启动 rms-front 本地服务：先起 frontend-ui 的 Vite dev server(5174)，再用 mvn spring-boot:run 拉后端(80，带 base-config.yml+application-dev.yml)。' +
      '启动前会自动清理 80/5174 上的残留实例（避免 vite 端口漂移）。' +
      '触发场景：启动 rms-front、拉起 rms 前后端服务、渲染真实前端页面、打开本地 rms 页面、启动 thymeleaf 一体工程。' +
      'Keywords: start rms-front, launch rms front service, run thymeleaf app, start spring boot rms, render real frontend page.',
    parameters: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: `rms-front 仓库根目录，默认 ${DEFAULT_PROJECT_ROOT}` },
        frontend_dir: { type: 'string', description: `前端目录（相对 project_root），默认 ${DEFAULT_FRONTEND_DIR}` },
        java_home: { type: 'string', description: `后端使用的 JDK11 根目录，默认 ${DEFAULT_JAVA_HOME}` },
        skip_frontend: { type: 'boolean', description: 'true 则只起后端（生产式验证：需先 npm run build）' },
        skip_backend: { type: 'boolean', description: 'true 则只起前端 dev server' },
        force: { type: 'boolean', description: '已有存活实例时先结束再重新拉起，默认 false（直接复用）' },
        wait_seconds: {
          type: 'integer',
          minimum: 0,
          maximum: 600,
          description: '启动后最多等待多少秒做就绪探测再返回；0 表示立即返回（默认）',
        },
      },
      required: [],
    },
    output: textOutput,
    run: startService,
  },
  {
    name: 'rms_front_status',
    description:
      '查询 rms-front 本地服务状态：进程存活、80/5174 端口监听（含持有者 PID）、后端 /rms/ui/ HTTP 探活、最近日志尾部。' +
      '触发场景：rms-front 是否已启动、rms 服务状态、端口是否监听、本地 rms 页面是否可访问。' +
      'Keywords: rms-front status, service health, port listening, is it running.',
    parameters: {
      type: 'object',
      properties: {
        tail: { type: 'integer', minimum: 0, maximum: 200, default: 12, description: '每个日志附带的末尾行数，0 表示不附日志' },
      },
      required: [],
    },
    output: textOutput,
    run: serviceStatus,
  },
  {
    name: 'rms_front_stop',
    description:
      '停止 rms-front 本地服务：结束启动时记录的进程树，并按端口兜底释放 80 / 5174（记录 PID 失效时仍能释放）。' +
      '触发场景：停止 rms-front、关闭 rms 服务、释放 80 端口、重启前先关掉。' +
      'Keywords: stop rms-front, kill rms service, release port 80.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: textOutput,
    run: stopService,
  },
  {
    name: 'rms_front_logs',
    description:
      '读取 rms-front 本地服务的后端/前端日志尾部，用于诊断启动失败或卡住。' +
      '触发场景：rms-front 启动报错、看 rms 日志、backend/frontend log、Maven 编译失败排查。' +
      'Keywords: rms-front logs, read startup log, spring boot log, vite log, troubleshoot startup.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['backend', 'frontend', 'both'], default: 'backend', description: '读哪一份日志' },
        lines: { type: 'integer', minimum: 1, maximum: 500, default: 80, description: '末尾行数' },
        filter: { type: 'string', description: '只保留包含该子串的行，例如 ERROR' },
      },
      required: [],
    },
    output: textOutput,
    run: readLogs,
  },
]
