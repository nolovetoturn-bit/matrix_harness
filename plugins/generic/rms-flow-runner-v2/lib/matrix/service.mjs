import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { analyzeRun, evaluateRun } from '../ai.mjs'
import { archiveEntry, inbox as mailboxInbox, replyMail, sendMail, agentEvent, chatMessage } from './messages.mjs'
import { breadcrumb, nextUnaccepted, treeView } from './nav.mjs'
import { dagViewOf, prebuildMatrix, retryPrebuild, reviseNode as reviseNodeImplementation } from './prebuild.mjs'
import { answerClarification, confirmDag, ensureMatrixSession, generateSkeleton, intakeMatrix, reviseMatrix } from './require.mjs'
import { assertMatrixId, createMatrixRecord } from './schema.mjs'
import { listQuestions } from './questions.mjs'
import { assertTransition, deriveState, inputRouting, isTerminalState, recomputeAfterChildAccept, STATES, TRANSITIONS } from './state.mjs'
import {
  loadAll,
  loadMatrix,
  loadRun,
  listRuns,
  matrixExists,
  recomputeAncestors,
  resolveDataDir,
  saveMatrix,
  updateMatrix,
  withMatrixLock,
} from './store.mjs'
import { runMatrix, resumeMatrixRun, terminateRun } from './execute.mjs'
import { attachRootMatrix, ensureProjectsMigrated, loadProject, logProjectOperation } from '../project/store.mjs'
import { autoCheckpoint } from '../project/git.mjs'

const queues = new Map()

/** 同一 matrix 串行推进；不同 matrix 可并行。 */
function enqueue(matrixId, task) {
  const previous = queues.get(matrixId) || Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  queues.set(matrixId, next)
  next.catch(() => {}).finally(() => {
    if (queues.get(matrixId) === next) queues.delete(matrixId)
  })
  return next
}

const dataDirOf = args => resolveDataDir(args.data_dir)

/**
 * 解析 matrix_id：显式参数优先；否则用工具执行上下文里的会话 id 自动绑定。
 * matrix 会话的 id 就是 matrix id，子 matrix 同样继承这一绑定关系。
 */
function matrixIdOf(args = {}, context = {}) {
  const explicit = String(args.matrix_id || args.id || '').trim()
  if (explicit) return assertMatrixId(explicit)
  const sessionId = String((context && context.sessionId) || '').trim()
  if (/^mx_[A-Za-z0-9_-]{4,40}$/.test(sessionId)) return assertMatrixId(sessionId)
  // 坏会话换绑后会话 id 形如 mx_<id>-b<时间戳>；前缀就是 matrix id
  const prefixed = /^(mx_[A-Za-z0-9]+)-/.exec(sessionId)
  if (prefixed) return assertMatrixId(prefixed[1])
  throw new Error('无法从当前会话确定 matrix_id：请在参数中显式传 matrix_id')
}

/** 面板输入统一发给绑定 agent，agent 用 matrix_* 工具完成意图识别与操作。 */
const AGENT_ROUTING = Object.freeze({
  target: 'agent',
  hint: '输入会发送给该 matrix 绑定的 dsh agent，由 agent 识别意图并调用 matrix_* 工具；下方按钮仍是确定性操作。',
})

function requireMatrix(dataDir, matrixId) {
  assertMatrixId(matrixId)
  if (!matrixExists(dataDir, matrixId)) throw new Error(`matrix 不存在：${matrixId}`)
  return loadMatrix(dataDir, matrixId)
}

function runSummary(run) {
  return {
    id: run.id,
    matrix_id: run.matrix_id,
    name: run.name,
    status: run.status,
    depth: run.depth || 0,
    parent_run_id: run.parent_run_id || null,
    parent_node_id: run.parent_node_id || null,
    trace_count: (run.trace || []).length,
    current: run.current || null,
    pending: run.pending ? { node_id: run.pending.node_id, label: run.pending.label, path: run.pending.path } : null,
    error: run.error || null,
    created_at: run.created_at,
    completed_at: run.completed_at || null,
    fuel: run.fuel,
  }
}

function publicMatrix(matrix, matrices) {
  const state = deriveState(matrix, matrices)
  const children = (matrix.children || []).map(ref => {
    const child = matrices.get(ref.matrix_id)
    return {
      node_id: ref.node_id,
      node_path: ref.node_path,
      matrix_id: ref.matrix_id,
      name: child ? child.name : null,
      state: child ? deriveState(child, matrices) : 'missing',
      runnable: child ? deriveState(child, matrices) === STATES.RUNNABLE : false,
    }
  })
  const actions = Object.keys(TRANSITIONS)
    .filter(action => TRANSITIONS[action].includes(matrix.state) && action !== 'evaluate' && action !== 'run')
  if (state === STATES.RUNNABLE) actions.push('run', 'evaluate', 'accept')
  if (state === STATES.ACCEPTED) actions.push('evaluate')
  if ([STATES.RUNNABLE, STATES.ACCEPTED, STATES.AWAITING_CHILDREN].includes(state)) actions.push('supervise')
  return {
    id: matrix.id,
    name: matrix.name,
    task: matrix.task,
    state,
    stored_state: matrix.state,
    parent_id: matrix.parent_id,
    root_id: matrix.root_id,
    project_id: matrix.project_id || null,
    archived_at: matrix.archived_at || null,
    domain_binding: matrix.domain_binding || null,
    domain_dependencies: matrix.domain_dependencies || [],
    depth: matrix.depth,
    runnable: state === STATES.RUNNABLE,
    gate_state: state,
    execution_mode: matrix.execution_mode || 'files',
    prebuild_done: Boolean(matrix.prebuild_done),
    analysis: matrix.analysis,
    clarifications: matrix.clarifications,
    assumptions: matrix.assumptions,
    acceptance_criteria: matrix.acceptance_criteria,
    skeleton: matrix.skeleton,
    dag: dagViewOf(matrix),
    dag_confirmed_at: matrix.dag_confirmed_at || null,
    definition: matrix.definition,
    children,
    dsh_session_id: matrix.dsh_session_id,
    cwd: matrix.cwd,
    run_ids: matrix.run_ids || [],
    progress: matrix.progress,
    error: matrix.error,
    evaluation: matrix.evaluation,
    supervision: matrix.supervision || null,
    mailbox: {
      total: matrix.mailbox?.total || 0,
      unread: (matrix.mailbox?.mails || []).filter(mail => mail.unread).length,
      mails: matrix.mailbox?.mails || [],
    },
    messages: matrix.messages || [],
    archive: matrix.archive || [],
    routing: { ...AGENT_ROUTING, state_target: inputRouting(state).target, state_hint: inputRouting(state).hint },
    actions: [...new Set(actions)],
    created_at: matrix.created_at,
    updated_at: matrix.updated_at,
  }
}

