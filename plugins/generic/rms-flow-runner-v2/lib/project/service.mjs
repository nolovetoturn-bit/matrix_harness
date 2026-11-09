import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentEvent, chatMessage } from '../matrix/messages.mjs'
import { firstActionable, nextUnaccepted, treeView } from '../matrix/nav.mjs'
import { deriveState, STATES } from '../matrix/state.mjs'
import { listQuestions } from '../matrix/questions.mjs'
import { assertMatrixId } from '../matrix/schema.mjs'
import { loadAll, loadMatrix, listRuns, resolveDataDir, saveMatrix } from '../matrix/store.mjs'
import { loadDomain, saveDomain } from '../domain/store.mjs'
import { run as runMatrix } from '../matrix/service.mjs'
import { addMemoryEntry, memoryEntries, removeMemoryEntry, updateMemoryEntry, writeMemoryFile } from './memory.mjs'
import {
  autoCheckpoint,
  commitProjectCheckpoint,
  initProjectRepo,
  projectGitLog,
  projectGitShow,
  projectGitStatus,
  restoreProjectCheckpoint,
} from './git.mjs'
import { assertProjectId, createProjectRecord, PROJECT_STATES } from './schema.mjs'
import { ensureProjectSession, projectBrief } from './session.mjs'
import {
  appendProjectOperation,
  bindSubtreeToProject,
  ensureProjectCwd,
  ensureProjectsMigrated,
  listProjects,
  loadProject,
  logProjectOperation,
  projectWorkDir,
  saveProject,
  updateProject,
  withProjectLock,
} from './store.mjs'

const dataDirOf = args => resolveDataDir(args.data_dir)

/** 解析 project_id：显式参数优先；否则用项目会话 id（pj_...）自动绑定。 */
function projectIdOf(args = {}, context = {}) {
  const explicit = String(args.project_id || (typeof args.id === 'string' && args.id.startsWith('pj_') ? args.id : '') || '').trim()
  if (explicit) return assertProjectId(explicit)
  const sessionId = String((context && context.sessionId) || '').trim()
  if (/^pj_[A-Za-z0-9_-]{4,40}$/.test(sessionId)) return assertProjectId(sessionId)
  const prefixed = /^(pj_[A-Za-z0-9]+)-/.exec(sessionId)
  if (prefixed) return assertProjectId(prefixed[1])
  throw new Error('无法从当前会话确定 project_id：请在参数中显式传 project_id')
}

function requireProject(dataDir, projectId) {
  assertProjectId(projectId)
  return loadProject(dataDir, projectId)
}

/** 解析 matrix_id：显式参数优先；否则用 matrix 会话 id 自动绑定。 */
function matrixIdOf(args = {}, context = {}) {
  const explicit = String(args.matrix_id || '').trim()
  if (explicit) return assertMatrixId(explicit)
  const sessionId = String((context && context.sessionId) || '').trim()
  if (/^mx_[A-Za-z0-9_-]{4,40}$/.test(sessionId)) return assertMatrixId(sessionId)
  const prefixed = /^(mx_[A-Za-z0-9]+)-/.exec(sessionId)
  if (prefixed) return assertMatrixId(prefixed[1])
  throw new Error('无法从当前会话确定 matrix_id：请在参数中显式传 matrix_id')
}

function projectMatrices(dataDir, project) {
  const matrices = loadAll(dataDir)
  const all = [...matrices.values()].filter(matrix => matrix.project_id === project.id)
  return { matrices, all }
}

function rootRows(project, matrices, { archived = false } = {}) {
  return project.root_matrix_ids
    .map(id => matrices.get(id))
    .filter(matrix => matrix && Boolean(matrix.archived_at) === archived)
    .map(matrix => {
      const state = deriveState(matrix, matrices)
      return {
        id: matrix.id,
        name: matrix.name,
        task: matrix.task,
        state,
        stored_state: matrix.state,
        runnable: state === STATES.RUNNABLE,
        accepted: state === STATES.ACCEPTED,
        archived_at: matrix.archived_at || null,
        children_total: (matrix.children || []).length,
        children_accepted: (matrix.children || [])
          .map(ref => matrices.get(ref.matrix_id))
          .filter(child => child && deriveState(child, matrices) === STATES.ACCEPTED)
          .length,
        updated_at: matrix.updated_at,
      }
    })
}

