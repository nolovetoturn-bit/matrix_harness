import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { prepareRunPackage } from '../engine/compile.mjs'
import { validateDefinition, validateInput } from '../runner.mjs'
import { agentEvent } from './messages.mjs'
import { newRunId } from './schema.mjs'
import { loadMatrix, loadRun, listRuns, saveMatrix, saveRun } from './store.mjs'

const now = () => new Date().toISOString()
const clone = value => (value === undefined ? null : structuredClone(value))
const OUTPUT_LIMIT = 10 * 1024 * 1024
const CONTROL_PATHS = /\/item:\d+/g
const LOOP_PATHS = /\/iter:\d+/g
const TERMINAL_RUN_STATUS = new Set(['completed', 'failed', 'cancelled'])

/** 正在运行的 pipeline 进程；取消时按 runId 终止整棵进程树。 */
const activePipelines = new Map()

function killTree(child) {
  if (!child || child.killed || !child.pid) return
  if (process.platform === 'win32') {
    // 同步等待 taskkill 结束，确保返回时整棵进程树已经退出、目录句柄已释放
    try { spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }) } catch {}
    return
  }
  try {
    // POSIX 下 pipeline 以独立进程组启动，负 pid 可连同节点脚本一起终止
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {}
  }
}

function runTimeout() {
  return Math.max(1000, Number(process.env.RMS_FLOW_RUN_TIMEOUT_MS) || 30 * 60 * 1000)
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonFile(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value === undefined ? null : value, null, 2)}\n`, 'utf8')
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

const normalizeTracePath = path => String(path || '')
  .replace(CONTROL_PATHS, '/item:{index}')
  .replace(LOOP_PATHS, '/iter:{index}')

function nodeHashOf(manifest, path) {
  const nodes = (manifest && manifest.nodes) || {}
  if (nodes[path]) return nodes[path].hash || null
  const normalized = normalizeTracePath(path)
  return nodes[normalized] ? (nodes[normalized].hash || null) : null
}

/** 从 nodes/<pathKey>/meta.json 与 state/steps 重建 run.trace。 */
function collectTrace(runDir, manifest) {
  const nodeRoot = join(runDir, 'nodes')
  const entries = []
  const seen = new Set()
  for (const entry of listDir(nodeRoot)) {
    if (!entry.isDirectory()) continue
    const dir = join(nodeRoot, entry.name)
    const meta = readJsonFile(join(dir, 'meta.json'))
    if (!meta) continue
    const path = String(meta.path || `/${entry.name}`)
    seen.add(path)
    const status = meta.status || 'completed'
    entries.push({
      node_id: meta.node_id || null,
      label: meta.label || meta.node_id || null,
      kind: meta.type || null,
      node_hash: nodeHashOf(manifest, path),
      path,
      status,
      started_at: meta.started_at || null,
      finished_at: meta.finished_at || null,
      input: readJsonFile(join(dir, 'input.json')),
      ...(status === 'completed' ? { output: readJsonFile(join(dir, 'output.json')) } : {}),
      ...(status === 'failed' ? { error: readJsonFile(join(dir, 'error.json')) } : {}),
      ...(meta.details ? { details: meta.details } : {}),
      artifact_dir: `nodes/${entry.name}`,
      ...(meta.reused ? { reused_at: meta.finished_at || null } : {}),
      ...(status === 'waiting_human' ? { prompt: meta.prompt || null, waiting_node: meta.node_id || null } : {}),
    })
  }

  // meta 缺失时（例如极端中断）用步骤缓存补全已完成节点
  for (const entry of listDir(join(runDir, 'state', 'steps'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const cached = readJsonFile(join(runDir, 'state', 'steps', entry.name))
    if (!cached || !cached.path || seen.has(cached.path)) continue
    seen.add(cached.path)
    entries.push({
      node_id: cached.node_id || null,
      label: cached.node_id || null,
      kind: manifest && manifest.nodes && (manifest.nodes[cached.path] || manifest.nodes[normalizeTracePath(cached.path)])?.type || null,
      node_hash: cached.node_hash || nodeHashOf(manifest, cached.path),
      path: cached.path,
      status: cached.status || 'completed',
      started_at: cached.started_at || null,
      finished_at: cached.finished_at || null,
      input: readJsonFile(join(runDir, 'nodes', String(entry.name).replace(/\.json$/, ''), 'input.json')),
      output: cached.output,
      ...(cached.details ? { details: cached.details } : {}),
      artifact_dir: cached.artifact_dir || null,
    })
  }

  entries.sort((a, b) => {
    const left = String(a.started_at || '')
    const right = String(b.started_at || '')
    return left === right ? String(a.path).localeCompare(String(b.path)) : left.localeCompare(right)
  })
  entries.forEach((entry, index) => { entry.seq = index + 1 })
  return entries
}

function readTickets(runDir) {
  return listDir(join(runDir, 'tickets'))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => readJsonFile(join(runDir, 'tickets', entry.name)))
    .filter(Boolean)
}

function pendingFromTickets(runDir, run) {
  const open = readTickets(runDir)
    .filter(ticket => ticket && ticket.status === 'open')
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  if (open.length) {
    const ticket = open[0]
    return {
      node_id: ticket.node_id || null,
      label: ticket.label || ticket.node_id || null,
      kind: ticket.kind || 'human',
      path: ticket.path || null,
      prompt: ticket.prompt || null,
      input: ticket.input === undefined ? null : clone(ticket.input),
      ticket_id: ticket.id || null,
      ...(ticket.subflow_run_id ? { subflow_run_id: ticket.subflow_run_id } : {}),
    }
  }
  const checkpoint = readJsonFile(join(runDir, 'state', 'checkpoint.json'))
  if (checkpoint && checkpoint.status === 'waiting_human') {
    return {
      node_id: checkpoint.node_id || null,
      label: checkpoint.node_id || null,
      kind: checkpoint.kind || 'human',
      path: checkpoint.path || null,
      prompt: checkpoint.prompt || null,
      input: checkpoint.input === undefined ? null : clone(checkpoint.input),
      ticket_id: checkpoint.ticket_id || null,
      ...(checkpoint.subflow_run_id ? { subflow_run_id: checkpoint.subflow_run_id } : {}),
      ...(checkpoint.subflow_path ? { subflow_path: checkpoint.subflow_path } : {}),
    }
  }
  return run && run.pending ? run.pending : null
}

function markTicketAnswered(runDir, ticketId, answer) {
  if (!ticketId) return
  const file = join(runDir, 'tickets', `${ticketId}.json`)
  const ticket = readJsonFile(file)
  if (!ticket) return
  ticket.status = 'answered'
  ticket.answer = clone(answer)
  ticket.answered_at = now()
  ticket.answered_by = ticket.answered_by || 'user'
  ticket.resume_attempt = Number(ticket.resume_attempt || 0) + 1
  // 工单标记是附属信息，不能因为写失败阻断恢复
  try { writeJsonFile(file, ticket) } catch {}
}

function collectRunResult(runDir, run, exit) {
  const manifest = readJsonFile(join(runDir, 'manifest.json')) || { nodes: {} }
  const tickets = readTickets(runDir)
  const openTickets = tickets.filter(ticket => ticket && ticket.status === 'open')
  const output = readJsonFile(join(runDir, 'output.json'))
  const failure = readJsonFile(join(runDir, 'error.json'))
  const cancellation = readJsonFile(join(runDir, 'state', 'cancel.json'))

  let status
  if (cancellation) status = 'cancelled'
  else if (exit.timedOut) status = 'failed'
  else if (exit.code === 75 || openTickets.length) status = 'waiting_human'
  else if (exit.code === 0) status = 'completed'
  else status = 'failed'

  const error = status === 'failed'
    ? (failure || {
      node_id: null,
      path: null,
      message: exit.error && exit.error.message
        ? String(exit.error.message)
        : (exit.timedOut ? `pipeline 运行超过 ${runTimeout()}ms` : `pipeline 退出码 ${exit.code}`),
      exit_code: exit.timedOut ? null : exit.code,
    })
    : status === 'cancelled'
      ? { node_id: null, path: null, message: String(cancellation.reason || '运行已取消'), cancelled: true }
      : null

  return {
    status,
    output: status === 'completed' ? (output === undefined ? null : output) : null,
    error,
    pending: status === 'waiting_human' ? pendingFromTickets(runDir, run) : null,
    trace: collectTrace(runDir, manifest),
  }
}

/** 执行 pipeline.mjs 子进程；stdout/stderr 写入 runDir/pipeline.*.log。 */
function runPipeline(runDir, { runId, bridgeUrl, resume }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['pipeline.mjs', ...(resume ? ['--resume'] : [])], {
      cwd: runDir,
      env: {
        ...process.env,
        RMS_RUN_DIR: runDir,
        RMS_RUN_ID: runId,
        RMS_BRIDGE_URL: bridgeUrl,
      },
      windowsHide: true,
      // POSIX 下让 pipeline 成为独立进程组，取消时可连同节点脚本一起终止
      detached: process.platform !== 'win32',
    })
    activePipelines.set(runId, child)
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, runTimeout())
    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (activePipelines.get(runId) === child) activePipelines.delete(runId)
      try { writeFileSync(join(runDir, 'pipeline.stdout.log'), stdout, 'utf8') } catch {}
      try { writeFileSync(join(runDir, 'pipeline.stderr.log'), stderr, 'utf8') } catch {}
      resolve({ code: timedOut ? null : code, timedOut, error: error || null, stdout, stderr })
    }
    child.stdout.on('data', chunk => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', error => finish(null, error))
    child.on('close', code => finish(code, null))
  })
}

/**
 * 终止一次运行：写入 cancel 标记，杀掉活着的 pipeline 进程树，并递归终止子运行。
 * 等待人工的运行没有活进程，直接落 cancelled 终态；运行中的由 runMatrix 收尾。
 */
export function terminateRun(dataDir, runId, reason = 'user_cancelled') {
  for (const child of listRuns(dataDir)) {
    if (child.parent_run_id === runId && !TERMINAL_RUN_STATUS.has(child.status)) {
      terminateRun(dataDir, child.id, reason)
    }
  }
  const runDir = join(dataDir, 'runs', runId)
  writeJsonFile(join(runDir, 'state', 'cancel.json'), {
    run_id: runId,
    reason: String(reason || 'user_cancelled'),
    at: now(),
  })
  const child = activePipelines.get(runId)
  if (child) killTree(child)
  try {
    const run = loadRun(dataDir, runId)
    if (!TERMINAL_RUN_STATUS.has(run.status)) {
      run.status = 'cancelled'
      run.current = null
      run.completed_at = now()
      saveRun(dataDir, run)
    }
  } catch {}
  return { run_id: runId, killed: Boolean(child) }
}

function bridgeUrlOf(dependencies = {}) {
  const explicit = String(process.env.RMS_BRIDGE_URL || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const provided = dependencies.bridgeBaseUrl || dependencies.bridge_url
  const value = typeof provided === 'function' ? provided() : provided
  const text = String(value || '').trim()
  if (text) return text.replace(/\/+$/, '')
  return `http://127.0.0.1:3080${(dependencies && dependencies.panel_path) || '/flow-runner-v2'}`
}