function viewOf(dataDir, matrixId) {
  const matrices = loadAll(dataDir)
  const matrix = matrices.get(matrixId)
  if (!matrix) throw new Error(`matrix 不存在：${matrixId}`)
  return publicMatrix(matrix, matrices)
}

function loadProjectOrNull(dataDir, projectId) {
  try {
    return loadProject(dataDir, projectId)
  } catch {
    return null
  }
}

const textOfContent = content => Array.isArray(content)
  ? content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('').trim()
  : ''

/**
 * 把 dsh 会话里的新事件增量归档进 matrix（dsh → matrix 单向）。
 * dsh 会话是对话事实源：用户输入、assistant 输出、工具调用都落在会话日志里，
 * 这里按 dsh_event_seq 游标拉取增量，重复轮询不会重复写入。
 */
async function syncArchiveFromSession(dataDir, matrixId, dependencies = {}) {
  if (typeof dependencies.sessionEvents !== 'function') return
  const matrix = loadMatrix(dataDir, matrixId)
  if (!matrix.dsh_session_id) return
  const since = Number(matrix.dsh_event_seq) || 0
  let snapshot
  try {
    snapshot = await dependencies.sessionEvents({ sessionId: matrix.dsh_session_id, sinceSeq: since })
  } catch {
    return
  }
  const events = (snapshot && snapshot.events) || []
  const cursor = Number(snapshot && snapshot.cursor)
  let changed = false
  for (const event of events) {
    if (!event || Number(event.seq) < since) continue
    const data = event.data || {}
    if (event.type === 'assistant/message') {
      // 由 matrix 回灌到 dsh 的事件会再次被读回；标记 matrix-mirror 的直接跳过，避免自循环
      const source = data.message && data.message.source
      const mirrored = source && source.kind === 'model' && source.model === 'matrix-mirror'
      const text = textOfContent(data.message && data.message.content)
      if (text && !mirrored) {
        chatMessage(matrix, 'assistant', text, { source: 'dsh', session_time: event.time })
        changed = true
      }
    } else if (event.type === 'user/message') {
      const source = data.source && data.source.kind
      const text = textOfContent(data.content)
      // 只归档真人输入（dsh 界面发来的 user/message）；面板输入已由 chat() 写入，
      // 运行时上下文、时间提醒等注入消息不进入会话归档。
      if (source === 'user') {
        chatMessage(matrix, 'user', text, { source: 'dsh', session_time: event.time })
        changed = true
      }
    } else if (event.type === 'tool/call') {
      archiveEntry(matrix, {
        type: 'tool',
        source: 'dsh',
        text: String(data.name || ''),
        data: { name: data.name, callId: data.callId, arguments: data.arguments, session_time: event.time },
      })
      changed = true
    }
  }
  if (Number.isInteger(cursor) && cursor > since) {
    matrix.dsh_event_seq = cursor
    changed = true
  }
  if (changed) saveMatrix(dataDir, matrix)
}

/** 只有 matrix 侧产生的内容需要回灌 dsh：受理需求、系统事件、状态迁移、人工按钮动作。 */
function shouldMirrorToSession(entry) {
  if (!entry || entry.source === 'dsh') return false
  if (entry.type === 'event' || entry.type === 'state') return true
  // 受理时写入的需求原文来自 matrix 侧；面板对话来自 panel，已在 dsh 侧存在
  if (entry.type === 'message') return entry.source === 'matrix' && entry.data && entry.data.role === 'user'
  if (entry.type === 'action') return entry.text !== 'chat' && entry.text !== 'kickoff'
  return false
}

/**
 * 把 matrix 侧的新归档回灌到绑定 dsh 会话，让 dsh 侧看到完整过程
 * （受理、需求分析、DAG、预构建进度、按钮动作）。聊天消息不重复回灌。
 */
async function syncSessionFromArchive(dataDir, matrixId, dependencies = {}) {
  if (typeof dependencies.sessionAppend !== 'function') return
  const matrix = loadMatrix(dataDir, matrixId)
  if (!matrix.dsh_session_id) return
  const archive = matrix.archive || []
  const cursor = Number(matrix.dsh_mirror_seq) || 0
  const last = archive.length ? archive[archive.length - 1].seq : 0
  if (last <= cursor) return
  const entries = archive
    .filter(entry => entry.seq > cursor && shouldMirrorToSession(entry))
    .map(entry => ({ seq: entry.seq, type: entry.type, source: entry.source, text: entry.text || '' }))
  if (entries.length) {
    const result = await dependencies.sessionAppend({ sessionId: matrix.dsh_session_id, matrixId, entries })
    // 会话正在跑 agent 时先跳过，游标不前移，等空闲后再回灌
    if (result && result.corrupt) {
      // 旧版建的会话没有 system 头，回灌会判定 corrupt：换绑一个新会话后重试
      const nextId = `${matrix.id}-b${Date.now().toString(36)}`
      matrix.dsh_session_id = nextId
      matrix.dsh_mirror_seq = 0
      saveMatrix(dataDir, matrix)
      try {
        const parent = matrix.parent_id ? loadMatrix(dataDir, matrix.parent_id) : null
        await ensureMatrixSession(matrix, { ...dependencies, dataDir }, parent, nextId)
        saveMatrix(dataDir, matrix)
        console.log(`[${matrixId}] session rebound to ${matrix.dsh_session_id}`)
        // 坏会话已不可读：换绑成功后顺手清掉，避免 dsh 侧栏堆着同名空会话
        if (result.path) await rm(dirname(result.path), { recursive: true, force: true }).catch(() => {})
        const retry = await dependencies.sessionAppend({ sessionId: matrix.dsh_session_id, matrixId, entries })
        console.log(`[${matrixId}] rebind mirror result ${JSON.stringify(retry)}`)
        if (!retry || retry.appended !== false) {
          matrix.dsh_mirror_seq = last
          saveMatrix(dataDir, matrix)
        }
      } catch (error) {
        console.error(`[${matrixId}] session rebind failed: ${error && error.message ? error.message : error}`)
      }
      return
    }
    if (result && result.appended === false) return
  }
  matrix.dsh_mirror_seq = last
  saveMatrix(dataDir, matrix)
}