function projectView(dataDir, project) {
  const { matrices, all } = projectMatrices(dataDir, project)
  const runs = all
    .flatMap(matrix => listRuns(dataDir, matrix.id).map(run => ({
      id: run.id,
      matrix_id: matrix.id,
      name: run.name,
      status: run.status,
      trace_count: (run.trace || []).length,
      created_at: run.created_at,
      completed_at: run.completed_at || null,
    })))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  const byState = {}
  for (const matrix of all) {
    const state = deriveState(matrix, matrices)
    byState[state] = (byState[state] || 0) + 1
  }
  const roots = rootRows(project, matrices)
  const archivedRoots = rootRows(project, matrices, { archived: true })
  const domains = (project.domain_ids || []).map(id => {
    try {
      const domain = loadDomain(dataDir, id)
      const total = (domain.models || []).length + (domain.stubs || []).length + (domain.interacts || []).length
      const implemented = [...(domain.models || []), ...(domain.stubs || []), ...(domain.interacts || [])]
        .filter(item => item.matrix_id).length
      return {
        id: domain.id,
        name: domain.name,
        brief: domain.brief,
        state: domain.state,
        models: (domain.models || []).length,
        stubs: (domain.stubs || []).length,
        interacts: (domain.interacts || []).length,
        implemented,
        total,
        updated_at: domain.updated_at,
      }
    } catch {
      return null
    }
  }).filter(Boolean)
  return {
    id: project.id,
    name: project.name,
    brief: project.brief,
    state: project.state,
    cwd: project.cwd,
    dsh_session_id: project.dsh_session_id,
    root_matrix_ids: project.root_matrix_ids,
    roots,
    archived_roots: archivedRoots,
    domains,
    stats: {
      matrices: all.length,
      roots: roots.length,
      archived_roots: archivedRoots.length,
      by_state: byState,
      runs: {
        total: runs.length,
        running: runs.filter(run => ['running', 'waiting_human', 'waiting_children'].includes(run.status)).length,
        completed: runs.filter(run => run.status === 'completed').length,
        failed: runs.filter(run => run.status === 'failed').length,
      },
    },
    runs,
    memory: {
      entries: memoryEntries(project),
      updated_at: project.memory.updated_at,
      file: project.cwd ? join(project.cwd, 'PROJECT_MEMORY.md') : null,
      file_exists: project.cwd ? existsSync(join(project.cwd, 'PROJECT_MEMORY.md')) : false,
    },
    messages: project.messages || [],
    archive: project.archive || [],
    oplog: (project.oplog || []).slice(-200),
    // 项目会话里的 ask_user_question 与 matrix 同构：面板按 project id 作答
    questions: listQuestions(dataDir, project.id),
    last_opened_at: project.last_opened_at || null,
    created_at: project.created_at,
    updated_at: project.updated_at,
  }
}

/**
 * dsh 会话 → 项目归档：用户、assistant 与工具调用增量写入，重复轮询不重复记录。
 * 项目会话只做归档，不回灌（项目侧动作通过 project_* 工具本身留痕）。
 */
async function syncProjectArchive(dataDir, project, dependencies = {}) {
  if (typeof dependencies.sessionEvents !== 'function' || !project.dsh_session_id) return
  const since = Number(project.dsh_event_seq) || 0
  let snapshot
  try {
    snapshot = await dependencies.sessionEvents({ sessionId: project.dsh_session_id, sinceSeq: since })
  } catch {
    return
  }
  const events = (snapshot && snapshot.events) || []
  const cursor = Number(snapshot && snapshot.cursor)
  let changed = false
  const textOf = content => Array.isArray(content)
    ? content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('').trim()
    : ''
  for (const event of events) {
    if (!event || Number(event.seq) < since) continue
    const data = event.data || {}
    if (event.type === 'assistant/message') {
      const source = data.message && data.message.source
      const mirrored = source && source.kind === 'model' && source.model === 'matrix-mirror'
      const text = textOf(data.message && data.message.content)
      if (text && !mirrored) {
        chatMessage(project, 'assistant', text, { source: 'dsh', session_time: event.time })
        changed = true
      }
    } else if (event.type === 'user/message') {
      const source = data.source && data.source.kind
      const text = textOf(data.content)
      // 面板发起的输入已由 chat() 写入，这里只归档 dsh 界面里的真人输入
      if (source === 'user' && text) {
        chatMessage(project, 'user', text, { source: 'dsh', session_time: event.time })
        changed = true
      }
    } else if (event.type === 'tool/call') {
      project.archive_seq = (project.archive_seq || 0) + 1
      project.archive = [...(project.archive || []), {
        id: `arc-${project.archive_seq}`,
        seq: project.archive_seq,
        type: 'tool',
        source: 'dsh',
        at: new Date(event.time || Date.now()).toISOString(),
        text: String(data.name || ''),
        data: { name: data.name, callId: data.callId, session_time: event.time },
      }].slice(-1000)
      changed = true
    }
  }
  if (Number.isInteger(cursor) && cursor > since) {
    project.dsh_event_seq = cursor
    changed = true
  }
  if (changed) saveProject(dataDir, project)
}