function applyRunResult(run, result) {
  run.trace = result.trace || []
  run.status = result.status
  run.output = result.output === undefined ? null : result.output
  run.error = result.error || null
  run.pending = result.pending || null
  if (result.status === 'failed' && result.error) {
    run.current = {
      node_id: result.error.node_id || null,
      label: result.error.label || null,
      path: result.error.path || null,
      kind: 'failure',
    }
  } else if (result.status === 'waiting_human' && result.pending) {
    run.current = { ...result.pending }
  } else {
    run.current = null
  }
  run.completed_at = ['completed', 'failed', 'cancelled'].includes(result.status) ? now() : null
  run.updated_at = now()
}

/** 运行进入终态后释放该 run 的常驻 dsh agent，避免会话泄漏。 */
async function releaseRunSessions(run, dependencies = {}) {
  if (!TERMINAL_RUN_STATUS.has(run.status)) return
  if (typeof dependencies.disposeRunAgents !== 'function') return
  try {
    await dependencies.disposeRunAgents(run.id)
  } catch (error) {
    console.error(`[rms-flow-runner-v2] dispose run agents ${run.id} failed: ${error && error.message ? error.message : error}`)
  }
}

/**
 * 子运行结束后自动冒泡到父运行：把子输出（或失败原因）写进父 run 的恢复点，
 * 再以 --resume 重放父 run。父 run 若再次等待人工则停在等待态，等待下一个工单。
 */