/** 列出某个 matrix 的运行包下所有工单；open 的排前面。 */
export function ticketsOf(dataDir, matrixId) {
  const rows = []
  for (const run of listRuns(dataDir, matrixId)) {
    const dir = join(dataDir, 'runs', run.id, 'tickets')
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue
      try {
        const ticket = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
        if (ticket.matrix_id && ticket.matrix_id !== matrixId) continue
        rows.push({ ...ticket, run_status: run.status })
      } catch {}
    }
  }
  return rows.sort((a, b) => {
    const weight = ticket => ticket.status === 'open' ? 0 : 1
    return weight(a) - weight(b) || String(b.created_at).localeCompare(String(a.created_at))
  })
}

function findTicket(dataDir, matrixId, ticketId) {
  const ticket = ticketsOf(dataDir, matrixId).find(item => item.id === ticketId)
  if (!ticket) throw new Error(`工单不存在：${ticketId}`)
  return ticket
}

export function tickets(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const rows = ticketsOf(dataDir, matrixId)
  return { matrix_id: matrixId, total: rows.length, tickets: rows }
}

/** 面板确定性操作改变了 matrix 后，失效的提问要关闭，否则 agent 会一直卡在 ask_user_question。 */
function settleInvalidQuestions(matrixId, dependencies = {}, reason) {
  if (typeof dependencies.cancelUserQuestions !== 'function') return
  try {
    dependencies.cancelUserQuestions({ matrix_id: matrixId, reason })
  } catch {}
}

/** 取消一条 dsh agent 的提问；agent 会收到“问题已失效”并继续当前轮次。 */
export async function cancelUserQuestion(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const questionId = String(args.question_id || '').trim()
  if (!questionId) throw new Error('question_id 不能为空')
  if (typeof dependencies.cancelUserQuestion !== 'function') {
    throw new Error('宿主未注入 dsh 问题取消能力')
  }
  dependencies.cancelUserQuestion({
    matrix_id: matrixId,
    question_id: questionId,
    reason: args.reason || '用户已取消该问题',
  })
  return detailOf(dataDir, matrixId, dependencies)
}

/** 回答 dsh agent 通过 ask_user_question 发起的提问；答案回传给仍在等待的 agent。 */
export async function answerUserQuestion(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const questionId = String(args.question_id || '').trim()
  if (!questionId) throw new Error('question_id 不能为空')
  if (typeof dependencies.answerUserQuestion !== 'function') {
    throw new Error('宿主未注入 dsh 问题应答器，无法回答 ask_user_question')
  }
  await dependencies.answerUserQuestion({
    data_dir: dataDir,
    matrix_id: matrixId,
    question_id: questionId,
    answers: args.answers,
  })
  return detailOf(dataDir, matrixId, dependencies)
}

/** 答复工单：把答复写进对应 run 的恢复点，并继续执行。 */
export async function answerTicket(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const ticket = findTicket(dataDir, matrixId, String(args.ticket_id || ''))
  if (ticket.status !== 'open') throw new Error(`工单 ${ticket.id} 当前为 ${ticket.status}，不能答复`)
  return resume({
    data_dir: args.data_dir,
    matrix_id: matrixId,
    run_id: ticket.run_id,
    input: args.answer,
  }, dependencies)
}

/** 取消工单：标记工单与运行终止，不再恢复。 */
export async function cancelTicket(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const ticket = findTicket(dataDir, matrixId, String(args.ticket_id || ''))
  if (ticket.status !== 'open') throw new Error(`工单 ${ticket.id} 当前为 ${ticket.status}，不能取消`)
  ticket.status = 'cancelled'
  ticket.answered_at = new Date().toISOString()
  ticket.answered_by = 'user'
  writeFileSync(join(dataDir, 'runs', ticket.run_id, 'tickets', `${ticket.id}.json`), `${JSON.stringify(ticket, null, 2)}\n`, 'utf8')
  // 等待人工的运行没有活进程；这里同时负责终止可能仍在运行的进程树
  terminateRun(dataDir, ticket.run_id, `工单 ${ticket.id} 已取消`)
  await updateMatrix(dataDir, matrixId, current => {
    agentEvent(current, `工单 ${ticket.id} 已取消`, { ticket_id: ticket.id, run_id: ticket.run_id })
  })
  return detailOf(dataDir, matrixId, dependencies)
}