async function detailOf(dataDir, projectId, dependencies = {}) {
  const project = requireProject(dataDir, projectId)
  await syncProjectArchive(dataDir, project, dependencies)
  const view = projectView(dataDir, project)
  if (typeof dependencies.agentStatus === 'function' && view.dsh_session_id) {
    try {
      view.agent = await dependencies.agentStatus({ sessionId: view.dsh_session_id })
    } catch {
      view.agent = null
    }
  }
  return view
}

/** 新建项目：落项目文件、建项目 cwd 与 dsh 会话、写 PROJECT_MEMORY.md。 */
export async function projectCreate(args = {}, dependencies = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const project = createProjectRecord({ name: args.name, brief: args.brief || args.description || '' })
  project.cwd = String(args.cwd || '').trim() || projectWorkDir(dataDir, project.id)
  appendProjectOperation(project, {
    action: 'project_create',
    target_type: 'project',
    target_id: project.id,
    target_name: project.name,
    detail: { brief: project.brief },
  })
  saveProject(dataDir, project)
  try {
    await ensureProjectSession(project, { ...dependencies, dataDir })
    writeMemoryFile(project)
  } finally {
    saveProject(dataDir, project)
  }
  return detailOf(dataDir, project.id, dependencies)
}

export function projectList(args = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const includeArchived = args.include_archived === true
  const projects = listProjects(dataDir)
    .filter(project => includeArchived || project.state === PROJECT_STATES.ACTIVE)
    .map(project => {
      const { matrices } = projectMatrices(dataDir, project)
      const rows = rootRows(project, matrices)
      const archived = rootRows(project, matrices, { archived: true })
      return {
        id: project.id,
        name: project.name,
        brief: project.brief,
        state: project.state,
        cwd: project.cwd,
        roots: rows.length,
        archived_roots: archived.length,
        runnable_roots: rows.filter(row => row.runnable).length,
        accepted_roots: rows.filter(row => row.accepted).length,
        dsh_session_id: project.dsh_session_id,
        memory_entries: memoryEntries(project).length,
        last_opened_at: project.last_opened_at || null,
        updated_at: project.updated_at,
      }
    })
    // 最近打开的项目排在最上面；没有打开记录的按最近更新时间排序
    .sort((a, b) => String(b.last_opened_at || b.updated_at).localeCompare(String(a.last_opened_at || a.updated_at)))
  return { total: projects.length, projects }
}

/** 面板打开项目时刷新最近打开时间（项目列表排序依据）。 */
export async function projectOpen(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const projectId = projectIdOf(args, context)
  await updateProject(dataDir, projectId, project => {
    project.last_opened_at = new Date().toISOString()
  })
  return detailOf(dataDir, projectId, dependencies)
}

/**
 * 项目 Git checkpoint：init / commit / status / log / diff / restore。
 * 快照包含项目元数据、matrix 记录与 work、运行记录、dsh 会话事件。
 */