async function bubbleToParent(dataDir, child, dependencies = {}) {
  if (!child || !child.parent_run_id || !child.parent_path) return null
  let parent
  try {
    parent = loadRun(dataDir, child.parent_run_id)
  } catch {
    return null
  }
  if (!parent || parent.status !== 'waiting_human') return null

  const parentDir = join(dataDir, 'runs', parent.id)
  const pending = parent.pending && parent.pending.path ? parent.pending : pendingFromTickets(parentDir, parent)
  if (!pending || pending.path !== child.parent_path) return null

  const resumeFile = join(parentDir, 'state', 'resume.json')
  const previous = readJsonFile(resumeFile)
  const resume = {
    ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
    [pending.path]: child.status === 'completed'
      ? {
        answer: clone(child.output),
        ticket_id: pending.ticket_id || null,
        subflow_run_id: child.id,
        subflow_status: child.status,
        answered_at: now(),
      }
      : {
        error: {
          node_id: child.parent_node_id || pending.node_id || null,
          path: pending.path,
          message: child.status === 'cancelled'
            ? '子运行已取消'
            : `子流程失败：${(child.error && child.error.message) || child.status}`,
        },
        ticket_id: pending.ticket_id || null,
        subflow_run_id: child.id,
        subflow_status: child.status,
        answered_at: now(),
      },
  }
  writeJsonFile(resumeFile, resume)
  markTicketAnswered(parentDir, pending.ticket_id, child.output)
  return resumeMatrixRun(dataDir, parent.matrix_id, parent.id, { dependencies, writeResume: false })
}