async function detailOf(dataDir, matrixId, dependencies = {}) {
  await syncArchiveFromSession(dataDir, matrixId, dependencies)
  await syncSessionFromArchive(dataDir, matrixId, dependencies)
  const view = viewOf(dataDir, matrixId)
  if (typeof dependencies.agentStatus === 'function' && view.dsh_session_id) {
    try {
      view.agent = await dependencies.agentStatus({ sessionId: view.dsh_session_id })
    } catch {
      view.agent = null
    }
  }
  const runs = listRuns(dataDir, matrixId).map(runSummary)
  const matrices = loadAll(dataDir)
  view.runs = runs
  view.tickets = ticketsOf(dataDir, matrixId)
  view.questions = listQuestions(dataDir, matrixId)
  const project = view.project_id ? loadProjectOrNull(dataDir, view.project_id) : null
  view.project = project ? { id: project.id, name: project.name, state: project.state, cwd: project.cwd } : null
  view.breadcrumb = [
    ...(project ? [{ id: project.id, name: project.name, state: project.state, kind: 'project' }] : []),
    ...breadcrumb(matrixId, matrices),
  ]
  view.nav = {
    next: nextUnaccepted({ currentId: matrixId, matrices }),
    parent: matrices.get(matrixId).parent_id,
  }
  return view
}

/**
 * 受理新 matrix。parent_id 存在时挂到父树；否则作为根 matrix 挂进项目（未指定 project_id 时按名称新建项目）。
 */
export async function intake(args = {}, dependencies = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const task = String(args.task || '').trim()
  if (!task) throw new Error('task 不能为空')
  const parentId = String(args.parent_id || '').trim() || null
  const explicitProject = String(args.project_id || '').trim() || null
  let parent = null
  if (parentId) {
    assertMatrixId(parentId)
    parent = requireMatrix(dataDir, parentId)
    if (explicitProject && explicitProject !== parent.project_id) {
      throw new Error(`子 matrix 必须继承父 matrix 的项目（${parent.project_id}），不能改挂到 ${explicitProject}`)
    }
  }
  const record = createMatrixRecord({
    task,
    name: args.name,
    parent_id: parentId,
    root_id: parent ? parent.root_id : null,
    depth: parent ? (parent.depth || 0) + 1 : 0,
    project_id: parent ? parent.project_id : explicitProject,
    domain_binding: !parent && args.domain_binding && typeof args.domain_binding === 'object'
      ? args.domain_binding
      : null,
  })
  record.cwd = null
  if (parent) {
    saveMatrix(dataDir, record)
  } else {
    // 根 matrix 必须属于一个项目；项目也会把 root_matrix_ids 与子树的 project_id 补齐
    attachRootMatrix(dataDir, record, explicitProject)
  }
  await enqueue(record.id, async () => {
    try {
      await intakeMatrix({ dataDir, task, parentMatrix: parent, record, dependencies })
    } finally {
      saveMatrix(dataDir, record)
    }
  })
  if (parent) {
    await updateMatrix(dataDir, parent.id, current => {
      agentEvent(current, `收到手动创建的子 matrix ${record.id}（${record.name}）`, { matrix_id: record.id })
    })
  }
  return detailOf(dataDir, record.id, dependencies)
}

export async function answer(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    if (matrix.state !== STATES.CLARIFYING) throw new Error(`当前状态 ${matrix.state} 不需要回答澄清问题`)
    await answerClarification(matrix, args.answer, dependencies)
    saveMatrix(dataDir, matrix)
    return detailOf(dataDir, matrixId, dependencies)
  })
}

export async function revise(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    await reviseMatrix(matrix, { task: args.task, instruction: args.instruction, dataDir }, dependencies)
    saveMatrix(dataDir, matrix)
    return detailOf(dataDir, matrixId, dependencies)
  })
}

export async function generateDag(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    if (matrix.state !== STATES.AWAITING_REQUIREMENT) {
      throw new Error(`当前状态 ${matrix.state} 不允许生成 DAG`)
    }
    await generateSkeleton(matrix, { instruction: args.instruction || null, dataDir }, dependencies)
    saveMatrix(dataDir, matrix)
    return detailOf(dataDir, matrixId, dependencies)
  })
}

/**
 * 重大修改 DAG：退回 awaiting_dag，作废旧预构建、评估与验收结果。
 * 可选 instruction：立即按修改意见重生成骨架；不给则保留当前骨架，供继续修改或重新确认。
 */
export async function reopenDag(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    assertTransition(matrix, 'reopen-dag')
    const instruction = String(args.instruction || '').trim()
    if (instruction) await generateSkeleton(matrix, { instruction, dataDir }, dependencies)
    matrix.dag_confirmed_at = null
    matrix.definition = null
    matrix.prebuild_done = false
    matrix.progress = { current_node: null, nodes: {}, started_at: null, finished_at: null }
    matrix.evaluation = null
    matrix.error = null
    delete matrix.accepted_at
    matrix.state = STATES.AWAITING_DAG
    agentEvent(matrix, instruction
      ? `已按重大修改意见重生成 DAG，回到确认阶段：${instruction}`
      : '已回到 DAG 确认阶段；旧预构建、运行评估与验收结果作废。')
    saveMatrix(dataDir, matrix)
    settleInvalidQuestions(matrixId, dependencies, 'DAG 已重新生成并回到确认阶段，原提问已失效')
    return detailOf(dataDir, matrixId, dependencies)
  })
}

export async function confirmDagAction(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return withMatrixLock(dataDir, matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    confirmDag(matrix, { dataDir })
    saveMatrix(dataDir, matrix)
    settleInvalidQuestions(matrixId, dependencies, '用户已通过面板确认 DAG，原提问已失效，不要重复询问')
    return detailOf(dataDir, matrixId, dependencies)
  })
}

/**
 * 启动预构建。background=true 时立即返回，进度由面板轮询。
 */