export async function projectGit(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const projectId = projectIdOf(args, context)
  const action = String(args.action || 'status').trim()
  let project = requireProject(dataDir, projectId)
  if (action === 'init') {
    await initProjectRepo(dataDir, projectId)
    await updateProject(dataDir, projectId, current => {
      appendProjectOperation(current, {
        action: 'git_init',
        target_type: 'project',
        target_id: projectId,
        target_name: current.name,
      })
    })
    project = requireProject(dataDir, projectId)
    return {
      action,
      initialized: true,
      status: await projectGitStatus(dataDir, project),
      log: await projectGitLog(dataDir, project),
    }
  }
  if (action === 'commit') {
    const message = String(args.message || '').trim() || '手动 checkpoint'
    let result
    try {
      result = await commitProjectCheckpoint(dataDir, project, { message, dependencies })
    } catch (error) {
      throw new Error(`提交失败：${error.message}`)
    }
    await updateProject(dataDir, projectId, current => {
      appendProjectOperation(current, {
        action: 'git_commit',
        target_type: 'project',
        target_id: projectId,
        target_name: current.name,
        detail: { commit: result.commit || null, message, skipped: Boolean(result.skipped) },
      })
    })
    project = requireProject(dataDir, projectId)
    return {
      action,
      result,
      status: await projectGitStatus(dataDir, project),
      log: await projectGitLog(dataDir, project),
    }
  }
  if (action === 'log') {
    return { action, log: await projectGitLog(dataDir, project, args.limit) }
  }
  if (action === 'diff') {
    const shown = await projectGitShow(dataDir, project, args.commit)
    return { action, ...shown }
  }
  if (action === 'restore') {
    const commit = String(args.commit || '').trim()
    if (!commit) throw new Error('restore 需要 commit')
    const result = await restoreProjectCheckpoint(dataDir, projectId, commit, dependencies)
    const restored = requireProject(dataDir, projectId)
    return {
      action,
      result,
      status: await projectGitStatus(dataDir, restored),
      log: await projectGitLog(dataDir, restored),
    }
  }
  const status = await projectGitStatus(dataDir, project)
  return {
    action: 'status',
    repo: status.repo,
    status,
    log: await projectGitLog(dataDir, project),
  }
}

export async function projectGet(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const projectId = projectIdOf(args, context)
  return detailOf(dataDir, projectId, dependencies)
}

export async function projectUpdate(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const projectId = projectIdOf(args, context)
  await updateProject(dataDir, projectId, project => {
    if (args.name !== undefined) {
      const name = String(args.name || '').trim()
      if (!name) throw new Error('项目名称不能为空')
      project.name = name.slice(0, 120)
    }
    if (args.brief !== undefined) project.brief = String(args.brief || '').trim().slice(0, 4000)
    appendProjectOperation(project, {
      action: 'project_update',
      target_type: 'project',
      target_id: project.id,
      target_name: project.name,
      detail: { name: project.name, brief: project.brief },
    })
  })
  await autoCheckpoint(dataDir, projectId, '更新项目', dependencies)
  return detailOf(dataDir, projectId, dependencies)
}

/** 归档项目：只改项目状态，不动根 matrix 的门禁与运行记录。 */
export async function projectArchive(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const projectId = projectIdOf(args, context)
  await updateProject(dataDir, projectId, project => {
    project.state = PROJECT_STATES.ARCHIVED
    appendProjectOperation(project, {
      action: 'project_archive',
      target_type: 'project',
      target_id: project.id,
      target_name: project.name,
      detail: { state: project.state },
    })
  })
  await autoCheckpoint(dataDir, projectId, '归档项目', dependencies)
  return detailOf(dataDir, projectId, dependencies)
}

/** 项目会话输入：写项目归档后交给项目 dsh agent。 */
export async function projectChat(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const projectId = projectIdOf(args, context)
  const text = String(args.text || '').trim()
  if (!text) throw new Error('text 不能为空')
  const prepared = await withProjectLock(dataDir, projectId, async () => {
    const project = requireProject(dataDir, projectId)
    ensureProjectCwd(dataDir, project)
    await ensureProjectSession(project, { ...dependencies, dataDir })
    writeMemoryFile(project)
    chatMessage(project, 'user', text, { source: 'panel' })
    appendProjectOperation(project, {
      action: 'project_chat',
      target_type: 'project',
      target_id: project.id,
      target_name: project.name,
      detail: { text: text.slice(0, 200) },
    })
    saveProject(dataDir, project)
    return {
      sessionId: project.dsh_session_id,
      cwd: project.cwd,
      title: project.name,
      task: project.brief,
      brief: projectBrief(project),
    }
  })
  if (prepared.sessionId && typeof dependencies.matrixChat === 'function') {
    const delivery = await dependencies.matrixChat({
      sessionId: prepared.sessionId,
      matrixId: projectId,
      text,
      dataDir,
      cwd: prepared.cwd,
      title: prepared.title,
      task: prepared.task,
      brief: prepared.brief,
    })
    if (delivery && delivery.recreated) {
      // 会话日志丢失后重建成空会话：重置游标，避免新回复被旧游标跳过
      await updateProject(dataDir, projectId, project => {
        project.dsh_event_seq = 0
      })
    }
  }
  return detailOf(dataDir, projectId, dependencies)
}