async function executeRunPackage({ dataDir, run, definition, matrix, dependencies, resume }) {
  const runDir = join(dataDir, 'runs', run.id)
  const bridgeUrl = bridgeUrlOf(dependencies)
  try {
    if (!resume) await prepareRunPackage({ dataDir, run, definition, matrix, bridgeUrl })
    const exit = await runPipeline(runDir, { runId: run.id, bridgeUrl, resume })
    return collectRunResult(runDir, run, exit)
  } catch (error) {
    return {
      status: 'failed',
      output: null,
      error: {
        node_id: null,
        path: null,
        message: error && error.message ? error.message : String(error),
      },
      pending: null,
      trace: collectTrace(runDir, readJsonFile(join(runDir, 'manifest.json')) || { nodes: {} }),
    }
  }
}

/** 按数量清理旧运行包；保留最新 RMS_FLOW_RUN_KEEP 个，且绝不删除当前 run。 */
function cleanupRuns(dataDir, currentRunId) {
  const keep = Math.max(1, Number(process.env.RMS_FLOW_RUN_KEEP) || 100)
  let runs
  try {
    runs = listRuns(dataDir)
  } catch {
    return
  }
  if (runs.length <= keep) return
  const keepIds = new Set(runs.slice(0, keep).map(run => run.id))
  keepIds.add(currentRunId)
  for (const run of runs) {
    if (keepIds.has(run.id)) continue
    try { rmSync(join(dataDir, 'runs', run.id), { recursive: true, force: true }) } catch {}
    try { rmSync(join(dataDir, 'runs', `${run.id}.json`), { force: true }) } catch {}
  }
}

export function createRunRecord({ matrix, definition, input, name, parentRun = null, node = null }) {
  return {
    version: 1,
    id: newRunId(),
    matrix_id: matrix.id,
    root_matrix_id: matrix.root_id,
    name: String(name || definition.name || matrix.name).trim(),
    task: matrix.task,
    workspace: null,
    // 运行工作区：每个 run 自包含的 workspace/（与 package 一起保存）
    artifacts_dir: null,
    // 'files'：文件式 I/O（推荐）；'inline'：仅 stdin/stdout
    io_mode: matrix.execution_mode || 'files',
    definition,
    input: clone(input),
    fuel: { initial: Number(definition.fuel) || 100, remaining: Number(definition.fuel) || 100 },
    trace: [],
    current: null,
    pending: null,
    paused_from: null,
    status: 'running',
    output: null,
    error: null,
    parent_run_id: parentRun ? parentRun.id : null,
    parent_node_id: node ? node.id : null,
    parent_path: null,
    depth: parentRun ? (parentRun.depth || 0) + 1 : 0,
    matrix_chain: parentRun ? [...(parentRun.matrix_chain || []), matrix.id] : [matrix.id],
    created_at: now(),
    updated_at: now(),
    completed_at: null,
  }
}

/**
 * 执行一个 matrix 的独立运行：生成 run package 并 spawn Node pipeline。
 * 调用方负责门禁校验（runnable/accepted）。
 */