export async function prebuild(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const task = enqueue(matrixId, async () => {
    try {
      settleInvalidQuestions(matrixId, dependencies, '用户已通过面板启动预构建，原提问已失效')
      await prebuildMatrix({ dataDir, matrixId, dependencies })
    } catch (error) {
      // 节点失败已由 prebuildMatrix 写入；这里兜底记录启动阶段的异常，避免后台任务静默失败
      const message = error && error.message ? error.message : String(error)
      try {
        await updateMatrix(dataDir, matrixId, current => {
          if (!current.error) {
            current.error = { path: null, message }
            agentEvent(current, `预构建异常：${message}`)
          }
        })
      } catch {}
    }
    return detailOf(dataDir, matrixId, dependencies)
  })
  if (args.background) {
    const matrix = requireMatrix(dataDir, matrixId)
    return { background: true, ...publicMatrix(matrix, loadAll(dataDir)) }
  }
  return task
}

/**
 * 修复单个节点：不改 DAG 类型与契约，只替换实现并刷新 definition。
 * 可直接给 script 代码（agent 自己改产物），也可给修复说明让编码会话重写。
 */
export async function reviseNodeAction(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    settleInvalidQuestions(matrixId, dependencies, '用户已通过面板修复节点，原提问已失效')
    await reviseNodeImplementation({
      dataDir,
      matrixId,
      nodePath: args.node_path || args.path,
      instruction: args.instruction || null,
      code: args.code ?? null,
      runtime: args.runtime || null,
      dependencies,
    })
    return detailOf(dataDir, matrixId, dependencies)
  })
}

export async function retry(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    settleInvalidQuestions(matrixId, dependencies, '用户已通过面板重试预构建，原提问已失效')
    try {
      await retryPrebuild({ dataDir, matrixId, instruction: args.instruction || null, dependencies })
    } catch {}
    return detailOf(dataDir, matrixId, dependencies)
  })
}

export async function accept(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return withMatrixLock(dataDir, matrixId, async () => {
    const matrices = loadAll(dataDir)
    const matrix = matrices.get(matrixId)
    if (!matrix) throw new Error(`matrix 不存在：${matrixId}`)
    const state = deriveState(matrix, matrices)
    if (state !== STATES.RUNNABLE) throw new Error(`当前状态 ${state}，只有 runnable 可以验收`)
    matrix.state = STATES.ACCEPTED
    matrix.accepted_at = new Date().toISOString()
    agentEvent(matrix, '人工验收通过。')
    saveMatrix(dataDir, matrix)
    settleInvalidQuestions(matrixId, dependencies, '用户已通过面板验收，原提问已失效')
    const upgraded = recomputeAncestors(dataDir, matrixId, recomputeAfterChildAccept)
    for (const parentId of upgraded) {
      const parent = loadMatrix(dataDir, parentId)
      agentEvent(parent, `子 matrix ${matrix.name}（${matrix.id}）已验收，当前可运行。`, { child_id: matrix.id })
      saveMatrix(dataDir, parent)
    }
    // stub 根 matrix 验收后，反向重算依赖它的 interact / 其它 stub matrix
    const currentMatrices = loadAll(dataDir)
    const dependents = [...currentMatrices.values()]
      .filter(item => (item.domain_dependencies || []).includes(matrixId))
    const upgradedDependents = []
    let progressed = true
    while (progressed) {
      progressed = false
      for (const dependent of dependents) {
        if (!recomputeAfterChildAccept(dependent, currentMatrices)) continue
        agentEvent(dependent, `领域依赖 ${matrix.name}（${matrix.id}）已验收，当前可运行。`, { dependency_id: matrix.id })
        saveMatrix(dataDir, dependent)
        upgradedDependents.push(dependent.id)
        progressed = true
      }
    }
    await autoCheckpoint(dataDir, matrix.project_id, `验收 matrix ${matrix.name}`, dependencies)
    return {
      ...(await detailOf(dataDir, matrixId, dependencies)),
      upgraded_parents: upgraded,
      upgraded_dependents: upgradedDependents,
    }
  })
}

export async function run(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    const matrices = loadAll(dataDir)
    const matrix = matrices.get(matrixId)
    if (!matrix) throw new Error(`matrix 不存在：${matrixId}`)
    const state = deriveState(matrix, matrices)
    if (state !== STATES.RUNNABLE) throw new Error(`当前状态 ${state}，只有 runnable 可以运行`)
    settleInvalidQuestions(matrixId, dependencies, '用户已通过面板启动运行，原提问已失效')
    const executed = await runMatrix(dataDir, matrixId, {
      input: 'input' in args ? args.input : undefined,
      dependencies,
    })
    await autoCheckpoint(dataDir, matrix.project_id, `运行 matrix ${matrix.name}`, dependencies)
    return { ...(await detailOf(dataDir, matrixId, dependencies)), executed }
  })
}

export async function evaluate(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    const matrices = loadAll(dataDir)
    const state = deriveState(matrix, matrices)
    if (![STATES.RUNNABLE, STATES.ACCEPTED].includes(state)) {
      throw new Error(`当前状态 ${state} 不允许评估`)
    }
    const runs = listRuns(dataDir, matrixId)
    const run = args.run_id
      ? loadRun(dataDir, args.run_id)
      : runs.find(item => item.status === 'completed') || runs[0]
    if (!run) throw new Error('该 matrix 还没有运行记录')
    if (run.matrix_id !== matrixId) throw new Error('运行不属于该 matrix')
    const evaluation = await evaluateRun(run, matrix.acceptance_criteria, dependencies)
    matrix.evaluation = { ...evaluation, run_id: run.id, evaluated_at: new Date().toISOString() }
    agentEvent(matrix, `评估运行 ${run.id}：${evaluation.passed ? '通过' : '未通过'}${evaluation.gaps.length ? `（${evaluation.gaps.join('；')}）` : ''}`)
    saveMatrix(dataDir, matrix)
    settleInvalidQuestions(matrixId, dependencies, '用户已通过面板完成评估，原提问已失效')
    return { ...(await detailOf(dataDir, matrixId, dependencies)), evaluation: matrix.evaluation, run: runSummary(run) }
  })
}

/**
 * 监督分析：只读骨架/定义/运行轨迹，产出结论与建议，不改变门禁状态。
 */