/** 项目记忆：list / add / update / remove；每次变更同步 PROJECT_MEMORY.md。 */
export async function projectMemory(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const projectId = projectIdOf(args, context)
  const action = String(args.action || 'list').trim()
  const project = requireProject(dataDir, projectId)
  if (action === 'list') {
    return {
      project_id: project.id,
      entries: memoryEntries(project),
      updated_at: project.memory.updated_at,
      file: project.cwd ? join(project.cwd, 'PROJECT_MEMORY.md') : null,
    }
  }
  const result = await updateProject(dataDir, projectId, current => {
    ensureProjectCwd(dataDir, current)
    let entry = null
    if (action === 'add') {
      entry = addMemoryEntry(current, { text: args.text, tags: args.tags })
    } else if (action === 'update') {
      entry = updateMemoryEntry(current, { id: args.entry_id || args.id, text: args.text })
    } else if (action === 'remove') {
      removeMemoryEntry(current, args.entry_id || args.id)
    } else {
      throw new Error(`不支持的 project_memory action：${action}`)
    }
    appendProjectOperation(current, {
      action: `memory_${action}`,
      target_type: 'memory',
      target_id: entry ? entry.id : (args.entry_id || args.id || null),
      target_name: null,
      detail: { text: String(args.text || '').slice(0, 200) },
    })
    writeMemoryFile(current)
  })
  await autoCheckpoint(dataDir, projectId, `记忆 ${action}`, dependencies)
  return {
    project_id: projectId,
    entries: memoryEntries(result),
    updated_at: result.memory.updated_at,
    file: result.cwd ? join(result.cwd, 'PROJECT_MEMORY.md') : null,
  }
}

export function projectTree(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const project = requireProject(dataDir, projectIdOf(args, context))
  const { matrices } = projectMatrices(dataDir, project)
  const rows = rootRows(project, matrices)
  const archived = rootRows(project, matrices, { archived: true })
  const viewOf = row => treeView(row.id, matrices)
  return { project_id: project.id, roots: rows.map(viewOf), archived_roots: archived.map(viewOf) }
}

export function projectSummary(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const project = requireProject(dataDir, projectIdOf(args, context))
  const { matrices, all } = projectMatrices(dataDir, project)
  const rows = rootRows(project, matrices)
  const archived = rootRows(project, matrices, { archived: true })
  const byState = {}
  for (const matrix of all) {
    const state = deriveState(matrix, matrices)
    byState[state] = (byState[state] || 0) + 1
  }
  const runs = all.flatMap(matrix => listRuns(dataDir, matrix.id))
  return {
    project_id: project.id,
    name: project.name,
    state: project.state,
    roots: rows,
    archived_roots: archived,
    matrices: all.length,
    by_state: byState,
    runnable_roots: rows.filter(row => row.runnable).map(row => row.id),
    pending_roots: rows.filter(row => !row.accepted).map(row => ({ id: row.id, name: row.name, state: row.state })),
    runs: {
      total: runs.length,
      running: runs.filter(run => ['running', 'waiting_human', 'waiting_children'].includes(run.status)).length,
      completed: runs.filter(run => run.status === 'completed').length,
      failed: runs.filter(run => run.status === 'failed').length,
    },
  }
}