export async function runMatrix(dataDir, matrixId, options = {}) {
  const dependencies = options.dependencies || {}
  const matrix = loadMatrix(dataDir, matrixId)
  const definition = clone(matrix.definition)
  if (!definition || !matrix.prebuild_done) throw new Error(`matrix ${matrixId} 尚未完成预构建，不能运行`)
  validateDefinition(definition)
  const input = options.input === undefined ? null : clone(options.input)
  validateInput(definition, input)
  const run = createRunRecord({ matrix, definition, input, parentRun: options.parentRun || null, node: options.parentNode || null })
  const runDir = join(dataDir, 'runs', run.id)
  run.workspace = join(runDir, 'workspace')
  run.io_mode = matrix.execution_mode || 'files'
  run.artifacts_dir = runDir
  run.parent_path = options.parentPath || null
  run.matrix_chain = options.parentRun ? [...(options.parentRun.matrix_chain || []), matrix.id] : [matrix.id]
  mkdirSync(runDir, { recursive: true })
  saveRun(dataDir, run)
  matrix.run_ids = [...(matrix.run_ids || []), run.id]
  agentEvent(matrix, `开始运行 ${run.id}`, { run_id: run.id })
  saveMatrix(dataDir, matrix)

  const result = await executeRunPackage({
    dataDir,
    run,
    definition,
    matrix,
    dependencies,
    resume: false,
  })
  applyRunResult(run, result)
  saveRun(dataDir, run)
  await releaseRunSessions(run, dependencies)

  const current = loadMatrix(dataDir, matrix.id)
  agentEvent(current, result.status === 'completed'
    ? `运行 ${run.id} 完成`
    : `运行 ${run.id} 状态：${result.status}${result.error ? `（${result.error.message || '失败'}）` : ''}`, { run_id: run.id })
  saveMatrix(dataDir, current)
  cleanupRuns(dataDir, run.id)

  return {
    run_id: run.id,
    status: run.status,
    output: run.output,
    error: run.error,
    pending: run.pending,
    depth: run.depth,
  }
}

/**
 * 人工恢复：写 resume.json 后以 --resume 重放同一 package（不重新 prepare，保留步骤缓存）。
 */
export async function resumeMatrixRun(dataDir, matrixId, runId, { input, dependencies = {}, writeResume = true } = {}) {
  const matrix = loadMatrix(dataDir, matrixId)
  const run = loadRun(dataDir, runId)
  if (run.matrix_id !== matrix.id) throw new Error('运行不属于该 matrix')
  if (run.status !== 'waiting_human') throw new Error(`运行 ${runId} 当前为 ${run.status}，不需要人工恢复`)

  const runDir = join(dataDir, 'runs', run.id)
  const pending = run.pending && run.pending.path ? run.pending : pendingFromTickets(runDir, run)
  if (!pending || !pending.path) throw new Error('运行缺少待恢复的节点路径，无法注入人工输入')

  if (writeResume) {
    const resumeFile = join(runDir, 'state', 'resume.json')
    const previous = readJsonFile(resumeFile)
    const resume = {
      ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
      [pending.path]: {
        answer: clone(input),
        ticket_id: pending.ticket_id || null,
        answered_at: now(),
      },
    }
    mkdirSync(join(runDir, 'state'), { recursive: true })
    writeJsonFile(resumeFile, resume)
    markTicketAnswered(runDir, pending.ticket_id, input)
  }

  run.status = 'running'
  run.pending = null
  run.output = null
  run.error = null
  run.completed_at = null
  saveRun(dataDir, run)

  const result = await executeRunPackage({
    dataDir,
    run,
    definition: run.definition,
    matrix,
    dependencies,
    resume: true,
  })
  applyRunResult(run, result)
  saveRun(dataDir, run)
  await releaseRunSessions(run, dependencies)

  const current = loadMatrix(dataDir, matrix.id)
  agentEvent(current, `人工恢复运行 ${run.id}，状态：${result.status}`, { run_id: run.id })
  saveMatrix(dataDir, current)

  // 子运行进入终态后冒泡父运行；父运行若再次等待人工，则停在等待态等下一个工单
  if (TERMINAL_RUN_STATUS.has(run.status)) {
    try {
      await bubbleToParent(dataDir, run, dependencies)
    } catch (error) {
      console.error(`[rms-flow-runner-v2] bubble to parent ${run.parent_run_id} failed: ${error && error.message ? error.message : error}`)
    }
  }
  cleanupRuns(dataDir, run.id)

  return {
    run_id: run.id,
    status: run.status,
    output: run.output,
    error: run.error,
    pending: run.pending,
    depth: run.depth,
  }
}