export async function supervise(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    const matrices = loadAll(dataDir)
    const state = deriveState(matrix, matrices)
    const runs = listRuns(dataDir, matrixId)
    const run = args.run_id ? loadRun(dataDir, args.run_id) : runs[0]
    if (run && run.matrix_id !== matrixId) throw new Error('运行不属于该 matrix')
    const result = await analyzeRun({
      task: matrix.task,
      state,
      instruction: args.instruction || null,
      definition: matrix.definition,
      skeletonSummary: matrix.skeleton?.summary || null,
      runs: run ? [run] : [],
    }, dependencies)
    matrix.supervision = { ...result, run_id: run?.id || null, at: new Date().toISOString() }
    agentEvent(matrix, `监督结论：${result.conclusion}${result.suggestions.length ? `\n建议：${result.suggestions.join('；')}` : ''}`)
    saveMatrix(dataDir, matrix)
    return { ...(await detailOf(dataDir, matrixId, dependencies)), supervision: matrix.supervision }
  })
}

/**
 * 人工恢复：向 waiting_human 的运行注入输入并继续。
 */
export async function resume(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    requireMatrix(dataDir, matrixId)
    const target = args.run_id
      ? loadRun(dataDir, args.run_id)
      : listRuns(dataDir, matrixId).find(run => run.status === 'waiting_human')
    if (!target) throw new Error('该 matrix 没有等待人工的运行')
    if (target.matrix_id !== matrixId) throw new Error('运行不属于该 matrix')
    const advanced = await resumeMatrixRun(dataDir, matrixId, target.id, { input: args.input, dependencies })
    return { ...(await detailOf(dataDir, matrixId, dependencies)), resumed: runSummary(advanced) }
  })
}

export async function cancel(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return withMatrixLock(dataDir, matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    if (isTerminalState(matrix.state)) throw new Error(`当前状态 ${matrix.state} 不可终止`)
    // 一并终止该 matrix 下仍在运行/等待的运行及其子运行，避免孤儿进程
    for (const run of listRuns(dataDir, matrixId)) {
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
        terminateRun(dataDir, run.id, args.reason || 'matrix cancelled')
      }
    }
    matrix.state = STATES.CANCELLED
    agentEvent(matrix, `人工终止${args.reason ? `：${args.reason}` : ''}`)
    saveMatrix(dataDir, matrix)
    settleInvalidQuestions(matrixId, dependencies, 'matrix 已终止，原提问已失效')
    return detailOf(dataDir, matrixId, dependencies)
  })
}

export async function get(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return detailOf(dataDir, matrixId, dependencies)
}

export function tree(args = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const matrices = loadAll(dataDir)
  const rootId = String(args.root_id || '').trim()
  const projectId = String(args.project_id || '').trim() || null
  const includeArchived = args.include_archived === true
  if (rootId) {
    assertMatrixId(rootId)
    if (!matrices.has(rootId)) throw new Error(`matrix 不存在：${rootId}`)
    return { roots: [treeView(rootId, matrices)], focus: rootId, project_id: matrices.get(rootId).project_id || null }
  }
  const roots = [...matrices.values()]
    .filter(matrix => !matrix.parent_id
      && (!projectId || matrix.project_id === projectId)
      && (includeArchived || !matrix.archived_at))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(matrix => treeView(matrix.id, matrices))
  return { roots, focus: null, project_id: projectId }
}

export function nav(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const matrices = loadAll(dataDir)
  const matrix = matrices.get(matrixId)
  if (!matrix) throw new Error(`matrix 不存在：${matrixId}`)
  return {
    current: matrixId,
    breadcrumb: breadcrumb(matrixId, matrices),
    parent: matrix.parent_id,
    next: nextUnaccepted({ currentId: matrixId, matrices }),
  }
}

export function list(args = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const projectId = String(args.project_id || '').trim() || null
  const includeArchived = args.include_archived === true
  const matrices = loadAll(dataDir)
  // 归档以根为单位：整棵子树从活跃列表移出；显式 include_archived 才全量返回
  const archivedRoots = new Set([...matrices.values()]
    .filter(matrix => !matrix.parent_id && matrix.archived_at)
    .map(matrix => matrix.id))
  const rows = [...matrices.values()]
    .filter(matrix => !projectId || matrix.project_id === projectId)
    .filter(matrix => includeArchived || !archivedRoots.has(matrix.root_id || matrix.id))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map(matrix => publicMatrix(matrix, matrices))
    .map(matrix => ({
      id: matrix.id,
      name: matrix.name,
      state: matrix.state,
      parent_id: matrix.parent_id,
      root_id: matrix.root_id,
      project_id: matrix.project_id,
      archived_at: matrix.archived_at,
      depth: matrix.depth,
      runnable: matrix.runnable,
      updated_at: matrix.updated_at,
    }))
  return {
    total: rows.length,
    matrices: rows,
    tree: tree({ data_dir: args.data_dir, project_id: projectId, include_archived: includeArchived }),
  }
}

/**
 * 统一输入框：按当前状态路由到 answer / revise / retry / 监督。
 */
export async function submitInput(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const text = String(args.text || '').trim()
  if (!text) throw new Error('text 不能为空')
  const matrix = requireMatrix(dataDir, matrixId)
  const routing = inputRouting(deriveState(matrix, loadAll(dataDir)))
  if (routing.target === 'answer') return answer({ data_dir: args.data_dir, matrix_id: matrixId, answer: text }, dependencies)
  if (routing.target === 'revise') return revise({ data_dir: args.data_dir, matrix_id: matrixId, instruction: text }, dependencies)
  if (routing.target === 'retry') return retry({ data_dir: args.data_dir, matrix_id: matrixId, instruction: text }, dependencies)
  if (routing.target === 'mail') {
    return withMatrixLock(dataDir, matrixId, async () => {
      const current = requireMatrix(dataDir, matrixId)
      chatMessage(current, 'user', text)
      current.instructions = [...(current.instructions || []), { text, at: new Date().toISOString() }].slice(-20)
      agentEvent(current, '指令已记录，将在下一次节点会话注入。')
      saveMatrix(dataDir, current)
      return detailOf(dataDir, matrixId, dependencies)
    })
  }
  return withMatrixLock(dataDir, matrixId, async () => {
    const current = requireMatrix(dataDir, matrixId)
    chatMessage(current, 'user', text)
    saveMatrix(dataDir, current)
  }).then(() => supervise({ data_dir: args.data_dir, matrix_id: matrixId, instruction: text }, dependencies))
}

