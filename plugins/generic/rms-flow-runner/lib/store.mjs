import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function resolveDataDir(value) {
  const configured = String(value || process.env.RMS_FLOW_RUNNER_DATA_DIR || '').trim()
  if (configured) return resolve(configured)
  const base = process.env.LOCALAPPDATA || homedir()
  return join(base, 'rms-flow-runner', 'runs')
}

function assertRunId(runId) {
  if (!/^flow-[A-Za-z0-9_-]+$/.test(String(runId || ''))) throw new Error('run_id 格式不正确')
}

function runFile(dataDir, runId) {
  assertRunId(runId)
  return join(dataDir, `${runId}.json`)
}

export function saveRun(dataDir, run) {
  mkdirSync(dataDir, { recursive: true })
  const file = runFile(dataDir, run.id)
  const temporary = join(dataDir, `.${run.id}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return run
}

export function loadRun(dataDir, runId) {
  const file = runFile(dataDir, runId)
  if (!existsSync(file)) throw new Error(`工作流运行不存在：${runId}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function runSummary(run) {
  return {
    id: run.id,
    name: run.name,
    parent_session_id: run.parent_session_id,
    workspace: run.workspace || null,
    workspace_id: run.workspace_id || null,
    dsh_session_id: run.dsh_session_id || null,
    parent_run_id: run.parent_run_id || null,
    parent_node_id: run.parent_node_id || null,
    parent_path: run.parent_path || null,
    root_run_id: run.root_run_id || run.id,
    depth: run.depth || 0,
    definition_ref: run.definition_ref || null,
    status: run.status,
    definition_version: run.definition_version || 1,
    previous_run_id: run.previous_run_id || null,
    superseded_by: run.superseded_by || null,
    repair_state: run.repair_state || null,
    repair_count: (run.repairs || []).length,
    repairs: run.repairs || [],
    current: run.current || null,
    pending: run.pending ? {
      node_id: run.pending.node_id,
      label: run.pending.label,
      path: run.pending.path,
      prompt: run.pending.prompt,
    } : null,
    fuel: run.fuel,
    trace_count: run.trace.length,
    created_at: run.created_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at || null,
    error: run.error || null,
  }
}

export function listRuns(dataDir) {
  if (!existsSync(dataDir)) return []
  const runs = []
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^flow-[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue
    const run = JSON.parse(readFileSync(join(dataDir, entry.name), 'utf8'))
    runs.push(run)
  }
  return runs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

async function withFileLock(dataDir, key, label, operation) {
  const lockDir = join(dataDir, '.locks')
  mkdirSync(lockDir, { recursive: true })
  const lockFile = join(lockDir, `${key}.lock`)
  let acquired = false
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), 'utf8')
      closeSync(fd)
      acquired = true
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
        stale = !processAlive(Number(lock.pid))
      } catch {}
      if (!stale || attempt === 1) throw new Error(`${label} 正在另一个进程中推进，请稍后重试`)
      unlinkSync(lockFile)
    }
  }
  try {
    return await operation()
  } finally {
    if (existsSync(lockFile)) unlinkSync(lockFile)
  }
}

export async function withRunLock(dataDir, runId, operation) {
  assertRunId(runId)
  return withFileLock(dataDir, runId, `运行 ${runId}`, operation)
}

function assertSessionId(sessionId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(sessionId || ''))) throw new Error('session_id 格式不正确')
}

function sessionFile(dataDir, sessionId) {
  assertSessionId(sessionId)
  return join(dataDir, `session-${sessionId}.json`)
}