/** 项目级导航：当前 matrix 子树 → 项目内其它根，按创建顺序找最深最左的可操作叶子。 */
export function projectNav(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const project = requireProject(dataDir, projectIdOf(args, context))
  const { matrices } = projectMatrices(dataDir, project)
  const roots = project.root_matrix_ids
    .map(id => matrices.get(id))
    .filter(matrix => matrix && !matrix.archived_at)
  const currentId = String(args.matrix_id || '').trim()
  if (currentId) {
    assertProjectMatrix(matrices, project, currentId)
    const currentRoot = matrices.get(matrices.get(currentId).root_id)
    if (!currentRoot || !currentRoot.archived_at) {
      const next = nextUnaccepted({ currentId, matrices })
      if (next) {
        const target = matrices.get(next.id)
        return { project_id: project.id, current: currentId, next, root_matrix_id: target.root_id, via: next.via }
      }
    }
  }
  for (const root of roots) {
    const found = firstActionable(root.id, matrices)
    if (found) {
      return {
        project_id: project.id,
        current: currentId || null,
        next: { id: found.id, name: found.name, state: deriveState(found, matrices), via: 'root' },
        root_matrix_id: found.root_id,
      }
    }
  }
  return { project_id: project.id, current: currentId || null, next: null, root_matrix_id: null }
}

function assertProjectMatrix(matrices, project, matrixId) {
  const matrix = matrices.get(matrixId)
  if (!matrix) throw new Error(`matrix 不存在：${matrixId}`)
  if (matrix.project_id !== project.id) throw new Error(`matrix ${matrixId} 不属于项目 ${project.id}`)
}

/** 运行项目内所有 runnable 根 matrix（顺序执行，避免并发写同一个项目的数据）。 */
export async function projectRunRunnable(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const projectId = projectIdOf(args, context)
  const project = requireProject(dataDir, projectId)
  const { matrices } = projectMatrices(dataDir, project)
  const targets = (args.matrix_ids && Array.isArray(args.matrix_ids) ? args.matrix_ids : project.root_matrix_ids)
    .map(id => matrices.get(id))
    .filter(matrix => matrix && !matrix.archived_at && deriveState(matrix, matrices) === STATES.RUNNABLE)
  const results = []
  for (const matrix of targets) {
    try {
      const result = await runMatrix({ data_dir: args.data_dir, matrix_id: matrix.id }, dependencies)
      results.push({ matrix_id: matrix.id, ok: true, run: result.executed ? { id: result.executed.run_id, status: result.executed.status } : null })
    } catch (error) {
      results.push({ matrix_id: matrix.id, ok: false, error: error && error.message ? error.message : String(error) })
    }
  }
  await logProjectOperation(dataDir, project.id, {
    action: 'project_run_runnable',
    target_type: 'project',
    target_id: project.id,
    target_name: project.name,
    ok: results.every(item => item.ok),
    detail: {
      ran: results.length,
      failed: results.filter(item => !item.ok).length,
      matrix_ids: results.map(item => item.matrix_id),
    },
  })
  await autoCheckpoint(dataDir, project.id, '批量运行', dependencies)
  return { project_id: project.id, ran: results.length, results }
}

function subtreeMatricesOf(dataDir, rootId) {
  const matrices = loadAll(dataDir)
  const rows = []
  const seen = new Set()
  const visit = id => {
    if (seen.has(id)) return
    seen.add(id)
    const matrix = matrices.get(id)
    if (!matrix) return
    rows.push(matrix)
    for (const ref of matrix.children || []) visit(ref.matrix_id)
    for (const item of matrices.values()) if (item.parent_id === id) visit(item.id)
  }
  visit(rootId)
  return rows
}

/** 移动后把已有 dsh 会话重新挂到目标项目的 workspace（侧栏分组跟随项目）。 */
async function reattachMovedSessions(dataDir, rootId, project, dependencies) {
  if (typeof dependencies.sessionMirror !== 'function') return
  for (const matrix of subtreeMatricesOf(dataDir, rootId)) {
    if (!matrix.dsh_session_id) continue
    const parent = matrix.parent_id ? loadMatrix(dataDir, matrix.parent_id) : null
    try {
      await dependencies.sessionMirror({
        sessionId: matrix.dsh_session_id,
        matrixId: matrix.id,
        workspace: project.cwd,
        title: matrix.name,
        task: matrix.task,
        parentSessionId: parent ? parent.dsh_session_id || parent.id : null,
      })
    } catch {}
  }
}

/**
 * 移动根 matrix 及其整棵子树到另一个项目。
 * 只允许根 matrix：子 matrix 的项目归属必须与父一致。
 */