export async function mail(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return withMatrixLock(dataDir, matrixId, async () => {
    const matrices = loadAll(dataDir)
    const matrix = matrices.get(matrixId)
    if (!matrix) throw new Error(`matrix 不存在：${matrixId}`)
    if (args.action === 'inbox') {
      const box = mailboxInbox(matrix, { markRead: args.mark_read !== false })
      saveMatrix(dataDir, matrix)
      return box
    }
    if (args.action === 'reply') {
      const result = replyMail(matrices, matrix, { mailId: args.mail_id || args.reply_to, body: args.body })
      saveMatrix(dataDir, matrix)
      const target = matrices.get(result.answer.to)
      if (target) saveMatrix(dataDir, target)
      return { mail: result.mail, answer: result.answer }
    }
    if (!args.to_matrix && !args.to) throw new Error('send 必须提供 to_matrix')
    const mail = sendMail(matrices, {
      from: matrixId,
      to: args.to_matrix || args.to,
      kind: args.kind,
      subject: args.subject,
      body: args.body,
      refs: args.refs,
      requires_reply: args.requires_reply,
      reply_to: args.reply_to,
    })
    saveMatrix(dataDir, matrix)
    const target = matrices.get(mail.to)
    if (target) saveMatrix(dataDir, target)
    return mail
  })
}

export function runs(args = {}) {
  const dataDir = dataDirOf(args)
  return { runs: listRuns(dataDir, args.matrix_id ? assertMatrixId(args.matrix_id) : null).map(runSummary) }
}

export function runDetail(args = {}) {
  const dataDir = dataDirOf(args)
  const run = loadRun(dataDir, args.run_id)
  return { ...run, summary: runSummary(run) }
}

const ARTIFACT_TEXT_LIMIT = 400 * 1024

function listFiles(root, dir = root, prefix = '') {
  if (!existsSync(dir)) return []
  const rows = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      rows.push(...listFiles(root, full, rel))
      continue
    }
    try {
      rows.push({ path: rel, size: statSync(full).size })
    } catch {}
  }
  return rows
}

/**
 * 运行产物与日志：不给 path 返回文件清单 + run.log；给 path 返回该文件内容（按目录边界校验）。
 */
export function runArtifacts(args = {}) {
  const dataDir = dataDirOf(args)
  const run = loadRun(dataDir, args.run_id)
  const dir = run.artifacts_dir || join(dataDir, 'runs', run.id)
  const requested = String(args.path || '').trim()
  if (requested) {
    const base = resolve(dir)
    const target = resolve(base, requested)
    const rel = relative(base, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('产物路径越界')
    }
    if (!existsSync(target) || statSync(target).isDirectory()) throw new Error(`产物不存在：${requested}`)
    const buffer = readFileSync(target)
    const text = buffer.length > ARTIFACT_TEXT_LIMIT
      ? `${buffer.slice(0, ARTIFACT_TEXT_LIMIT).toString('utf8')}\n…（已截断，共 ${buffer.length} 字节）`
      : buffer.toString('utf8')
    return { run_id: run.id, path: requested, size: buffer.length, content: text }
  }
  const logFile = join(dir, 'run.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  return { run_id: run.id, dir, files: listFiles(dir), log }
}

/** 切换运行 I/O 模式：files（文件式产物）| inline（仅 stdin/stdout）。 */
export async function setExecutionMode(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const mode = String(args.execution_mode || args.mode || '').trim()
  if (!['files', 'inline'].includes(mode)) throw new Error('execution_mode 只能是 files 或 inline')
  return withMatrixLock(dataDir, matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    matrix.execution_mode = mode
    agentEvent(matrix, `运行 I/O 模式切换为 ${mode}`)
    saveMatrix(dataDir, matrix)
    return detailOf(dataDir, matrixId, dependencies)
  })
}

export async function ensureSession(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return withMatrixLock(dataDir, matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    await ensureMatrixSession(matrix, { ...dependencies, dataDir })
    saveMatrix(dataDir, matrix)
    return { matrix_id: matrix.id, dsh_session_id: matrix.dsh_session_id, cwd: matrix.cwd }
  })
}

/** 列出 matrix 绑定会话中已完成的对话轮次，作为撤回点。 */
export async function rewindPoints(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const matrix = requireMatrix(dataDir, matrixId)
  if (!matrix.dsh_session_id) return { matrix_id: matrixId, session_id: null, points: [], running: false }
  if (typeof dependencies.rewindPoints !== 'function') throw new Error('宿主未注入会话撤回能力')
  return {
    matrix_id: matrixId,
    ...(await dependencies.rewindPoints({ matrixId, sessionId: matrix.dsh_session_id })),
  }
}

/**
 * 会话撤回：从某个已完成轮次分叉出新会话，matrix 绑定切到新分支。
 * 归档与消息时间线回退到该轮结束时刻；matrix 的门禁状态与运行记录不变。
 */