export function saveSession(dataDir, session) {
  mkdirSync(dataDir, { recursive: true })
  const file = sessionFile(dataDir, session.id)
  const temporary = join(dataDir, `.session-${session.id}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return session
}

export function loadSession(dataDir, sessionId) {
  const file = sessionFile(dataDir, sessionId)
  if (!existsSync(file)) throw new Error(`工作流会话不存在：${sessionId}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function sessionExists(dataDir, sessionId) {
  return existsSync(sessionFile(dataDir, sessionId))
}

export function sessionSummary(session) {
  return {
    id: session.id,
    name: session.name,
    task: session.task,
    parent_session_id: session.parent_session_id || null,
    root_session_id: session.root_session_id || session.id,
    depth: session.depth || 0,
    origin: session.origin || null,
    workspace: session.workspace || null,
    workspace_id: session.workspace_id || null,
    workspace_revision: session.workspace_revision || 0,
    dsh_session_id: session.dsh_session_id || null,
    status: session.status,
    round: session.round || 0,
    acceptance_criteria: session.acceptance_criteria || [],
    draft_run_id: session.draft_run_id || null,
    active_run_id: session.active_run_id || null,
    open_questions: session.analysis?.questions || [],
    evaluations: session.evaluations || [],
    revision_count: (session.revisions || []).length,
    created_at: session.created_at,
    updated_at: session.updated_at,
  }
}

export function listSessions(dataDir) {
  if (!existsSync(dataDir)) return []
  const sessions = []
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^session-[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue
    sessions.push(JSON.parse(readFileSync(join(dataDir, entry.name), 'utf8')))
  }
  return sessions.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}

export async function withSessionLock(dataDir, sessionId, operation) {
  assertSessionId(sessionId)
  return withFileLock(dataDir, `session-${sessionId}`, `会话 ${sessionId}`, operation)
}

function assertDefinitionName(name) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(String(name || ''))) {
    throw new Error('定义名必须以字母开头，只能包含字母、数字、下划线和连字符')
  }
}

function definitionFile(dataDir, name) {
  assertDefinitionName(name)
  return join(dataDir, `definition-${name}.json`)
}

export function saveDefinition(dataDir, record) {
  mkdirSync(dataDir, { recursive: true })
  const file = definitionFile(dataDir, record.name)
  const temporary = join(dataDir, `.definition-${record.name}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return record
}

export function loadDefinitionRecord(dataDir, name) {
  const file = definitionFile(dataDir, name)
  if (!existsSync(file)) throw new Error(`工作流定义不存在：${name}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function definitionExists(dataDir, name) {
  return existsSync(definitionFile(dataDir, name))
}

export function listDefinitionRecords(dataDir) {
  if (!existsSync(dataDir)) return []
  const records = []
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^definition-[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue
    records.push(JSON.parse(readFileSync(join(dataDir, entry.name), 'utf8')))
  }
  return records.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

function buildFile(dataDir, sessionId) {
  assertSessionId(sessionId)
  return join(dataDir, `build-${sessionId}.json`)
}

export function saveBuild(dataDir, record) {
  mkdirSync(dataDir, { recursive: true })
  const file = buildFile(dataDir, record.session_id)
  const temporary = join(dataDir, `.build-${record.session_id}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return record
}

export function loadBuild(dataDir, sessionId) {
  const file = buildFile(dataDir, sessionId)
  if (!existsSync(file)) throw new Error(`构建会话不存在：${sessionId}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function buildExists(dataDir, sessionId) {
  return existsSync(buildFile(dataDir, sessionId))
}

// 删除某会话的构建（仅用于 DAG 确认前的整体重生成）
export function deleteBuild(dataDir, sessionId) {
  const file = buildFile(dataDir, sessionId)
  if (existsSync(file)) unlinkSync(file)
}

function buildStackFile(dataDir, rootSessionId) {
  assertSessionId(rootSessionId)
  return join(dataDir, `buildstack-${rootSessionId}.json`)
}

export function saveBuildStack(dataDir, record) {
  mkdirSync(dataDir, { recursive: true })
  const file = buildStackFile(dataDir, record.root_session_id)
  const temporary = join(dataDir, `.buildstack-${record.root_session_id}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return record
}

export function loadBuildStack(dataDir, rootSessionId) {
  const file = buildStackFile(dataDir, rootSessionId)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function buildStackExists(dataDir, rootSessionId) {
  return existsSync(buildStackFile(dataDir, rootSessionId))
}

export async function withBuildStackLock(dataDir, rootSessionId, operation) {
  assertSessionId(rootSessionId)
  return withFileLock(dataDir, `buildstack-${rootSessionId}`, `构建栈 ${rootSessionId}`, operation)
}

function mailFile(dataDir, sessionId) {
  assertSessionId(sessionId)
  return join(dataDir, `mail-${sessionId}.jsonl`)
}

export function appendMail(dataDir, envelope) {
  mkdirSync(dataDir, { recursive: true })
  appendFileSync(mailFile(dataDir, envelope.to_session), `${JSON.stringify(envelope)}\n`, 'utf8')
  return envelope
}

export function loadMailbox(dataDir, sessionId) {
  const file = mailFile(dataDir, sessionId)
  if (!existsSync(file)) return []
  const mails = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      mails.push(JSON.parse(line))
    } catch {}
  }
  return mails
}