export async function moveMatrix(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const matrixId = matrixIdOf(args, context)
  const targetProjectId = String(args.target_project_id || args.to_project_id || '').trim()
  if (!targetProjectId) throw new Error('target_project_id 不能为空')
  const target = requireProject(dataDir, targetProjectId)
  if (target.state === PROJECT_STATES.ARCHIVED) throw new Error(`目标项目 ${target.name} 已归档，不能移入`)
  const matrix = loadMatrix(dataDir, matrixId)
  if (matrix.parent_id) throw new Error('只能移动根 matrix；子 matrix 跟随父级归属')
  if (matrix.project_id === target.id) throw new Error(`matrix 已在项目 ${target.name} 中`)

  const source = matrix.project_id ? loadProject(dataDir, matrix.project_id) : null
  if (source) {
    source.root_matrix_ids = source.root_matrix_ids.filter(id => id !== matrixId)
    appendProjectOperation(source, {
      action: 'matrix_move',
      target_type: 'matrix',
      target_id: matrixId,
      target_name: matrix.name,
      detail: { to_project_id: target.id, to_project_name: target.name },
    })
    saveProject(dataDir, source)
  }
  target.cwd = ensureProjectCwd(dataDir, target)
  target.root_matrix_ids = [...target.root_matrix_ids.filter(id => id !== matrixId), matrixId]
  appendProjectOperation(target, {
    action: 'matrix_move_in',
    target_type: 'matrix',
    target_id: matrixId,
    target_name: matrix.name,
    detail: { from_project_id: source ? source.id : null, from_project_name: source ? source.name : null },
  })
  saveProject(dataDir, target)

  // 领域绑定属于源项目，移动 matrix 时解除绑定并清空元素 matrix_id
  if (matrix.domain_binding) {
    try {
      const binding = matrix.domain_binding
      const domain = loadDomain(dataDir, binding.domain_id)
      const list = binding.element_type === 'model' ? domain.models
        : binding.element_type === 'stub' ? domain.stubs
          : domain.interacts
      const element = (list || []).find(item => item.id === binding.element_id)
      if (element && element.matrix_id === matrix.id) element.matrix_id = null
      saveDomain(dataDir, domain)
    } catch {}
    matrix.domain_binding = null
  }
  matrix.project_id = target.id
  agentEvent(matrix, `已从项目 ${source ? source.name : '（未归属）'} 移动到项目 ${target.name}。`, {
    from_project: source ? source.id : null,
    to_project: target.id,
  })
  saveMatrix(dataDir, matrix)
  bindSubtreeToProject(dataDir, matrixId, target.id)
  await reattachMovedSessions(dataDir, matrixId, target, dependencies)
  if (source) await autoCheckpoint(dataDir, source.id, `移动 matrix ${matrix.name} 移出`, dependencies)
  await autoCheckpoint(dataDir, target.id, `移动 matrix ${matrix.name} 移入`, dependencies)
  return {
    matrix_id: matrixId,
    from_project_id: source ? source.id : null,
    to_project_id: target.id,
    root_matrix_ids: target.root_matrix_ids,
  }
}

/**
 * 归档/恢复根 matrix：只影响可见性，不改门禁状态与运行记录。
 * 归档后整棵子树从项目的活跃视图与默认列表中移出，仍可按 id 直接打开。
 */
export async function archiveMatrix(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const matrixId = matrixIdOf(args, context)
  const matrix = loadMatrix(dataDir, matrixId)
  if (matrix.parent_id) throw new Error('只能归档根 matrix；子 matrix 跟随根一起归档')
  const archived = args.archived === undefined ? true : Boolean(args.archived)
  if (archived) {
    matrix.archived_at = new Date().toISOString()
    agentEvent(matrix, '已归档：从活跃视图移出，可随时恢复。')
  } else {
    matrix.archived_at = null
    agentEvent(matrix, '已恢复：重新进入项目活跃视图。')
  }
  if (matrix.project_id) {
    try {
      const project = loadProject(dataDir, matrix.project_id)
      appendProjectOperation(project, {
        action: archived ? 'matrix_archive' : 'matrix_restore',
        target_type: 'matrix',
        target_id: matrixId,
        target_name: matrix.name,
      })
      saveProject(dataDir, project)
    } catch {}
  }
  saveMatrix(dataDir, matrix)
  await autoCheckpoint(dataDir, matrix.project_id, archived ? '归档 matrix' : '恢复 matrix', dependencies)
  return {
    matrix_id: matrixId,
    project_id: matrix.project_id || null,
    archived: Boolean(matrix.archived_at),
    archived_at: matrix.archived_at || null,
  }
}