export async function rewindSession(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  return enqueue(matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    if (!matrix.dsh_session_id) throw new Error('matrix 还没有 dsh 会话，不能撤回')
    const atSeq = Number(args.at_seq)
    if (!Number.isInteger(atSeq) || atSeq < 0) throw new Error('at_seq 必须是已完成的对话轮次边界')
    if (typeof dependencies.forkMatrixSession !== 'function') throw new Error('宿主未注入会话撤回能力')

    const forked = await dependencies.forkMatrixSession({
      matrixId,
      sessionId: matrix.dsh_session_id,
      atSeq,
      title: matrix.name,
      task: matrix.task,
    })
    const cutoff = String(forked.at || '')
    const keep = value => !value || !cutoff || String(value) <= cutoff
    matrix.archive = (matrix.archive || []).filter(entry => keep(entry.at))
    matrix.messages = (matrix.messages || []).filter(message => keep(message.at))

    const previous = matrix.dsh_session_id
    matrix.dsh_session_id = forked.session_id
    // 新会话已经继承到撤回点，后续只从分叉标记之后同步会话事件
    matrix.dsh_event_seq = Number(forked.at_seq) + 1
    matrix.archive_seq = (matrix.archive.at(-1)?.seq || 0)
    matrix.message_seq = (matrix.messages.at(-1)?.seq || 0)
    matrix.dsh_mirror_seq = matrix.archive_seq
    matrix.rewind_history = [
      ...(matrix.rewind_history || []),
      {
        from_session: previous,
        to_session: forked.session_id,
        at_seq: Number(forked.at_seq),
        at: forked.at,
        created_at: new Date().toISOString(),
      },
    ].slice(-20)

    agentEvent(matrix, `会话已撤回到 ${forked.at} 所在轮次，后续对话从新分支继续。`, {
      rewind: { from_session: previous, to_session: forked.session_id, at_seq: Number(forked.at_seq) },
    })
    // 撤回标记本身不需要回灌到新会话，避免重复上下文
    matrix.dsh_mirror_seq = matrix.archive_seq
    saveMatrix(dataDir, matrix)
    return detailOf(dataDir, matrixId, dependencies)
  })
}

/**
 * 面板输入：写进 matrix 归档，再交给绑定的 dsh agent 做意图识别与工具调用。
 * 不在 HTTP 里等待 agent 跑完；assistant 输出由 detailOf 从会话增量归档。
 */
export async function chat(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const text = String(args.text || '').trim()
  if (!text) throw new Error('text 不能为空')
  // 用文件锁而不是推进队列：预构建等长任务占着队列时，面板输入仍要能立刻送达 agent
  const prepared = await withMatrixLock(dataDir, matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    await ensureMatrixSession(matrix, { ...dependencies, dataDir })
    chatMessage(matrix, 'user', text, { source: 'panel' })
    archiveEntry(matrix, { type: 'action', source: 'panel', text: 'chat', data: { text } })
    saveMatrix(dataDir, matrix)
    return { sessionId: matrix.dsh_session_id, cwd: matrix.cwd, title: matrix.name, task: matrix.task }
  })
  if (prepared.sessionId && typeof dependencies.matrixChat === 'function') {
    const delivery = await dependencies.matrixChat({
      sessionId: prepared.sessionId,
      matrixId,
      text,
      dataDir,
      cwd: prepared.cwd,
      title: prepared.title,
      task: prepared.task,
    })
    if (delivery && delivery.recreated) {
      // 会话日志丢失后重建了空会话：重置归档游标，否则新会话的回复会被旧游标跳过
      try {
        await updateMatrix(dataDir, matrixId, current => {
          current.dsh_event_seq = 0
          current.dsh_mirror_seq = current.archive_seq || 0
          agentEvent(current, '绑定的 dsh 会话已丢失并重建；历史归档保留，新会话语境从当前消息开始。')
          current.dsh_mirror_seq = current.archive_seq
        })
      } catch {}
    }
  }
  return detailOf(dataDir, matrixId, dependencies)
}

/**
 * 新建后的自动推进：把一条隐藏指令发给绑定 agent。
 * 用户只输入第一句需求，后续由 agent 决定生成 DAG 还是先澄清。
 */
export async function kickoff(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args, context)
  const prepared = await withMatrixLock(dataDir, matrixId, async () => {
    const matrix = requireMatrix(dataDir, matrixId)
    await ensureMatrixSession(matrix, { ...dependencies, dataDir })
    archiveEntry(matrix, { type: 'action', source: 'panel', text: 'kickoff' })
    saveMatrix(dataDir, matrix)
    return {
      sessionId: matrix.dsh_session_id,
      cwd: matrix.cwd,
      title: matrix.name,
      task: matrix.task,
      state: matrix.state,
    }
  })
  if (prepared.state !== STATES.AWAITING_REQUIREMENT || !prepared.sessionId) {
    return detailOf(dataDir, matrixId, dependencies)
  }
  if (typeof dependencies.matrixChat === 'function') {
    await dependencies.matrixChat({
      sessionId: prepared.sessionId,
      matrixId,
      text: `需求已受理且信息足够。请直接调用 matrix_generate_dag 生成骨架 DAG，然后用一两句话向用户说明节点结构与下一步；不要调用 matrix_confirm_dag。`,
      dataDir,
      cwd: prepared.cwd,
      title: prepared.title,
      task: prepared.task,
    })
  }
  return detailOf(dataDir, matrixId, dependencies)
}

/**
 * 记录面板上的确定性动作，写入 archive，便于审计“谁在什么状态点了什么”。
 * 同时写入所属项目的操作日志，便于跨 matrix 追踪。
 */
export async function recordAction(args = {}) {
  const dataDir = dataDirOf(args)
  const matrixId = matrixIdOf(args)
  const matrix = await updateMatrix(dataDir, matrixId, current => {
    archiveEntry(current, {
      type: 'action',
      source: 'panel',
      text: String(args.action || ''),
      data: { action: args.action, args: args.args || null, ok: args.ok !== false, error: args.error || null },
    })
  })
  await logProjectOperation(dataDir, matrix.project_id, {
    action: `matrix_${String(args.action || 'action')}`,
    target_type: 'matrix',
    target_id: matrix.id,
    target_name: matrix.name,
    ok: args.ok !== false,
    error: args.error || null,
    detail: { args: args.args || null },
    source: 'panel',
  })
  return matrix
}
