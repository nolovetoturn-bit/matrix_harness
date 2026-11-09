import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, isAbsolute, resolve as resolvePath } from 'node:path'
import {
  advanceRun, assertExecutable, collectBuildPlaceholders, hashNode, replaceBuildPlaceholder,
  validateDefinition, validateInput,
} from './runner.mjs'
import { analyzeRequirement, analyzeRun, evaluateRun, planDefinition } from './ai.mjs'
import { createLlmExecutor } from './llm.mjs'
import {
  listRuns, listSessions, loadRun, loadSession, resolveDataDir, runSummary, saveRun, saveSession,
  sessionExists, sessionSummary, withRunLock, withSessionLock,
  definitionExists, listDefinitionRecords, loadDefinitionRecord, saveDefinition,
  saveBuild, loadBuild, buildExists, deleteBuild, appendMail, loadMailbox,
  saveBuildStack, loadBuildStack,
} from './store.mjs'
import {
  applyBuildResult, assertPlaceholderLayers, backfillBuildChild, buildLayerBudget, buildLayersOf, buildLimits,
  compileBuildDefinition, createBuildState, describeBuild, handoffTask,
  findBuildNode, nextBuildTarget, pendingChildPlaceholders, repairFailedNode, resetNodeForRebuild, runNodeSession,
} from './build.mjs'

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => value === undefined ? null : structuredClone(value)
const now = () => new Date().toISOString()
const MAX_CLARIFY_ROUNDS = 3

function newRunId() {
  const time = now().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `flow-${time}-${randomUUID().slice(0, 8)}`
}

function newSessionId() {
  const time = now().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `sess-${time}-${randomUUID().slice(0, 8)}`
}

function sessionIdOf(args) {
  const value = String(args.session_id || args.parent_session_id || '').trim()
  if (!value) return newSessionId()
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('session_id 只能包含字母、数字、下划线和连字符')
  return value
}

function resolveWorkspace(dataDir, sessionId, value) {
  const configured = String(value ?? '').trim()
  if (!configured) return join(dataDir, 'workspaces', String(sessionId || 'default'))
  return resolvePath(configured)
}

async function ensureWorkspace(path) {
  if (path) await mkdir(path, { recursive: true })
  return path
}

async function alignSession(session, dependencies = {}, mirrorId = session.id, parentDshSessionId = null) {
  let prepared = { path: session.workspace, workspace_id: null }
  if (typeof dependencies.workspaceProvider?.ensure === 'function') {
    prepared = await dependencies.workspaceProvider.ensure({ path: session.workspace, title: session.name })
  } else {
    await ensureWorkspace(session.workspace)
  }
  session.workspace = prepared.path
  session.workspace_id = prepared.workspace_id || null
  if (typeof dependencies.sessionMirror === 'function') {
    const mirrored = await dependencies.sessionMirror({
      sessionId: mirrorId,
      workspace: session.workspace,
      title: session.name,
      task: session.task,
      // 子会话镜像挂到父镜像下，dsh 侧栏按 parentSession 渲染成树
      ...(parentDshSessionId ? { parentSessionId: parentDshSessionId } : {}),
    })
    session.dsh_session_id = mirrored.session_id
    session.workspace = mirrored.path || session.workspace
    session.workspace_id = mirrored.workspace_id || session.workspace_id
  } else if (!session.dsh_session_id) {
    session.dsh_session_id = null
  }
  return session
}

function subflowMaxDepth() {
  const value = Number(process.env.RMS_FLOW_SUBFLOW_MAX_DEPTH || 16)
  return Number.isInteger(value) && value >= 1 && value <= 32 ? value : 16
}

function normalizeRef(ref) {
  if (typeof ref === 'string') return { name: ref.trim(), version: null }
  return { name: String(ref?.name || '').trim(), version: ref?.version ?? null }
}

function resolveDefinition(dataDir, ref) {
  const normalized = normalizeRef(ref)
  if (!normalized.name) throw new Error('subflow.ref 不能为空')
  const record = loadDefinitionRecord(dataDir, normalized.name)
  const version = normalized.version ?? record.active_version
  const entry = (record.versions || []).find(item => item.version === version)
  if (!entry) throw new Error(`工作流定义 ${normalized.name} 没有版本 ${version}`)
  return { definition: clone(entry.definition), key: `${normalized.name}@${version}` }
}

function resolveSubflowWorkspace(parentWorkspace, node) {
  const configured = String(node.workspace || '').trim()
  if (!configured) return parentWorkspace || null
  return isAbsolute(configured) ? configured : resolvePath(parentWorkspace || process.cwd(), configured)
}

function createSubflowExecutor(dataDir, dependencies = {}) {
  return async ({ node, input, path, parent }) => {
    const depth = (parent.depth || 0) + 1
    const maxDepth = subflowMaxDepth()
    if (depth > maxDepth) {
      throw new Error(`子流程深度 ${depth} 超过上限 ${maxDepth}（RMS_FLOW_SUBFLOW_MAX_DEPTH）`)
    }
    if (node.definition === undefined && node.ref === undefined) {
      throw new Error(`子流程节点 ${node.id} 仍是 build 占位，必须先完成构建才能执行`)
    }
    const resolved = node.definition !== undefined
      ? { definition: clone(node.definition), key: `inline:${hashNode(node.definition)}` }
      : resolveDefinition(dataDir, node.ref)
    const definition = resolved.definition
    validateDefinition(definition)
    const chain = Array.isArray(parent.subflow_chain) ? parent.subflow_chain : []
    if (chain.includes(resolved.key) && !node.recursion) {
      throw new Error(`检测到递归引用 ${resolved.key}；确需递归请在 subflow 节点设置 recursion: true`)
    }
    const childInput = validateInput(definition, input)
    const workspace = resolveSubflowWorkspace(parent.workspace, node)
    await ensureWorkspace(workspace)
    const child = makeRunRecord({
      parent_session_id: parent.parent_session_id,
      workspace,
      workspace_id: workspace === parent.workspace ? parent.workspace_id || null : null,
      dsh_session_id: workspace === parent.workspace ? parent.dsh_session_id || null : null,
      name: `${parent.name} / ${node.label || node.id}`,
      definition,
      input: childInput,
      fuel: node.fuel ?? 100,
      status: 'running',
    })
    child.parent_run_id = parent.id
    child.parent_node_id = node.id
    child.parent_path = path
    child.root_run_id = parent.root_run_id || parent.id
    child.depth = depth
    child.subflow_chain = [...chain, resolved.key]
    child.definition_ref = resolved.key
    child.supervision = { enabled: false }
    appendMessage(child, 'system', `由父运行 ${parent.id} 的子流程节点 ${node.id} 创建`)
    saveRun(dataDir, child)
    const advanced = await withRunLock(dataDir, child.id, () => advanceAndSave(dataDir, child, dependencies))
    return {
      run_id: advanced.id,
      status: advanced.status,
      output: advanced.output,
      error: advanced.error,
      pending: advanced.pending,
      depth,
    }
  }
}

function makeSessionRecord(args, dataDir) {
  const task = String(args.task || '').trim()
  if (!task) throw new Error('task 不能为空')
  const createdAt = now()
  const id = sessionIdOf(args)
  return {
    version: 1,
    id,
    parent_session_id: args.session_parent || null,
    root_session_id: id,
    depth: Number.isInteger(args.session_depth) ? args.session_depth : 0,
    origin: args.origin || null,
    mail_read: [],
    task,
    name: String(args.name || task.slice(0, 48) || '未命名会话').trim(),
    status: 'intake',
    round: 0,
    workspace: resolveWorkspace(dataDir, id, args.workspace),
    workspace_id: null,
    workspace_revision: 0,
    dsh_session_id: null,
    input: hasOwn(args, 'input') ? clone(args.input) : null,
    fuel: args.fuel ?? null,
    experience_query: String(args.experience_query || '').trim() || null,
    clarifications: [],
    assumptions: [],
    acceptance_criteria: [],
    analysis: null,
    plan: null,
    error: null,
    draft_run_id: null,
    active_run_id: null,
    evaluations: [],
    messages: [],
    revisions: [],
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function appendSessionMessage(session, role, text, extra = {}) {
  if (!session.messages) session.messages = []
  const message = {
    id: `smsg-${randomUUID().slice(0, 8)}`,
    role,
    text: String(text || ''),
    created_at: now(),
    ...extra,
  }
  session.messages.push(message)
  return message
}

function saveSessionState(dataDir, session) {
  session.updated_at = now()
  saveSession(dataDir, session)
  return session
}

function clarificationPairs(session) {
  return (session.clarifications || []).map(item => ({ question: item.question, answer: item.answer }))
}

function criteriaOf(session) {
  if ((session.acceptance_criteria || []).length) return session.acceptance_criteria
  return [`任务目标已达成：${session.task}`, '运行正常结束且输出可用于判断任务完成']
}

function addAssumptions(session, values) {
  for (const value of values || []) {
    const text = String(value || '').trim()
    if (text && !session.assumptions.includes(text)) session.assumptions.push(text)
  }
}

const MAIL_KINDS = new Set(['context', 'question', 'bug_report', 'answer', 'note'])
const MAIL_BODY_LIMIT = 8000
const MAIL_INJECT_LIMIT = 5

function sessionMaxDepth() {
  const value = Number(process.env.RMS_FLOW_SESSION_MAX_DEPTH || 4)
  return Number.isInteger(value) && value >= 1 && value <= 32 ? value : 4
}

const sessionRoot = session => session.root_session_id || session.id

function unreadMails(dataDir, session) {
  const read = new Set(session.mail_read || [])
  return loadMailbox(dataDir, session.id).filter(mail => !read.has(mail.id))
}

function pendingHumans(dataDir, sessionId, runs) {
  const found = []
  if (buildExists(dataDir, sessionId)) {
    const build = loadBuild(dataDir, sessionId)
    if (build.human) {
      found.push({
        session_id: sessionId,
        kind: 'build_human',
        build_id: build.id,
        request_id: build.human.request_id,
        path: build.human.path,
        node_id: build.human.node_id,
        question: build.human.question,
        options: build.human.options || [],
        suggested_zoom: build.human.suggested_zoom || null,
      })
    }
  }
  for (const run of runs) {
    if (run.parent_session_id !== sessionId || run.status !== 'waiting_human') continue
    if (run.pending?.subflow_run_id) continue
    found.push({
      session_id: sessionId,
      kind: 'run_human',
      run_id: run.id,
      path: run.pending?.path || run.current?.path || null,
      node_id: run.pending?.node_id || run.current?.node_id || null,
      question: run.pending?.prompt || null,
    })
  }
  return found
}

function descendantSessions(allSessions, sessionId) {
  const childrenOf = new Map()
  for (const item of allSessions) {
    if (!item.parent_session_id) continue
    if (!childrenOf.has(item.parent_session_id)) childrenOf.set(item.parent_session_id, [])
    childrenOf.get(item.parent_session_id).push(item)
  }
  const out = []
  const seen = new Set()
  const queue = [...(childrenOf.get(sessionId) || [])]
  while (queue.length) {
    const item = queue.shift()
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
    queue.push(...(childrenOf.get(item.id) || []))
  }
  return out
}

function pointerOf(human) {
  if (!human) return null
  return {
    kind: human.kind,
    path: human.path,
    node_id: human.node_id,
    run_id: human.run_id || null,
    build_id: human.build_id || null,
    request_id: human.request_id || null,
    question: human.question,
  }
}

function buildStackView(dataDir, session) {
  const stack = loadBuildStack(dataDir, session.root_session_id || session.id)
  if (!stack) return null
  return {
    root_session_id: stack.root_session_id,
    status: stack.status,
    entries: summarizeStack(dataDir, stack),
    updated_at: stack.updated_at,
  }
}

function buildStateView(dataDir, sessionId, detailed = false) {
  if (!buildExists(dataDir, sessionId)) return null
  const view = describeBuild(loadBuild(dataDir, sessionId))
  if (detailed) return view
  return {
    build_id: view.build_id,
    status: view.status,
    run_id: view.run_id,
    progress: view.progress,
    current_node: view.current_node,
    human: view.human,
    error: view.error,
    updated_at: view.updated_at,
  }
}

function sessionView(dataDir, sessionId) {
  const session = loadSession(dataDir, sessionId)
  const allSessions = listSessions(dataDir)
  const allRuns = listRuns(dataDir)
  const children = allSessions
    .filter(item => item.parent_session_id === session.id)
    .map(item => ({
      ...sessionSummary(item),
      build: buildStateView(dataDir, item.id),
      unread_mail: unreadMails(dataDir, item).length,
      pending_human: pointerOf(pendingHumans(dataDir, item.id, allRuns)[0]),
    }))
  const mails = loadMailbox(dataDir, session.id)
  const unread = unreadMails(dataDir, session)
  const runs = allRuns.filter(run => run.parent_session_id === session.id)
  const ownHumans = pendingHumans(dataDir, session.id, allRuns)
  const delegated = descendantSessions(allSessions, session.id).flatMap(item =>
    pendingHumans(dataDir, item.id, allRuns).map(human => ({
      ...human,
      depth: item.depth || 0,
      session_name: item.name,
    })))
  const build = buildStateView(dataDir, session.id, true)
  const messages = new Map()
  const actions = new Map()
  for (const message of session.messages || []) {
    messages.set(message.id, { ...message, session_id: session.id })
  }
  for (const run of runs) {
    for (const message of run.messages || []) {
      if (!messages.has(message.id)) messages.set(message.id, {
        ...message, run_id: run.id, definition_version: run.definition_version || 1,
      })
    }
    for (const action of run.pending_actions || []) {
      if (!actions.has(action.id)) actions.set(action.id, {
        ...action, run_id: run.id, definition_version: run.definition_version || 1,
      })
    }
  }
  return {
    session: { ...session, unread_mail: unread.length, pending_human: ownHumans },
    build,
    build_stack: buildStackView(dataDir, session),
    children,
    delegated_human: delegated,
    mail: { unread: unread.length, mails: mails.slice(-20) },
    runs: runs.map(run => {
      const { definition, ...rest } = run
      return {
        ...rest,
        build_placeholders: collectBuildPlaceholders(definition || {}).map(item => ({ node_id: item.node_id, label: item.label })),
      }
    }),
    messages: [...messages.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
    actions: [...actions.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
  }
}

async function planSession(dataDir, session, dependencies, extra = {}) {
  appendSessionMessage(session, 'analyst', '信息已足够，开始生成工作流草稿。')
  session.status = 'planning'
  session.analysis = null
  session.error = null
  saveSessionState(dataDir, session)
  let plan
  try {
    plan = await planDefinition({
      task: session.task,
      name: session.name,
      input: session.input,
      fuel: session.fuel,
      workspace: session.workspace,
      experience_query: session.experience_query,
      instruction: extra.instruction,
      clarifications: clarificationPairs(session),
      assumptions: session.assumptions,
      acceptance_criteria: session.acceptance_criteria,
    }, dependencies)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    session.status = 'plan_failed'
    session.error = { message }
    // 保留上一版草稿引用，让后续成功规划能正常标记 superseded，避免同一会话堆积多个草稿。
    appendSessionMessage(session, 'system', `规划失败：${message}`)
    return saveSessionState(dataDir, session)
  }

  const previous = session.draft_run_id
    ? (() => { try { return loadRun(dataDir, session.draft_run_id) } catch { return null } })()
    : null
  const version = previous ? (previous.definition_version || 1) + 1 : 1
  const run = makeRunRecord({
    parent_session_id: session.id,
    name: session.name,
    task: session.task,
    definition: plan.definition,
    input: plan.input,
    fuel: session.fuel ?? undefined,
    workspace: resolveWorkspace(dataDir, session.id, session.workspace),
    workspace_id: session.workspace_id || null,
    dsh_session_id: session.dsh_session_id || null,
    definition_version: version,
    previous_run_id: previous?.id || null,
    status: 'draft',
    supervision: { enabled: true },
    planner: {
      summary: plan.summary,
      citations: plan.citations,
      retrieval: plan.retrieval,
    },
  })
  if (previous) {
    previous.status = 'superseded'
    previous.superseded_by = run.id
    appendMessage(previous, 'system', `草稿已被 v${version} 替代，未执行任何节点`)
    saveRun(dataDir, previous)
  }
  appendMessage(run, 'planner', plan.summary, { citations: plan.citations })
  addAction(run, 'start', { reason: '确认工作流定义并启动执行' })
  saveRun(dataDir, run)
  session.draft_run_id = run.id
  session.active_run_id = null
  session.plan = {
    summary: plan.summary,
    citations: plan.citations,
    retrieval: plan.retrieval,
  }
  if (plan.acceptance_criteria?.length) session.acceptance_criteria = plan.acceptance_criteria
  else if (!session.acceptance_criteria.length) session.acceptance_criteria = criteriaOf(session)
  session.status = 'awaiting_confirm'
  appendSessionMessage(session, 'planner', plan.summary, { citations: plan.citations, run_id: run.id })
  appendSessionMessage(session, 'system', `草稿 v${version} 已生成，等待确认启动。`, { run_id: run.id })
  const saved = saveSessionState(dataDir, session)
  // 规划完成即为第1层（根层）建独立会话，dsh 侧栏从发起会话一路链到各层；预构建时复用它
  await ensureRootLayerSession(dataDir, run, dependencies, 'awaiting_confirm')
  return saved
}

async function analyzeSession(dataDir, session, dependencies, extra = {}) {
  session.round = (session.clarifications || []).length
  let analysis
  try {
    analysis = await analyzeRequirement({
      task: session.task,
      round: session.round,
      max_rounds: MAX_CLARIFY_ROUNDS,
      clarifications: clarificationPairs(session),
      instruction: extra.instruction,
    }, dependencies)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    appendSessionMessage(session, 'system', `需求分析降级：${message}；按原始任务直接规划。`)
    analysis = {
      sufficient: true,
      missing: [],
      questions: [],
      assumptions: ['需求分析不可用，按原始任务直接规划'],
    }
  }
  addAssumptions(session, analysis.assumptions)
  session.analysis = analysis
  if (!analysis.sufficient && analysis.questions.length && session.round < MAX_CLARIFY_ROUNDS) {
    session.status = 'clarifying'
    appendSessionMessage(session, 'analyst', [
      '信息还不够，需要你补充：',
      ...analysis.missing.map(item => `· ${item}`),
      ...analysis.questions.map((item, index) => `${index + 1}. ${item}`),
    ].join('\n'))
    return saveSessionState(dataDir, session)
  }
  if (!analysis.sufficient) {
    appendSessionMessage(session, 'analyst', `已提出 ${MAX_CLARIFY_ROUNDS} 轮澄清，按现有假设继续规划。`)
  }
  return planSession(dataDir, session, dependencies, extra)
}

export async function intakeFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const session = makeSessionRecord(args, dataDir)
  if (sessionExists(dataDir, session.id)) {
    throw new Error(`会话 ${session.id} 已存在；请使用 flow_answer/flow_revise 继续该会话`)
  }
  await alignSession(session, dependencies)
  saveSession(dataDir, session)
  return withSessionLock(dataDir, session.id, async () => {
    const current = loadSession(dataDir, session.id)
    await analyzeSession(dataDir, current, dependencies)
    return sessionView(dataDir, current.id)
  })
}

export async function answerFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  const answer = String(args.answer || '').trim()
  if (!answer) throw new Error('answer 不能为空')
  let childBuild = false
  const view = await withSessionLock(dataDir, sessionId, async () => {
    const session = loadSession(dataDir, sessionId)
    if (session.status !== 'clarifying') {
      throw new Error(`会话当前为 ${session.status}，不是等待澄清状态`)
    }
    const questions = session.analysis?.questions || []
    session.clarifications.push({
      id: `clar-${randomUUID().slice(0, 8)}`,
      question: questions.join('\n'),
      answer,
      source: 'user',
      asked_at: session.updated_at,
      answered_at: now(),
    })
    session.round = session.clarifications.length
    session.analysis = null
    appendSessionMessage(session, 'user', answer)
    saveSessionState(dataDir, session)
    if (isChildBuildSession(session)) {
      // 子会话澄清后要创建构建（需要再取会话锁），放到锁外推进
      childBuild = true
      return sessionView(dataDir, session.id)
    }
    await analyzeSession(dataDir, session, dependencies)
    return sessionView(dataDir, session.id)
  })
  if (childBuild) {
    await advanceChildRequirement(dataDir, sessionId, dependencies)
    return sessionView(dataDir, sessionId)
  }
  return view
}

// 子会话在 DAG 确认前允许整体修订：丢弃旧骨架，按新需求重新分析并生成新的 DAG
async function reviseChildFlow(dataDir, sessionId, args, dependencies = {}) {
  const instruction = String(args.instruction || '').trim()
  const task = String(args.task || '').trim()
  const name = String(args.name || '').trim()
  if (!task && !name && !instruction) throw new Error('task、name、instruction 至少提供一项')
  let previousDefinition = null
  await withSessionLock(dataDir, sessionId, async () => {
    const current = loadSession(dataDir, sessionId)
    if (buildExists(dataDir, sessionId)) {
      const build = loadBuild(dataDir, sessionId)
      if (build.status !== 'awaiting_dag') {
        throw new Error(`子构建当前为 ${build.status}，只有待确认 DAG 阶段可以整体修订`)
      }
      previousDefinition = describeBuild(build).readonly_definition || null
    } else if (!['intake', 'clarifying'].includes(current.status)) {
      throw new Error(`子会话当前为 ${current.status}，只有生成 DAG 前可以修订`)
    }
    const before = current.task
    const buildId = buildExists(dataDir, sessionId) ? loadBuild(dataDir, sessionId).id : null
    if (task) current.task = task
    if (name) current.name = name
    current.revisions.push({
      id: `rev-${randomUUID().slice(0, 8)}`,
      instruction,
      task_before: before,
      task_after: current.task,
      run_id: null,
      build_id: buildId,
      created_at: now(),
    })
    current.analysis = null
    current.status = 'intake'
    appendSessionMessage(current, 'user', instruction || `修订任务：${task || current.task}`)
    saveSessionState(dataDir, current)
    return current
  })
  // 旧骨架只存在于内存文件里，直接丢弃后按修订意见重新分析、重新生成 DAG
  deleteBuild(dataDir, sessionId)
  await advanceChildRequirement(dataDir, sessionId, dependencies, {
    instruction,
    revision: instruction ? { instruction, at: now() } : null,
    previous_definition: previousDefinition,
  })
  const stack = loadBuildStack(dataDir, stackRootOf(dataDir, sessionId))
  if (stack) {
    const entry = stack.entries.find(item => item.session_id === sessionId)
    if (entry) {
      entry.status = stackEntryStatus(dataDir, entry)
      entry.updated_at = now()
      saveStack(dataDir, stack)
    }
    refreshStackStatus(dataDir, stack)
  }
  return sessionView(dataDir, sessionId)
}

export async function reviseFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  if (sessionExists(dataDir, sessionId) && isChildBuildSession(loadSession(dataDir, sessionId))) {
    return reviseChildFlow(dataDir, sessionId, args, dependencies)
  }
  return withSessionLock(dataDir, sessionId, async () => {
    const session = loadSession(dataDir, sessionId)
    if (!['intake', 'clarifying', 'planning', 'plan_failed', 'awaiting_confirm'].includes(session.status)) {
      throw new Error(`会话当前为 ${session.status}，已启动会话的修改必须走验收 replan 确认`)
    }
    const instruction = String(args.instruction || '').trim()
    const task = String(args.task || '').trim()
    const name = String(args.name || '').trim()
    if (!task && !name && !instruction) throw new Error('task、name、instruction 至少提供一项')
    const before = session.task
    if (task) session.task = task
    if (name) session.name = name
    session.revisions.push({
      id: `rev-${randomUUID().slice(0, 8)}`,
      instruction,
      task_before: before,
      task_after: session.task,
      run_id: session.draft_run_id,
      created_at: now(),
    })
    session.status = 'intake'
    session.analysis = null
    appendSessionMessage(session, 'user', instruction || `修订任务：${task || session.task}`)
    saveSessionState(dataDir, session)
    await analyzeSession(dataDir, session, dependencies, { instruction })
    return sessionView(dataDir, session.id)
  })
}

function appendEvaluation(session, run, evaluation) {
  const record = {
    id: `eval-${randomUUID().slice(0, 8)}`,
    run_id: run.id,
    passed: evaluation.passed,
    gaps: evaluation.gaps,
    evidence: evaluation.evidence,
    recommend: evaluation.recommend,
    created_at: now(),
  }
  session.evaluations.push(record)
  appendSessionMessage(session, 'evaluator', [
    evaluation.passed ? '验收通过。' : '验收未通过。',
    ...evaluation.gaps.map(item => `· 缺口：${item}`),
    ...evaluation.evidence.map(item => `· 依据：${item}`),
  ].join('\n'), { run_id: run.id, passed: evaluation.passed })
  return record
}

async function evaluateSession(dataDir, session, run, dependencies) {
  const criteria = criteriaOf(session)
  // 子构建会话的运行是“试运行”：评估只记录结果，不改变构建/验收状态，也不生成 replan
  const childUnit = isChildBuildSession(session)
  const statusBefore = session.status
  const restored = ['built', 'awaiting_confirm', 'accepted'].includes(statusBefore) ? statusBefore : 'built'
  session.status = 'evaluating'
  saveSessionState(dataDir, session)
  let evaluation
  try {
    evaluation = await evaluateRun(run, criteria, dependencies)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    session.status = 'evaluating'
    session.error = { message }
    appendSessionMessage(session, 'system', `验收分析失败：${message}`, { run_id: run.id })
    return saveSessionState(dataDir, session)
  }
  appendEvaluation(session, run, evaluation)
  session.error = null
  if (evaluation.passed) {
    session.status = childUnit ? restored : 'accepted'
    return saveSessionState(dataDir, session)
  }
  if (childUnit) {
    session.status = restored
    appendSessionMessage(session, 'system', '试运行评估未通过；仅作验证参考，不改变该子流程的构建/回填状态', { run_id: run.id })
    return saveSessionState(dataDir, session)
  }
  const instruction = `验收未通过，请针对以下缺口重新规划：${evaluation.gaps.join('；') || '未满足验收标准'}`
  session.status = 'awaiting_confirm'
  try {
    const draft = await planDefinition({
      task: session.task,
      name: session.name,
      instruction,
      input: run.input,
      current_definition: run.definition,
      current_status: run.status,
      clarifications: clarificationPairs(session),
      assumptions: session.assumptions,
      acceptance_criteria: criteria,
    }, dependencies)
    addAction(run, 'replan', { reason: instruction, draft })
    run.updated_at = now()
    saveRun(dataDir, run)
    appendSessionMessage(session, 'system', '已生成待确认的 replan 草稿；确认后才会创建新版本重跑。', { run_id: run.id })
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    session.error = { message }
    appendSessionMessage(session, 'system', `验收后重规划失败：${message}`, { run_id: run.id })
  }
  return saveSessionState(dataDir, session)
}

export async function evaluateFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  let session
  let run
  if (args.run_id) {
    run = loadRun(dataDir, String(args.run_id))
    session = loadSession(dataDir, run.parent_session_id)
  } else {
    const sessionId = String(args.session_id || '').trim()
    if (!sessionId) throw new Error('session_id 或 run_id 必须提供一个')
    session = loadSession(dataDir, sessionId)
    const runId = session.active_run_id || session.draft_run_id
    if (!runId) throw new Error('会话还没有可验收的运行')
    run = loadRun(dataDir, runId)
  }
  if (!['completed', 'failed'].includes(run.status)) {
    throw new Error(`运行当前为 ${run.status}，尚未结束，尚无可验收结果`)
  }
  return withSessionLock(dataDir, session.id, async () => {
    const current = loadSession(dataDir, session.id)
    const currentRun = loadRun(dataDir, run.id)
    await evaluateSession(dataDir, current, currentRun, dependencies)
    return sessionView(dataDir, current.id)
  })
}

async function syncSessionAfterRun(dataDir, run, dependencies, options = {}) {
  if (!sessionExists(dataDir, run.parent_session_id)) return
  let session
  try {
    session = loadSession(dataDir, run.parent_session_id)
  } catch {
    return
  }
  if (run.status === 'superseded') return
  if (run.status === 'draft') {
    session.draft_run_id = run.id
    session.status = 'awaiting_confirm'
    return saveSessionState(dataDir, session)
  }
  session.active_run_id = run.id
  session.draft_run_id = null
  if (['running', 'waiting_human', 'paused'].includes(run.status)) {
    session.status = 'executing'
    return saveSessionState(dataDir, session)
  }
  if (run.status === 'cancelled') {
    session.status = 'cancelled'
    appendSessionMessage(session, 'system', '会话随运行终止而结束。', { run_id: run.id })
    return saveSessionState(dataDir, session)
  }
  if (['completed', 'failed'].includes(run.status) && isChildBuildSession(session)) {
    // 子构建的独立运行只是试运行：回到构建状态，不触发会话级验收/重规划
    const build = buildExists(dataDir, session.id) ? loadBuild(dataDir, session.id) : null
    session.status = build ? (build.status === 'accepted' ? 'built' : build.status) : 'built'
    return saveSessionState(dataDir, session)
  }
  if (['completed', 'failed'].includes(run.status) && options.autoEvaluate !== false) {
    return evaluateSession(dataDir, session, run, dependencies)
  }
  return saveSessionState(dataDir, session)
}

export function getSession(args) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  return sessionView(dataDir, sessionId)
}

export function listSessionGroups(args = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
  const sessions = listSessions(dataDir).slice(0, limit)
  const runs = listRuns(dataDir)
  return {
    total: sessions.length,
    sessions: sessions.map(session => ({
      ...sessionSummary(session),
      build: buildStateView(dataDir, session.id),
      unread_mail: unreadMails(dataDir, session).length,
      runs: runs.filter(run => run.parent_session_id === session.id).map(runSummary),
    })),
  }
}

export function listSessionTree(args = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessions = listSessions(dataDir)
  const runs = listRuns(dataDir)
  const byId = new Map(sessions.map(item => [item.id, item]))
  const childrenOf = new Map()
  for (const session of sessions) {
    const parentId = session.parent_session_id
    if (!parentId || !byId.has(parentId)) continue
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
    childrenOf.get(parentId).push(session)
  }
  const summarize = session => ({
    ...sessionSummary(session),
    build: buildStateView(dataDir, session.id),
    unread_mail: unreadMails(dataDir, session).length,
    pending_human: pointerOf(pendingHumans(dataDir, session.id, runs)[0]),
  })
  const build = (session, seen) => {
    if (seen.has(session.id)) return summarize(session)
    seen.add(session.id)
    return { ...summarize(session), children: (childrenOf.get(session.id) || []).map(child => build(child, seen)) }
  }
  const rootId = String(args.session_id || '').trim()
  if (rootId) {
    const root = byId.get(rootId)
    if (!root) throw new Error(`工作流会话不存在：${rootId}`)
    return { total: 1, roots: [build(root, new Set())] }
  }
  const roots = sessions.filter(session => !session.parent_session_id || !byId.has(session.parent_session_id))
  return { total: sessions.length, roots: roots.map(session => build(session, new Set())) }
}


function fuelValue(args, definition) {
  const value = args.fuel ?? definition?.fuel ?? 100
  if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error('fuel 必须是 1..10000 的整数')
  return value
}

function makeRunRecord(args) {
  const parentSessionId = String(args.parent_session_id || '').trim()
  if (!parentSessionId) throw new Error('parent_session_id 不能为空')
  const definition = args.definition ? clone(args.definition) : null
  const createdAt = now()
  const task = String(args.task || '').trim()
  return {
    version: 1,
    id: newRunId(),
    name: String(args.name || definition?.name || task.slice(0, 48) || '未命名工作流').trim(),
    parent_session_id: parentSessionId,
    workspace: String(args.workspace || '').trim() || null,
    workspace_id: args.workspace_id || null,
    dsh_session_id: args.dsh_session_id || null,
    parent_run_id: null,
    parent_node_id: null,
    parent_path: null,
    root_run_id: null,
    depth: 0,
    subflow_chain: [],
    definition_ref: null,
    task: task || null,
    definition_version: args.definition_version || 1,
    previous_run_id: args.previous_run_id || null,
    superseded_by: null,
    planner: args.planner || null,
    messages: [],
    pending_actions: [],
    supervision: args.supervision || { enabled: false },
    definition,
    input: hasOwn(args, 'input') ? clone(args.input) : null,
    output: null,
    status: args.status || 'running',
    current: null,
    pending: null,
    paused_from: null,
    error: args.error || null,
    fuel: { initial: fuelValue(args, definition), remaining: fuelValue(args, definition) },
    trace: [],
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
  }
}

function appendMessage(run, role, text, extra = {}) {
  if (!run.messages) run.messages = []
  const message = {
    id: `msg-${randomUUID().slice(0, 8)}`,
    role,
    text: String(text || ''),
    created_at: now(),
    ...extra,
  }
  run.messages.push(message)
  return message
}

function saveState(dataDir, run) {
  run.updated_at = now()
  saveRun(dataDir, run)
  return run
}

function addAction(run, type, details = {}) {
  if (!run.pending_actions) run.pending_actions = []
  const action = {
    id: `action-${randomUUID().slice(0, 8)}`,
    type,
    reason: String(details.reason || ''),
    status: 'pending',
    draft: details.draft || null,
    expected: {
      status: run.status,
      current_path: run.current?.path || null,
      definition_version: run.definition_version || 1,
    },
    created_at: now(),
    resolved_at: null,
  }
  run.pending_actions.push(action)
  return action
}

function autoRepairLimit() {
  const value = Number(process.env.RMS_FLOW_AUTO_REPAIR_MAX || 2)
  return Number.isInteger(value) && value >= 0 && value <= 8 ? value : 2
}

function failedScriptTrace(run) {
  const failed = (run.trace || []).filter(entry => entry.status === 'failed' && entry.kind === 'script')
  return [...failed].reverse().find(entry => entry.path === run.error?.path)
    || failed[failed.length - 1]
    || null
}

async function tryAutoRepair(dataDir, run, dependencies) {
  if (run.status !== 'failed' || !run.definition) return null
  const enabled = dependencies.autoRepair === true || dependencies.llm || dependencies.agentRunner
    || dependencies.codingAgentRunner || sessionExists(dataDir, run.parent_session_id)
  if (!enabled) return null
  const failed = failedScriptTrace(run)
  if (!failed) return null
  const history = Array.isArray(run.repairs) ? run.repairs : []
  const limit = autoRepairLimit()
  if (history.length >= limit || run.repair_state?.status === 'exhausted') {
    if (run.repair_state?.status !== 'exhausted') {
      run.repair_state = { status: 'exhausted', attempts: history.length, node_id: failed.node_id }
      appendMessage(run, 'system', `节点 ${failed.node_id} 已自动修复 ${history.length} 次仍失败，转交人工确认重新规划`)
      saveState(dataDir, run)
    }
    return null
  }
  const attempt = history.length + 1
  run.repair_state = { status: 'repairing', attempts: attempt, node_id: failed.node_id, path: failed.path }
  appendMessage(run, 'system', `检测到脚本节点 ${failed.node_id} 失败，开始第 ${attempt}/${limit} 次局部自动修复`)
  saveState(dataDir, run)
  try {
    const repairSessionId = `${run.id}-repair-${attempt}`
    const repaired = await repairFailedNode({
      definition: run.definition,
      node_id: failed.node_id,
      path: failed.path,
      input: failed.input,
      error: failed.error || run.error,
      workspace: run.workspace,
      workspace_id: run.workspace_id,
      sessionId: repairSessionId,
      parentSessionId: run.dsh_session_id || null,
      attempt,
    }, dependencies)
    const next = makeRunRecord({
      parent_session_id: run.parent_session_id,
      workspace: run.workspace,
      workspace_id: run.workspace_id || null,
      dsh_session_id: run.dsh_session_id || null,
      name: run.name,
      task: run.task,
      definition: repaired.definition,
      input: run.input,
      fuel: run.fuel?.initial,
      definition_version: (run.definition_version || 1) + 1,
      previous_run_id: run.id,
      supervision: run.supervision,
      status: 'running',
    })
    next.parent_run_id = run.parent_run_id || null
    next.parent_node_id = run.parent_node_id || null
    next.parent_path = run.parent_path || null
    next.root_run_id = run.root_run_id || run.id
    next.depth = run.depth || 0
    next.subflow_chain = clone(run.subflow_chain || [])
    next.definition_ref = run.definition_ref || null
    const record = {
      from_run_id: run.id,
      to_run_id: next.id,
      node_id: failed.node_id,
      path: failed.path,
      attempt,
      error: clone(failed.error || run.error),
      dsh_session_id: repaired.session?.session_id || null,
      requested_session_id: repairSessionId,
      parent_dsh_session_id: repaired.session?.parent_session_id || run.dsh_session_id || null,
      workspace_id: repaired.session?.workspace_id || run.workspace_id || null,
      created_at: now(),
    }
    next.repairs = [...history, record]
    next.repair_state = {
      status: 'retrying', attempts: attempt, node_id: failed.node_id, path: failed.path,
      repair_session_id: repaired.session?.session_id || null,
    }
    next.repair_of = run.id
    appendMessage(next, 'system', `已根据 ${failed.node_id} 的错误完成第 ${attempt} 次局部修复，自动重跑 v${next.definition_version}`)
    run.repairs = [...history, record]
    run.repair_state = {
      status: 'repaired', attempts: attempt, node_id: failed.node_id, repaired_by: next.id,
      repair_session_id: repaired.session?.session_id || null,
    }
    run.status = 'superseded'
    run.superseded_by = next.id
    appendMessage(run, 'system', `局部修复已生成工作流 v${next.definition_version}，当前版本停止并转入自动重跑`)
    saveState(dataDir, run)
    saveRun(dataDir, next)
    return next
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    run.repair_state = { status: 'failed', attempts: attempt, node_id: failed.node_id, error: message }
    appendMessage(run, 'system', `第 ${attempt} 次局部自动修复未生成有效 IR：${message}；转交人工确认`)
    saveState(dataDir, run)
    return null
  }
}

async function advanceAndSave(dataDir, run, dependencies = {}, options = {}) {
  await ensureWorkspace(run.workspace)
  const result = await advanceRun(run, {
    ...options,
    workspace: run.workspace || null,
    llm: dependencies.llm || createLlmExecutor(),
    agent: dependencies.agentRunner || null,
    tool: dependencies.toolRunner || null,
    subflow: options.subflow || createSubflowExecutor(dataDir, dependencies),
    onChange: current => saveRun(dataDir, current),
  })
  if (result.status === 'completed' && result.repair_state?.status === 'retrying') {
    result.repair_state = { ...result.repair_state, status: 'repaired', completed_at: now() }
    appendMessage(result, 'system', `节点 ${result.repair_state.node_id} 自动修复后重跑成功`)
    saveState(dataDir, result)
  }
  if (result.status === 'failed' && !options.skipAutoRepair) {
    const repaired = await tryAutoRepair(dataDir, result, dependencies)
    if (repaired) return advanceAndSave(dataDir, repaired, dependencies)
  }
  if (!options.skipSupervision && result.supervision?.enabled
    && ['waiting_human', 'failed', 'completed'].includes(result.status)) {
    await superviseAndSave(dataDir, result, '', dependencies, 'automatic')
  }
  return result
}

export async function startFlow(args, dependencies = {}) {
  const definition = clone(args.definition)
  validateDefinition(definition, { allowBuildPlaceholder: true })
  assertExecutable(definition)
  const input = validateInput(definition, hasOwn(args, 'input') ? args.input : undefined)
  const dataDir = resolveDataDir(args.data_dir)
  const run = makeRunRecord({
    ...args,
    definition,
    input,
    workspace: resolveWorkspace(dataDir, args.parent_session_id || args.session_id, args.workspace),
    status: 'running',
  })
  saveRun(dataDir, run)
  return withRunLock(dataDir, run.id, () => advanceAndSave(dataDir, run, dependencies))
}

export async function invokeFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const runId = String(args.run_id || '').trim()
  if (!runId) throw new Error('run_id 不能为空')
  const source = loadRun(dataDir, runId)
  if (!source.definition) throw new Error(`运行 ${runId} 没有可执行的工作流定义（当前为 ${source.status}）`)
  const definition = clone(source.definition)
  validateDefinition(definition, { allowBuildPlaceholder: true })
  assertExecutable(definition)
  const input = validateInput(definition, hasOwn(args, 'input') ? args.input : source.input)
  const parentSessionId = args.parent_session_id || source.parent_session_id
  const workspace = resolveWorkspace(dataDir, source.parent_session_id, args.workspace || source.workspace)
  const sameIdentity = parentSessionId === source.parent_session_id && workspace === source.workspace
  const run = makeRunRecord({
    parent_session_id: parentSessionId,
    workspace,
    workspace_id: sameIdentity ? source.workspace_id || null : null,
    dsh_session_id: sameIdentity ? source.dsh_session_id || null : null,
    name: args.name || source.name,
    task: source.task,
    definition,
    input,
    fuel: args.fuel ?? source.fuel?.initial,
    definition_version: source.definition_version || 1,
    previous_run_id: source.id,
    supervision: { enabled: false },
    status: 'running',
  })
  run.invoked_from = { run_id: source.id, definition_version: source.definition_version || 1 }
  appendMessage(run, 'system', `按入口契约直接运行，来源 ${source.id}（不经过需求分析与规划）`)
  saveRun(dataDir, run)
  return withRunLock(dataDir, run.id, () => advanceAndSave(dataDir, run, dependencies))
}

export async function planFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const task = String(args.task || '').trim()
  if (!task) throw new Error('task 不能为空')
  let plan = null
  let failure = null
  try {
    plan = await planDefinition(args, dependencies)
  } catch (error) {
    failure = error && error.message ? error.message : String(error)
  }
  const run = makeRunRecord({
    ...args,
    task,
    definition: plan?.definition || null,
    input: plan ? plan.input : args.input,
    workspace: resolveWorkspace(dataDir, args.parent_session_id || args.session_id, args.workspace),
    status: plan ? 'draft' : 'plan_failed',
    error: failure ? { message: failure } : null,
    supervision: { enabled: true },
    planner: plan ? {
      summary: plan.summary,
      citations: plan.citations,
      retrieval: plan.retrieval,
    } : { error: failure },
  })
  if (plan) {
    appendMessage(run, 'planner', plan.summary, { citations: plan.citations })
    addAction(run, 'start', { reason: '确认工作流定义并启动执行' })
  } else {
    appendMessage(run, 'system', failure)
  }
  return saveState(dataDir, run)
}

function buildSessionId(args) {
  const value = String(args.session_id || args.parent_session_id || '').trim()
  if (!value) throw new Error('session_id 不能为空')
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('session_id 只能包含字母、数字、下划线和连字符')
  return value
}

function loadBuildOrFail(dataDir, sessionId) {
  try {
    return loadBuild(dataDir, sessionId)
  } catch {
    throw new Error(`构建会话不存在：${sessionId}`)
  }
}

function saveBuildState(dataDir, build) {
  build.updated_at = now()
  saveBuild(dataDir, build)
  return build
}

async function stepBuildState(dataDir, build, dependencies) {
  if (['waiting_human', 'awaiting_confirm', 'awaiting_accept', 'failed', 'waiting_children'].includes(build.status)) return build
  refreshBuildMailbox(dataDir, build)
  const node = nextBuildTarget(build)
  if (!node) {
    // 还有占位在等待子构建回填时不能编译：挂起等构建栈逐个推进
    if (pendingChildPlaceholders(build).length) {
      build.status = 'waiting_children'
      return saveBuildState(dataDir, build)
    }
    return finalizeBuild(dataDir, build)
  }
  if (build.sessions.length >= build.limits.max_sessions) {
    build.status = 'failed'
    build.error = { message: `构建会话数超过上限 ${build.limits.max_sessions}（RMS_FLOW_BUILD_MAX_SESSIONS）` }
    return saveBuildState(dataDir, build)
  }
  node.status = 'building'
  build.current_node = {
    path: node.path,
    node_id: node.id,
    label: node.intent,
    status: 'building',
    started_at: now(),
  }
  build.error = null
  saveBuildState(dataDir, build)
  try {
    const result = await runNodeSession(build, node, dependencies)
    const applied = applyBuildResult(build, node, result)
    build.current_node = null
    if (applied.kind === 'need_human') {
      build.status = 'waiting_human'
      notifyBuildHuman(dataDir, build)
    } else if (applied.kind === 'waiting_children') {
      // 占位不在构建内递归：挂起等构建栈为每个占位开独立子会话构建后回填
      build.status = 'waiting_children'
    }
  } catch (error) {
    node.status = 'failed'
    build.current_node = null
    build.status = 'failed'
    build.error = {
      message: error && error.message ? error.message : String(error),
      path: node.path,
      node_id: node.id,
    }
  }
  return saveBuildState(dataDir, build)
}

function latestRunVersion(dataDir, runId) {
  let run = loadRun(dataDir, runId)
  const seen = new Set()
  while (run.superseded_by && !seen.has(run.id)) {
    seen.add(run.id)
    run = loadRun(dataDir, run.superseded_by)
  }
  return run
}

// 人工验收通过后，才把子构建结果回填父草稿并生成新版本
function applyHandoffBackfill(dataDir, build, definition) {
  const origin = build.origin
  const parent = latestRunVersion(dataDir, origin.run_id)
  if (parent.status !== 'draft') {
    throw new Error(`父草稿 ${parent.id} 当前为 ${parent.status}，不能回填子流程构建结果`)
  }
  const replaced = replaceBuildPlaceholder(parent.definition, origin.node_id, definition)
  const version = (parent.definition_version || 1) + 1
  const run = makeRunRecord({
    parent_session_id: parent.parent_session_id,
    workspace: parent.workspace,
    workspace_id: parent.workspace_id || null,
    dsh_session_id: parent.dsh_session_id || null,
    name: parent.name,
    task: parent.task,
    definition: replaced,
    input: parent.input,
    fuel: parent.fuel?.initial,
    definition_version: version,
    previous_run_id: parent.id,
    supervision: parent.supervision,
    status: 'draft',
    planner: {
      kind: 'build_handoff',
      summary: `子流程 ${origin.node_id} 构建完成，回填为 v${version}`,
      citations: [],
      retrieval: null,
      build_id: build.id,
    },
  })
  appendMessage(run, 'planner', `子流程 ${origin.node_id} 构建完成并回填，生成草稿 v${version}`, { build_id: build.id })
  addAction(run, 'start', { reason: '确认回填后的工作流并启动执行' })
  parent.status = 'superseded'
  parent.superseded_by = run.id
  appendMessage(parent, 'system', `子流程 ${origin.node_id} 构建完成，草稿已被 v${version} 替代`)
  saveState(dataDir, parent)
  saveState(dataDir, run)
  if (sessionExists(dataDir, parent.parent_session_id)) {
    const parentSession = loadSession(dataDir, parent.parent_session_id)
    parentSession.draft_run_id = run.id
    parentSession.active_run_id = null
    parentSession.status = 'awaiting_confirm'
    appendSessionMessage(parentSession, 'system', `子流程 ${origin.node_id} 已验收回填，草稿升级为 v${version}`, { run_id: run.id })
    saveSessionState(dataDir, parentSession)
  }
  if (sessionExists(dataDir, build.session_id)) {
    const child = loadSession(dataDir, build.session_id)
    child.draft_run_id = run.id
    appendSessionMessage(child, 'system', `已回填父会话 ${parent.parent_session_id} 的草稿 v${version}`, { run_id: run.id })
    if (build.mail_reply_to?.id) {
      child.mail_resolved = [...new Set([...(child.mail_resolved || []), build.mail_reply_to.id])]
    }
    saveSessionState(dataDir, child)
  }
  if (build.mail_reply_to?.id) {
    appendMailEnvelope(dataDir, {
      from: build.session_id,
      to: build.mail_reply_to.from_session,
      kind: 'answer',
      subject: `re: ${build.mail_reply_to.subject}`,
      body: `已按 bug_report 重建节点 ${origin.node_id} 并回填父草稿 v${version}。`,
      refs: { run_id: run.id, node_path: origin.node_path },
      reply_to: build.mail_reply_to.id,
    })
  }
  return run
}

// 人工验收通过后，才把子构建结果回填父构建的占位
function applyNestedBackfill(dataDir, build, definition) {
  const origin = build.origin
  try {
    const parent = loadBuild(dataDir, origin.parent_build_session_id)
    backfillBuildChild(parent, origin.parent_node_path, origin.node_id, definition)
    saveBuildState(dataDir, parent)
  } catch {
    // 父节点已被重建（bug_report/zoom）导致占位不再存在：跳过回填，不影响人工验收
  }
  if (sessionExists(dataDir, build.session_id)) {
    const child = loadSession(dataDir, build.session_id)
    appendSessionMessage(child, 'system', `已回填父构建 ${origin.parent_build_session_id} 的占位 ${origin.node_id}`, {
      parent_build_session_id: origin.parent_build_session_id,
    })
    saveSessionState(dataDir, child)
  }
}

function finalizeBuild(dataDir, build) {
  build.current_node = null
  try {
    const definition = compileBuildDefinition(build)
    // 子构建与顶层一致：编译完成即生成可独立运行的草稿（可试跑、产生独立运行记录）；
    // 回填父占位仍由人工验收触发，运行与验收互不影响
    const run = makeRunRecord({
      parent_session_id: build.session_id,
      task: build.task,
      name: build.name,
      definition,
      input: build.input,
      workspace: build.workspace,
      workspace_id: build.workspace_id || null,
      dsh_session_id: build.dsh_session_id || null,
      status: 'draft',
      supervision: { enabled: true },
      planner: { summary: build.summary || `构建器生成：${build.name}`, citations: [], retrieval: null, build_id: build.id },
    })
    appendMessage(run, 'planner', build.summary || `构建器完成 ${build.name} 的骨架拆解与节点实现`, {
      citations: [],
      build_id: build.id,
    })
    addAction(run, 'start', { reason: '确认构建结果并启动执行' })
    saveState(dataDir, run)
    build.definition = definition
    build.run_id = run.id
    build.status = 'awaiting_confirm'
    build.error = null
    if (build.origin?.parent_kind === 'build' || build.origin?.run_id) {
      if (sessionExists(dataDir, build.session_id)) {
        const child = loadSession(dataDir, build.session_id)
        child.status = 'awaiting_confirm'
        child.draft_run_id = run.id
        appendSessionMessage(child, 'system', '构建编译完成：可独立运行验证；验收通过后回填父占位', {
          parent_build_session_id: build.origin?.parent_build_session_id || null,
          run_id: run.id,
        })
        saveSessionState(dataDir, child)
      }
    }
  } catch (error) {
    build.status = 'failed'
    build.error = { message: error && error.message ? error.message : String(error) }
  }
  return saveBuildState(dataDir, build)
}

function sanitizeSessionPart(value, max) {
  const text = String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max)
  return text || 'x'
}

function childSessionId(parentSessionId, nodeId) {
  return `sess-${sanitizeSessionPart(parentSessionId, 44)}_${sanitizeSessionPart(nodeId, 30)}`.slice(0, 80)
}

function childSessionName(parentName, label) {
  const base = String(parentName || '会话').trim()
  const text = `${base} / ${label}`.trim()
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

// 占位层数必须静态声明且严格小于父层，保证嵌套子会话数量有限、构建可终止
function placeholderLayers(placeholder, parentLayers = buildLayerBudget()) {
  assertPlaceholderLayers([placeholder], parentLayers)
  return Number(placeholder.build.layers)
}

// 只创建子会话（awaiting_start），不建构建、不跑节点：等人工确认启动
async function ensureChildSession(dataDir, fields) {
  const { parentSessionId, childId } = fields
  if (sessionExists(dataDir, childId)) return loadSession(dataDir, childId)
  const parentSession = sessionExists(dataDir, parentSessionId) ? loadSession(dataDir, parentSessionId) : null
  const child = makeSessionRecord({
    task: fields.task,
    name: fields.name,
    session_id: childId,
    session_parent: parentSessionId,
    session_depth: (parentSession?.depth || 0) + 1,
    workspace: fields.workspace,
    origin: fields.origin,
    ...(fields.sampleInput !== undefined ? { input: clone(fields.sampleInput) } : {}),
  }, dataDir)
  child.root_session_id = parentSession ? sessionRoot(parentSession) : parentSessionId
  // 与父会话一致：先受理，再看需求是否足够（可能进入 clarifying），之后才生成骨架 DAG
  child.status = 'intake'
  appendSessionMessage(child, 'system', fields.intro)
  saveSession(dataDir, child)
  return child
}

// 根层（第1层）也有自己的会话：预构建开始前为根层建独立会话并建 dsh 镜像，
// 使 dsh 侧栏得到「发起会话 → 第1层 → 第2层 …」的链式会话树。
// 该会话只做层级锚点，不承担需求分析与节点编码。
async function ensureRootLayerSession(dataDir, run, dependencies = {}, status = 'building') {
  const rootSessionId = String(run.parent_session_id || '').trim()
  if (!rootSessionId) return null
  const planSession = sessionExists(dataDir, rootSessionId) ? loadSession(dataDir, rootSessionId) : null
  // 层会话按根会话固定命名，草稿升级换版本时复用同一个第1层会话
  const layerId = run.layer_session_id || childSessionId(rootSessionId, 'layer1')
  if (sessionExists(dataDir, layerId)) {
    const layer = loadSession(dataDir, layerId)
    // 规划期先挂成待确认，预构建开始后转为构建中
    if (status === 'building' && layer.status === 'awaiting_confirm') {
      layer.status = 'building'
      appendSessionMessage(layer, 'system', '第1层（根层）预构建开始：逐层为子流程占位创建会话')
      saveSessionState(dataDir, layer)
    }
    if (!layer.dsh_session_id) {
      await alignSession(layer, dependencies, layer.id, planSession?.dsh_session_id || null)
      saveSessionState(dataDir, layer)
    }
    if (!run.layer_session_id) {
      run.layer_session_id = layerId
      saveRun(dataDir, run)
    }
    return layer
  }
  const layer = makeSessionRecord({
    task: run.task,
    name: childSessionName(planSession?.name || run.name, '第1层（根层）构建'),
    session_id: layerId,
    session_parent: rootSessionId,
    session_depth: (planSession?.depth || 0) + 1,
    workspace: run.workspace,
    origin: { layer_root_run_id: run.id, layer: 1 },
  }, dataDir)
  layer.root_session_id = planSession ? sessionRoot(planSession) : rootSessionId
  layer.status = status
  appendSessionMessage(layer, 'system', `第1层（根层）构建会话：由草稿 ${run.id} 创建，逐层预构建占位并自底向上回填`)
  saveSession(dataDir, layer)
  await alignSession(layer, dependencies, layer.id, planSession?.dsh_session_id || null)
  saveSessionState(dataDir, layer)
  run.layer_session_id = layer.id
  saveRun(dataDir, run)
  return layer
}

async function markChildBuilding(dataDir, child, label) {
  if (buildExists(dataDir, child.id)) return child
  if (!['intake', 'awaiting_start', 'clarifying', 'building'].includes(child.status)) return child
  child.status = 'building'
  appendSessionMessage(child, 'system', `需求确认完成，开始子构建：${label}（生成骨架后等待 DAG 确认）`)
  return saveSessionState(dataDir, child)
}

// 骨架生成后子会话停在 DAG 确认，和父会话的“先看 DAG 再跑”保持一致
function markDagPending(dataDir, build) {
  if (build.status !== 'awaiting_dag' || !sessionExists(dataDir, build.session_id)) return
  const session = loadSession(dataDir, build.session_id)
  session.status = 'awaiting_dag'
  appendSessionMessage(session, 'system', '骨架 DAG 已生成，等待人工确认后开始预构建')
  saveSessionState(dataDir, session)
}

function isChildBuildSession(session) {
  const origin = session?.origin || {}
  return Boolean(origin.parent_kind === 'build' || origin.run_id)
}

// 子会话对齐父会话：受理 → 需求分析（不足则澄清，最多 3 轮）→ 生成骨架 DAG（停在待确认）
async function advanceChildRequirement(dataDir, sessionId, dependencies = {}, extra = {}) {
  const session = loadSession(dataDir, sessionId)
  if (!isChildBuildSession(session)) throw new Error(`会话 ${sessionId} 不是子构建会话`)
  if (buildExists(dataDir, sessionId)) {
    return { status: loadBuild(dataDir, sessionId).status, session_id: sessionId }
  }
  session.round = (session.clarifications || []).length
  let analysis
  try {
    analysis = await analyzeRequirement({
      task: session.task,
      round: session.round,
      max_rounds: MAX_CLARIFY_ROUNDS,
      clarifications: clarificationPairs(session),
      instruction: extra.instruction || null,
    }, dependencies)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    appendSessionMessage(session, 'system', `需求分析降级：${message}；按交接需求直接规划。`)
    analysis = { sufficient: true, missing: [], questions: [], assumptions: ['需求分析不可用，按交接需求直接规划'] }
  }
  addAssumptions(session, analysis.assumptions)
  session.analysis = analysis
  if (!analysis.sufficient && analysis.questions.length && session.round < MAX_CLARIFY_ROUNDS) {
    session.status = 'clarifying'
    appendSessionMessage(session, 'analyst', [
      '子会话的需求信息还不够，需要你补充：',
      ...analysis.missing.map(item => `· ${item}`),
      ...analysis.questions.map((item, index) => `${index + 1}. ${item}`),
    ].join('\n'))
    saveSessionState(dataDir, session)
    return { status: 'clarifying', session_id: sessionId, questions: analysis.questions }
  }
  if (!analysis.sufficient) {
    appendSessionMessage(session, 'analyst', `已提出 ${MAX_CLARIFY_ROUNDS} 轮澄清，按现有假设继续构建。`)
  }
  saveSessionState(dataDir, session)
  const origin = session.origin || {}
  const revision = extra.revision || null
  const previousDefinition = extra.previous_definition || null
  if (origin.parent_kind === 'build') {
    await startNestedBuild({
      data_dir: dataDir,
      parent_build_session_id: origin.parent_build_session_id,
      parent_node_path: origin.parent_node_path,
      node_id: origin.node_id,
      child_session_id: sessionId,
      revision,
      previous_definition: previousDefinition,
    }, dependencies)
  } else {
    await startHandoffBuild({
      data_dir: dataDir,
      from_run_id: latestRunVersion(dataDir, origin.run_id).id,
      node_id: origin.node_id,
      child_session_id: sessionId,
      revision,
      previous_definition: previousDefinition,
    }, dependencies)
  }
  return { status: loadBuildOrFail(dataDir, sessionId).status, session_id: sessionId }
}

async function startHandoffBuild(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const runId = String(args.from_run_id || '').trim()
  const nodeId = String(args.node_id || '').trim()
  if (!runId) throw new Error('from_run_id 不能为空')
  if (!nodeId) throw new Error('node_id 不能为空')
  const parentRun = loadRun(dataDir, runId)
  if (parentRun.status !== 'draft') throw new Error(`只有草稿可以交接构建（当前 ${parentRun.status}）`)
  const placeholder = collectBuildPlaceholders(parentRun.definition).find(item => item.node_id === nodeId)
  if (!placeholder) throw new Error(`运行 ${runId} 中没有 subflow.build 占位：${nodeId}`)
  const layers = placeholderLayers(placeholder)
  const parentSessionId = parentRun.parent_session_id
  const parentSession = sessionExists(dataDir, parentSessionId) ? loadSession(dataDir, parentSessionId) : null
  // 第1层（根层）也有独立会话：占位会话挂在它下面，形成逐层链式会话树
  const layerSession = await ensureRootLayerSession(dataDir, parentRun, dependencies)
  const sessionParentId = layerSession?.id || parentSessionId
  const childId = String(args.child_session_id || '').trim()
    || childSessionId(parentSessionId, `${nodeId}_${parentRun.id.slice(-8)}`)
  const workspace = resolveSubflowWorkspace(parentRun.workspace, placeholder.build)
  const task = handoffTask(placeholder.build.task, layers)
  return withSessionLock(dataDir, childId, async () => {
    const child = await ensureChildSession(dataDir, {
      parentSessionId: sessionParentId,
      childId,
      workspace,
      task,
      name: childSessionName(parentSession?.name || parentRun.name, placeholder.label),
      origin: {
        run_id: parentRun.id,
        node_id: nodeId,
        node_path: placeholder.path,
        parent_session_id: parentSessionId,
        layers,
      },
      sampleInput: hasOwn(placeholder.build, 'sample_input') ? placeholder.build.sample_input : undefined,
      intro: `由父草稿 ${parentRun.id} 的占位节点 ${nodeId} 交接创建，等待人工确认启动构建`,
    })
    if (buildExists(dataDir, childId)) return describeBuild(loadBuild(dataDir, childId))
    if (args.prepare) return { session_id: childId, status: child.status }
    await markChildBuilding(dataDir, child, `子流程 ${placeholder.label || nodeId}`)
    await alignSession(child, dependencies, child.id, layerSession?.dsh_session_id || parentSession?.dsh_session_id || null)
    saveSessionState(dataDir, child)
    const mailbox = unreadMails(dataDir, child).slice(-MAIL_INJECT_LIMIT)
    const build = await createBuildState({
      session_id: childId,
      task,
      name: child.name,
      workspace: child.workspace,
      workspace_id: child.workspace_id,
      dsh_session_id: child.dsh_session_id,
      limits: buildLimits(),
      origin: child.origin,
      pause_after_skeleton: true,
      revision: args.revision || null,
      previous_definition: args.previous_definition || null,
      context: {
        parent_task: parentRun.task || parentRun.name,
        node_label: placeholder.label,
        inputs: placeholder.build.inputs || null,
        outputs: placeholder.build.outputs || null,
        layers,
        revision: args.revision || null,
      },
      mailbox: mailbox.map(mail => ({ kind: mail.kind, subject: mail.subject, body: mail.body })),
    }, dependencies)
    build.input = hasOwn(placeholder.build, 'sample_input') ? clone(placeholder.build.sample_input) : null
    if (mailbox.length) {
      child.mail_read = [...new Set([...(child.mail_read || []), ...mailbox.map(mail => mail.id)])]
      saveSessionState(dataDir, child)
    }
    saveBuildState(dataDir, build)
    markDagPending(dataDir, build)
    return describeBuild(build)
  })
}

async function startNestedBuild(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const parentBuild = loadBuildOrFail(dataDir, args.parent_build_session_id)
  const placeholder = pendingChildPlaceholders(parentBuild)
    .find(item => item.node_id === args.node_id && item.parent_path === args.parent_node_path)
  if (!placeholder) throw new Error(`父构建 ${parentBuild.session_id} 中没有等待构建的占位：${args.node_id}`)
  const layers = placeholderLayers(placeholder, buildLayersOf(parentBuild))
  const parentSessionId = parentBuild.session_id
  const parentSession = sessionExists(dataDir, parentSessionId) ? loadSession(dataDir, parentSessionId) : null
  const childId = String(args.child_session_id || '').trim()
    || childSessionId(parentSessionId, `${args.node_id}_${parentBuild.id.slice(-8)}`)
  const workspace = resolveSubflowWorkspace(parentBuild.workspace, placeholder.build)
  const task = handoffTask(placeholder.task, layers)
  return withSessionLock(dataDir, childId, async () => {
    const child = await ensureChildSession(dataDir, {
      parentSessionId,
      childId,
      workspace,
      task,
      name: childSessionName(parentSession?.name || parentBuild.name, placeholder.label),
      origin: {
        parent_kind: 'build',
        parent_build_session_id: parentBuild.session_id,
        parent_node_path: placeholder.parent_path,
        node_id: args.node_id,
        parent_session_id: parentSessionId,
        layers,
      },
      sampleInput: hasOwn(placeholder.build, 'sample_input') ? placeholder.build.sample_input : undefined,
      intro: `由父构建 ${parentBuild.session_id} 的占位节点 ${args.node_id} 交接创建，等待人工确认启动构建`,
    })
    if (buildExists(dataDir, childId)) return describeBuild(loadBuild(dataDir, childId))
    if (args.prepare) return { session_id: childId, status: child.status }
    await markChildBuilding(dataDir, child, `子流程 ${placeholder.label || args.node_id}`)
    await alignSession(child, dependencies, child.id, parentSession?.dsh_session_id || null)
    saveSessionState(dataDir, child)
    const build = await createBuildState({
      session_id: childId,
      task,
      name: child.name,
      workspace: child.workspace,
      workspace_id: child.workspace_id,
      dsh_session_id: child.dsh_session_id,
      limits: buildLimits(),
      origin: child.origin,
      pause_after_skeleton: true,
      revision: args.revision || null,
      previous_definition: args.previous_definition || null,
      context: {
        parent_task: parentBuild.task,
        node_label: placeholder.label,
        inputs: placeholder.build.inputs || null,
        outputs: placeholder.build.outputs || null,
        layers,
        revision: args.revision || null,
      },
      mailbox: [],
    }, dependencies)
    build.input = hasOwn(placeholder.build, 'sample_input') ? clone(placeholder.build.sample_input) : null
    saveBuildState(dataDir, build)
    markDagPending(dataDir, build)
    return describeBuild(build)
  })
}

function stackRootOf(dataDir, sessionId) {
  if (sessionExists(dataDir, sessionId)) {
    const session = loadSession(dataDir, sessionId)
    return session.root_session_id || session.id
  }
  return sessionId
}

function nestedBuildMaxDepth() {
  const value = Number(process.env.RMS_FLOW_BUILD_STACK_DEPTH)
  return Number.isInteger(value) && value >= 1 && value <= 64 ? value : 16
}

// 已有构建对应的栈条目字段（runBuild 直接驱动某构建时把它登记进共享栈）
function entryFieldsForBuild(dataDir, build) {
  const origin = build.origin || {}
  const session = sessionExists(dataDir, build.session_id) ? loadSession(dataDir, build.session_id) : null
  const depth = session ? session.depth : 0
  if (origin.parent_kind === 'build') {
    return {
      kind: 'build',
      parent_id: origin.parent_build_session_id,
      parent_node_path: origin.parent_node_path,
      node_id: origin.node_id,
      label: origin.node_id,
      depth,
      session_id: build.session_id,
    }
  }
  if (origin.run_id) {
    return {
      kind: 'run',
      parent_id: origin.run_id,
      node_id: origin.node_id,
      label: origin.node_id,
      depth: depth || 1,
      session_id: build.session_id,
    }
  }
  return {
    kind: 'build',
    parent_id: build.session_id,
    parent_node_path: null,
    node_id: build.session_id,
    label: build.name,
    depth,
    session_id: build.session_id,
  }
}

function loadOrCreateStack(dataDir, rootSessionId, rootRunId) {
  const stack = loadBuildStack(dataDir, rootSessionId)
  if (stack) return stack
  return {
    version: 1,
    root_session_id: rootSessionId,
    root_run_id: rootRunId || null,
    status: 'building',
    entries: [],
    created_at: now(),
    updated_at: now(),
  }
}

function saveStack(dataDir, stack) {
  stack.updated_at = now()
  return saveBuildStack(dataDir, stack)
}

function stackEntryKey(fields) {
  return fields.kind === 'run'
    ? `run:${fields.node_id}`
    : `build:${fields.parent_id}:${fields.parent_node_path || ''}:${fields.node_id}`
}

function ensureStackEntry(stack, fields) {
  const key = stackEntryKey(fields)
  let entry = stack.entries.find(item => item.key === key)
  if (!entry) {
    entry = {
      id: `bsentry-${randomUUID().slice(0, 8)}`,
      key,
      status: 'pending',
      session_id: null,
      error: null,
      created_at: now(),
      updated_at: now(),
      ...fields,
    }
    stack.entries.push(entry)
    return { entry, created: true }
  }
  return { entry, created: false }
}

function stackEntryStatus(dataDir, entry) {
  if (!entry.session_id) return 'pending'
  if (buildExists(dataDir, entry.session_id)) return loadBuild(dataDir, entry.session_id).status
  if (sessionExists(dataDir, entry.session_id)) {
    const session = loadSession(dataDir, entry.session_id)
    if (session.status === 'awaiting_start') return 'awaiting_start'
    if (session.status === 'clarifying') return 'clarifying'
    return entry.status || 'pending'
  }
  return entry.status || 'pending'
}

function summarizeStack(dataDir, stack) {
  return stack.entries.map(entry => ({
    node_id: entry.node_id,
    label: entry.label,
    parent_kind: entry.kind,
    parent_id: entry.parent_id,
    parent_node_path: entry.parent_node_path || null,
    session_id: entry.session_id,
    depth: entry.depth,
    status: stackEntryStatus(dataDir, entry),
    error: entry.error || null,
  }))
}

function stackView(dataDir, stack) {
  return {
    root_session_id: stack.root_session_id,
    status: stack.status,
    entries: summarizeStack(dataDir, stack),
  }
}

// awaiting_confirm：子构建已生成可运行草稿，等待人工运行/验收（验收后才回填父占位）
const PAUSE_STATUSES = ['waiting_human', 'failed', 'awaiting_start', 'clarifying', 'awaiting_dag', 'awaiting_accept', 'awaiting_confirm']
const SETTLED_STATUSES = ['done', 'awaiting_confirm', 'accepted']

// 按条目实际构建状态刷新整栈状态：awaiting_start / awaiting_dag / awaiting_accept 都是人工门禁暂停
function refreshStackStatus(dataDir, stack) {
  const summary = summarizeStack(dataDir, stack)
  // 根条目到达 awaiting_confirm 表示整棵构建结束（草稿待运行/验收），不算栈门禁
  const blocked = summary.find(item => PAUSE_STATUSES.includes(item.status)
    && !(item.status === 'awaiting_confirm' && item.depth === 0))
  const unfinished = summary.filter(item => !SETTLED_STATUSES.includes(item.status))
  stack.status = blocked ? blocked.status : (unfinished.length ? 'building' : 'done')
  saveStack(dataDir, stack)
  return summary
}

// 单个栈条目：没有子会话时只创建会话（awaiting_start）并暂停，等人工确认启动；
// 已启动的构建则推进自身节点队列，遇到嵌套占位把子条目压栈并逐个驱动
async function driveStackEntry(dataDir, stack, entry, dependencies) {
  if (!entry.session_id) {
    const started = entry.kind === 'run'
      ? await startHandoffBuild({
        data_dir: dataDir,
        from_run_id: latestRunVersion(dataDir, entry.parent_id).id,
        node_id: entry.node_id,
        prepare: true,
      }, dependencies)
      : await startNestedBuild({
        data_dir: dataDir,
        parent_build_session_id: entry.parent_id,
        parent_node_path: entry.parent_node_path,
        node_id: entry.node_id,
        prepare: true,
      }, dependencies)
    entry.session_id = started.session_id
    entry.status = 'intake'
    entry.error = null
    entry.updated_at = now()
    saveStack(dataDir, stack)
    // 与父会话一致：先做需求分析（不足则进入 clarifying 等人工补充），再生成骨架 DAG
    const advanced = await advanceChildRequirement(dataDir, started.session_id, dependencies)
    entry.status = advanced.status
    entry.updated_at = now()
    saveStack(dataDir, stack)
    return advanced
  }
  const status = stackEntryStatus(dataDir, entry)
  if (PAUSE_STATUSES.includes(status) || status === 'done' || status === 'accepted') return { status }
  if (!buildExists(dataDir, entry.session_id)) {
    // 会话已建但构建尚未启动（人工还没确认启动）
    entry.status = 'awaiting_start'
    entry.updated_at = now()
    saveStack(dataDir, stack)
    return { status: 'awaiting_start' }
  }
  const build = await driveBuildToCompletion(dataDir, entry.session_id, dependencies, stack, entry)
  entry.status = build.status
  entry.error = build.error?.message || null
  entry.updated_at = now()
  saveStack(dataDir, stack)
  return build
}

// 推进一个构建：跑自身节点队列；遇到嵌套占位就把子条目压栈并逐个驱动（子构建验收后回填），然后继续自身队列
async function driveBuildToCompletion(dataDir, sessionId, dependencies, stack, entry) {
  for (let round = 0; round < 64; round += 1) {
    const build = await withSessionLock(dataDir, sessionId, async () => {
      const current = loadBuildOrFail(dataDir, sessionId)
      const limit = current.limits.max_sessions + 8
      for (let index = 0; index < limit && current.status === 'building'; index += 1) {
        await stepBuildState(dataDir, current, dependencies)
      }
      return current
    })
    if (build.status !== 'waiting_children') return build
    const parent = loadBuildOrFail(dataDir, sessionId)
    const children = pendingChildPlaceholders(parent)
    if (!children.length) {
      // 占位已全部回填但状态未恢复：恢复后继续
      parent.status = 'building'
      saveBuildState(dataDir, parent)
      continue
    }
    for (const child of children) {
      const childDepth = (entry?.depth || 0) + 1
      if (childDepth > nestedBuildMaxDepth()) {
        parent.status = 'failed'
        parent.error = {
          message: `子流程构建深度 ${childDepth} 超过上限 ${nestedBuildMaxDepth()}（RMS_FLOW_BUILD_STACK_DEPTH）`,
        }
        saveBuildState(dataDir, parent)
        return parent
      }
      const { entry: childEntry } = ensureStackEntry(stack, {
        kind: 'build',
        parent_id: parent.session_id,
        parent_node_path: child.parent_path,
        node_id: child.node_id,
        label: child.label,
        depth: childDepth,
      })
      saveStack(dataDir, stack)
      const childBuild = await driveStackEntry(dataDir, stack, childEntry, dependencies)
      // 整体暂停：子会话待人工启动/验收、等待人工输入或失败，都停止驱动兄弟条目与父构建
      if (PAUSE_STATUSES.includes(childBuild.status)) {
        return loadBuildOrFail(dataDir, sessionId)
      }
    }
  }
  throw new Error(`构建 ${sessionId} 推进超过轮次上限`)
}

// 共享构建栈驱动循环：栈非空一直跑（子先于父），任一条目待人工门禁/输入/失败即整体暂停
async function driveStack(dataDir, stack, dependencies, options = {}) {
  for (let guard = 0; guard < 64; guard += 1) {
    // 根条目 awaiting_confirm = 整棵构建结束（草稿待运行/验收），不算栈门禁
    const blocked = stack.entries.find(item => {
      const status = stackEntryStatus(dataDir, item)
      return PAUSE_STATUSES.includes(status) && !(status === 'awaiting_confirm' && item.depth === 0)
    })
    if (blocked) {
      stack.status = stackEntryStatus(dataDir, blocked)
      saveStack(dataDir, stack)
      return
    }
    // 可推进 = 未开始或构建中；按入栈顺序逐个驱动。嵌套子条目在同一构建内
    // 深度优先递归推进（子先于父、验收后回填），最终回到根会话且栈空即完成
    const actionable = stack.entries
      .filter(item => {
        const status = stackEntryStatus(dataDir, item)
        return status === 'pending' || status === 'building'
      })
    const next = actionable[0]
    if (!next) break
    await driveStackEntry(dataDir, stack, next, dependencies)
    if (options.step) break
  }
  refreshStackStatus(dataDir, stack)
}

// 同一根会话的构建栈推进串行化：面板动作把推进放到后台队列后立即返回，
// 由 3 秒轮询展示进度，避免长节点构建把面板按钮卡成一直转圈。
const stackDrives = new Map()

function queueStackDrive(dataDir, rootSessionId, stack, dependencies) {
  const key = `${dataDir}::${rootSessionId}`
  const previous = stackDrives.get(key)
  // 队列为空时直接驱动调用方刚载入/刚保存的栈；前面还有推进时重读磁盘，
  // 避免用过期条目覆盖上一轮写入的结果。
  const next = (previous || Promise.resolve()).catch(() => {}).then(() => driveStack(
    dataDir,
    previous ? (loadBuildStack(dataDir, rootSessionId) || stack) : stack,
    dependencies,
  ))
  stackDrives.set(key, next)
  next.then(() => {}, (error) => {
    console.error(`[rms-flow-runner] 构建栈推进失败：${error && error.message ? error.message : error}`)
  }).finally(() => {
    if (stackDrives.get(key) === next) stackDrives.delete(key)
  })
  return next
}

export async function prebuildFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const runId = String(args.run_id || '').trim()
  if (!runId) throw new Error('run_id 不能为空')
  let latest = latestRunVersion(dataDir, runId)
  if (latest.status !== 'draft') throw new Error(`只有草稿可以预构建（当前 ${latest.status}）`)
  const rootSessionId = stackRootOf(dataDir, latest.parent_session_id || runId)
  const stack = loadOrCreateStack(dataDir, rootSessionId, latest.id)
  // 第1层（根层）独立会话：先挂在发起会话下，占位子会话再逐层挂在它下面
  const layerSession = await ensureRootLayerSession(dataDir, latest, dependencies)

  const syncEntries = () => {
    const current = latestRunVersion(dataDir, runId)
    for (const placeholder of collectBuildPlaceholders(current.definition)) {
      ensureStackEntry(stack, {
        kind: 'run',
        parent_id: current.id,
        node_id: placeholder.node_id,
        label: placeholder.label,
        depth: 1,
      })
    }
    return current
  }

  syncEntries()
  const drive = queueStackDrive(dataDir, stack.root_session_id, stack, dependencies)
  if (args.background) {
    // 后台推进：先返回入队快照，面板按轮询自行刷新
    const queued = summarizeStack(dataDir, stack)
    const pending = queued.filter(item => !SETTLED_STATUSES.includes(item.status))
    return {
      status: 'building',
      blocked: null,
      run_id: latest.id,
      definition_version: latest.definition_version || 1,
      remaining: pending.length,
      placeholders: pending,
      builds: queued,
      stack: stackView(dataDir, stack),
      background: true,
    }
  }
  await drive

  latest = syncEntries()
  const summary = refreshStackStatus(dataDir, stack)
  // 整栈完成时把第1层会话一并收尾，避免它在侧栏长期停在构建中
  if (layerSession && stack.status === 'done' && sessionExists(dataDir, layerSession.id)) {
    const layer = loadSession(dataDir, layerSession.id)
    if (layer.status !== 'done') {
      layer.status = 'done'
      appendSessionMessage(layer, 'system', '第1层（根层）构建完成：全部子流程占位已回填')
      saveSessionState(dataDir, layer)
    }
  }
  const unfinished = summary.filter(item => !SETTLED_STATUSES.includes(item.status))
  // awaiting_start / awaiting_accept / waiting_human / failed 都会让整栈暂停，需要人工介入
  const blockedEntry = summary.find(item => PAUSE_STATUSES.includes(item.status))
  return {
    status: stack.status === 'done' ? 'ready' : (blockedEntry ? blockedEntry.status : 'building'),
    blocked: blockedEntry ? {
      session_id: blockedEntry.session_id,
      node_id: blockedEntry.node_id,
      label: blockedEntry.label,
      status: blockedEntry.status,
      depth: blockedEntry.depth,
    } : null,
    run_id: latest.id,
    definition_version: latest.definition_version || 1,
    remaining: unfinished.length,
    placeholders: unfinished,
    builds: summary,
    stack: { root_session_id: stack.root_session_id, status: stack.status, entries: summary },
  }
}

export async function startBuild(args, dependencies = {}) {
  if (args.from_run_id) return startHandoffBuild(args, dependencies)
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = buildSessionId(args)
  const workspace = resolveWorkspace(dataDir, sessionId, args.workspace)
  // 根构建的层数预算在规划期一次定死，并作为具体数字写进任务与交接契约
  const layers = Number.isInteger(args.layers) ? args.layers : buildLayerBudget()
  const task = handoffTask(String(args.task || '').trim(), layers)
  const identity = await alignSession({
    id: sessionId,
    name: String(args.name || args.task || sessionId).trim(),
    task,
    workspace,
    dsh_session_id: null,
  }, dependencies)
  const build = await createBuildState({
    session_id: sessionId,
    task,
    name: args.name,
    workspace: identity.workspace,
    workspace_id: identity.workspace_id,
    dsh_session_id: identity.dsh_session_id,
    limits: buildLimits(),
    context: { layers },
  }, dependencies)
  return withSessionLock(dataDir, sessionId, async () => {
    saveBuildState(dataDir, build)
    return describeBuild(build)
  })
}

export async function stepBuild(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = buildSessionId(args)
  return withSessionLock(dataDir, sessionId, async () => {
    const build = loadBuildOrFail(dataDir, sessionId)
    return describeBuild(await stepBuildState(dataDir, build, dependencies))
  })
}

export async function runBuild(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = buildSessionId(args)
  const build = loadBuildOrFail(dataDir, sessionId)
  const rootSessionId = stackRootOf(dataDir, sessionId)
  const stack = loadOrCreateStack(dataDir, rootSessionId, build.origin?.run_id || null)
  const { entry } = ensureStackEntry(stack, entryFieldsForBuild(dataDir, build))
  entry.session_id = entry.session_id || sessionId
  saveStack(dataDir, stack)
  // 经共享构建栈推进：嵌套占位会逐个开独立子会话构建并自底向上回填
  const driven = await driveStackEntry(dataDir, stack, entry, dependencies)
  refreshStackStatus(dataDir, stack)
  // 遇到人工门禁时 driveStackEntry 只返回状态摘要，这里统一回读完整构建
  if (driven && driven.root) return describeBuild(driven)
  return describeBuild(loadBuildOrFail(dataDir, sessionId))
}

// 推进子会话需求确认（兼容旧数据）：已完成分析的会话直接生成骨架 DAG
export async function startBuildSession(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || args.parent_session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  if (!sessionExists(dataDir, sessionId)) throw new Error(`会话不存在：${sessionId}`)
  const session = loadSession(dataDir, sessionId)
  if (!isChildBuildSession(session)) throw new Error(`会话 ${sessionId} 不是子构建会话`)
  if (buildExists(dataDir, sessionId)) {
    throw new Error(`会话 ${sessionId} 的构建已启动（${loadBuild(dataDir, sessionId).status}），无需重复确认`)
  }
  // 与父会话一致：先需求分析（不足则停在 clarifying），够了才生成骨架 DAG
  const advanced = await advanceChildRequirement(dataDir, sessionId, dependencies)
  if (advanced.status === 'clarifying') {
    return { session_id: sessionId, status: 'clarifying', questions: advanced.questions || [] }
  }
  const build = loadBuildOrFail(dataDir, sessionId)
  const stack = loadOrCreateStack(dataDir, stackRootOf(dataDir, sessionId), build.origin?.run_id || null)
  const { entry } = ensureStackEntry(stack, entryFieldsForBuild(dataDir, build))
  entry.session_id = sessionId
  entry.status = build.status
  saveStack(dataDir, stack)
  // 骨架生成后先停下等人工确认 DAG，确认前不进入节点实现（编码）
  if (build.status !== 'awaiting_dag') {
    const drive = queueStackDrive(dataDir, stack.root_session_id, stack, dependencies)
    if (args.background) void drive
    else await drive
  }
  const current = loadBuildOrFail(dataDir, sessionId)
  return {
    session_id: sessionId,
    status: current.status,
    build: describeBuild(current),
    stack: stackView(dataDir, stack),
    ...(args.background ? { background: true } : {}),
  }
}

// 人工确认子会话的骨架 DAG：确认后才进入预构建（逐节点实现）
export async function confirmBuildDag(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || args.parent_session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  const build = await withSessionLock(dataDir, sessionId, async () => {
    const current = loadBuildOrFail(dataDir, sessionId)
    if (current.status !== 'awaiting_dag') {
      throw new Error(`构建会话当前为 ${current.status}，只有 awaiting_dag 可以确认 DAG`)
    }
    current.status = 'building'
    current.updated_at = now()
    saveBuildState(dataDir, current)
    if (sessionExists(dataDir, sessionId)) {
      const session = loadSession(dataDir, sessionId)
      session.status = 'building'
      appendSessionMessage(session, 'system', '人工确认骨架 DAG，开始预构建')
      saveSessionState(dataDir, session)
    }
    return current
  })
  const stack = loadOrCreateStack(dataDir, stackRootOf(dataDir, sessionId), build.origin?.run_id || null)
  const { entry } = ensureStackEntry(stack, entryFieldsForBuild(dataDir, build))
  entry.session_id = entry.session_id || sessionId
  entry.status = 'building'
  entry.error = null
  saveStack(dataDir, stack)
  const drive = queueStackDrive(dataDir, stack.root_session_id, stack, dependencies)
  if (args.background) {
    void drive
    return {
      session_id: sessionId,
      status: 'building',
      build: describeBuild(loadBuildOrFail(dataDir, sessionId)),
      stack: stackView(dataDir, stack),
      background: true,
    }
  }
  await drive
  return {
    session_id: sessionId,
    status: loadBuildOrFail(dataDir, sessionId).status,
    build: describeBuild(loadBuildOrFail(dataDir, sessionId)),
    stack: stackView(dataDir, stack),
  }
}

// 构建失败后人工重试：重置失败节点，再从共享构建栈继续推进
export async function retryBuild(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = buildSessionId(args)
  const build = await withSessionLock(dataDir, sessionId, async () => {
    const current = loadBuildOrFail(dataDir, sessionId)
    if (current.status !== 'failed') {
      throw new Error(`构建会话当前为 ${current.status}，只有 failed 可以重试`)
    }
    const failedPath = current.error?.path
    const node = failedPath ? findBuildNode(current, { path: failedPath }) : null
    if (node) {
      resetNodeForRebuild(current, node, {
        action: 'answer',
        answer: String(args.instruction || '').trim() || '人工重试：按原要求重新构建该节点',
        angle: null,
        scope: null,
      })
    } else {
      current.status = 'building'
    }
    current.error = null
    current.current_node = null
    if (sessionExists(dataDir, sessionId)) {
      const session = loadSession(dataDir, sessionId)
      session.status = 'building'
      appendSessionMessage(session, 'system', node ? `人工重试失败节点：${node.id}` : '人工重试失败构建')
      saveSessionState(dataDir, session)
    }
    return saveBuildState(dataDir, current)
  })
  const stack = loadOrCreateStack(dataDir, stackRootOf(dataDir, sessionId), build.origin?.run_id || null)
  const { entry } = ensureStackEntry(stack, entryFieldsForBuild(dataDir, build))
  entry.session_id = entry.session_id || sessionId
  entry.status = 'building'
  entry.error = null
  saveStack(dataDir, stack)
  const drive = queueStackDrive(dataDir, stack.root_session_id, stack, dependencies)
  if (args.background) {
    void drive
    return {
      session_id: sessionId,
      status: 'building',
      build: describeBuild(loadBuildOrFail(dataDir, sessionId)),
      stack: stackView(dataDir, stack),
      background: true,
    }
  }
  await drive
  return {
    session_id: sessionId,
    status: loadBuildOrFail(dataDir, sessionId).status,
    build: describeBuild(loadBuildOrFail(dataDir, sessionId)),
    stack: stackView(dataDir, stack),
  }
}

// 人工验收子构建：确认通过后才回填父占位/父草稿，并恢复整栈推进
export async function acceptBuild(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || args.parent_session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  const build = await withSessionLock(dataDir, sessionId, async () => {
    const current = loadBuildOrFail(dataDir, sessionId)
    // awaiting_confirm：子构建已编译出可运行草稿，可直接验收回填（运行与验收独立）
    if (!['awaiting_accept', 'awaiting_confirm'].includes(current.status)) {
      throw new Error(`构建会话当前为 ${current.status}，只有 awaiting_confirm / awaiting_accept 可以验收回填`)
    }
    if (!current.definition) throw new Error('构建尚未编译出 definition，不能验收回填')
    return current
  })
  const origin = build.origin || {}
  if (origin.parent_kind === 'build') applyNestedBackfill(dataDir, build, build.definition)
  else if (origin.run_id) applyHandoffBackfill(dataDir, build, build.definition)
  else throw new Error(`构建 ${sessionId} 不是子构建，无需验收回填`)
  build.status = 'accepted'
  build.error = null
  saveBuildState(dataDir, build)
  if (sessionExists(dataDir, sessionId)) {
    const child = loadSession(dataDir, sessionId)
    child.status = 'built'
    appendSessionMessage(child, 'system', '人工验收通过，构建结果已回填父级')
    saveSessionState(dataDir, child)
  }
  const stack = loadOrCreateStack(dataDir, stackRootOf(dataDir, sessionId), build.origin?.run_id || null)
  const { entry } = ensureStackEntry(stack, entryFieldsForBuild(dataDir, build))
  entry.session_id = entry.session_id || sessionId
  entry.status = 'accepted'
  entry.error = null
  saveStack(dataDir, stack)
  // 验收后从断点恢复整栈：父构建继续自身队列，或父草稿升级为待确认的新版本
  const drive = queueStackDrive(dataDir, stack.root_session_id, stack, dependencies)
  if (args.background) void drive
  else await drive
  return {
    session_id: sessionId,
    status: 'accepted',
    build: describeBuild(loadBuildOrFail(dataDir, sessionId)),
    stack: stackView(dataDir, stack),
    ...(args.background ? { background: true } : {}),
  }
}

export async function answerBuild(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = buildSessionId(args)
  const action = ['zoom_in', 'zoom_out', 'answer'].includes(String(args.action || ''))
    ? String(args.action)
    : 'answer'
  const request = await withSessionLock(dataDir, sessionId, async () => {
    const build = loadBuildOrFail(dataDir, sessionId)
    if (build.status !== 'waiting_human' || !build.human) {
      throw new Error(`构建会话当前为 ${build.status}，没有等待人工请求`)
    }
    if (args.request_id && String(args.request_id) !== build.human.request_id) {
      throw new Error(`人工请求不匹配：${args.request_id}`)
    }
    if (!String(args.answer || '').trim() && action !== 'zoom_out') {
      throw new Error('answer 不能为空')
    }
    const node = findBuildNode(build, { path: build.human.path })
    if (!node) throw new Error(`人工请求所属节点不存在：${build.human.path}`)
    const active = build.human
    resetNodeForRebuild(build, node, {
      action,
      answer: args.answer,
      angle: args.angle,
      scope: args.scope,
    })
    saveBuildState(dataDir, build)
    return active
  })
  // 答复后从断点恢复整个共享构建栈（嵌套占位同样逐个开子会话），锁外执行避免重入
  const rootSessionId = stackRootOf(dataDir, sessionId)
  const stack = loadOrCreateStack(dataDir, rootSessionId, null)
  const build = loadBuildOrFail(dataDir, sessionId)
  const { entry } = ensureStackEntry(stack, entryFieldsForBuild(dataDir, build))
  entry.session_id = entry.session_id || sessionId
  saveStack(dataDir, stack)
  const drive = queueStackDrive(dataDir, stack.root_session_id, stack, dependencies)
  if (args.background) void drive
  else await drive
  resolveHumanMail(dataDir, loadBuildOrFail(dataDir, sessionId), request)
  return {
    ...describeBuild(loadBuildOrFail(dataDir, sessionId)),
    ...(args.background ? { background: true } : {}),
  }
}

export async function getBuild(args) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = buildSessionId(args)
  const build = loadBuildOrFail(dataDir, sessionId)
  if (args.build_id && String(args.build_id) !== build.id) {
    throw new Error(`build_id 不匹配：${args.build_id}`)
  }
  return describeBuild(build)
}

async function resumeRunRecord(dataDir, runId, dependencies, input) {
  return withRunLock(dataDir, runId, async () => {
    const run = loadRun(dataDir, runId)
    if (!['waiting_human', 'paused'].includes(run.status)) {
      throw new Error(`运行 ${runId} 当前为 ${run.status}，不是等待人工输入或暂停状态`)
    }
    if (run.status === 'waiting_human' && input === undefined) {
      throw new Error('恢复人工节点时必须提供 input')
    }
    if (run.pending?.subflow_run_id) {
      const childId = run.pending.subflow_run_id
      const child = await resumeRunRecord(dataDir, childId, dependencies, input)
      if (['waiting_human', 'paused'].includes(child.status)) {
        run.pending = {
          ...run.pending,
          prompt: child.pending?.prompt || run.pending.prompt,
          subflow_path: child.pending?.path || null,
          subflow_run_id: child.id,
        }
        run.current = { ...run.pending }
        return saveState(dataDir, run)
      }
      const failed = child.status !== 'completed'
      return advanceAndSave(dataDir, run, dependencies, {
        resume: {
          path: run.pending.path,
          value: failed ? null : child.output,
          failed,
          error: child.error || null,
          subflow_run_id: child.id,
        },
      })
    }
    if (input !== undefined && !run.pending) {
      throw new Error('当前暂停没有等待中的人工节点，不能注入 input')
    }
    return advanceAndSave(dataDir, run, dependencies, input !== undefined
      ? { resume: { path: run.pending.path, value: input } }
      : {})
  })
}

function waitingRunForSession(dataDir, sessionId) {
  if (!sessionId) throw new Error('run_id 或 session_id 不能为空')
  const runs = listRuns(dataDir).filter(run => run.parent_session_id === sessionId
    && ['waiting_human', 'paused'].includes(run.status))
  if (!runs.length) throw new Error(`会话 ${sessionId} 没有等待人工输入或暂停的运行`)
  const roots = runs.filter(run => run.pending?.subflow_run_id)
  const pool = roots.length ? roots : runs
  return pool
    .sort((a, b) => (a.depth || 0) - (b.depth || 0) || String(b.created_at).localeCompare(String(a.created_at)))[0].id
}

export async function resumeFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  let runId = String(args.run_id || '').trim()
  if (!runId) {
    runId = waitingRunForSession(dataDir, String(args.session_id || args.parent_session_id || '').trim())
  }
  const result = await resumeRunRecord(dataDir, runId, dependencies, hasOwn(args, 'input') ? args.input : undefined)
  await syncSessionAfterRun(dataDir, result, dependencies)
  return result
}

function insertHumanDraft(run, rawAction) {
  if (!run.definition || run.definition.entry?.type !== 'sequence' || !run.current?.node_id) {
    throw new Error('当前位置不能直接插入人工节点，请改为重新规划')
  }
  const entry = run.definition.entry
  const expectedPath = `/${entry.id}/${run.current.node_id}`
  if (run.current.path !== expectedPath) throw new Error('嵌套节点位置需要重新规划，不能直接插入')
  const index = entry.steps.findIndex(step => step.id === run.current.node_id)
  if (index < 0) throw new Error('当前节点不在根 sequence 中')
  const definition = clone(run.definition)
  definition.entry.steps.splice(index, 0, {
    id: `interrupt_${randomUUID().slice(0, 8)}`,
    type: 'human',
    label: '监督人工中断',
    prompt: rawAction.prompt || rawAction.reason || '请确认监督中断后要继续执行的输入',
  })
  validateDefinition(definition)
  return {
    summary: `在 ${run.current.label || run.current.node_id} 前插入人工中断`,
    definition,
    input: clone(run.input),
    citations: [],
    retrieval: null,
  }
}

async function supervisedAction(run, rawAction, dependencies) {
  const active = ['running', 'waiting_human', 'paused', 'failed', 'draft', 'plan_failed']
  if (rawAction.type === 'pause') {
    if (!['running', 'waiting_human'].includes(run.status)) return null
    return addAction(run, 'pause', rawAction)
  }
  if (rawAction.type === 'terminate') {
    if (!active.includes(run.status)) return null
    return addAction(run, 'terminate', rawAction)
  }
  if (rawAction.type === 'replan') {
    if (!active.includes(run.status)) return null
    const draft = await planDefinition({
      task: run.task || run.name,
      instruction: rawAction.instruction || rawAction.reason,
      input: run.input,
      current_definition: run.definition,
      current_status: run.status,
    }, dependencies)
    return addAction(run, 'replan', { ...rawAction, draft })
  }
  if (rawAction.type === 'insert_human') {
    if (!['waiting_human', 'paused'].includes(run.status)) return null
    const draft = insertHumanDraft(run, rawAction)
    return addAction(run, 'insert_human', { ...rawAction, draft })
  }
  return null
}

async function superviseAndSave(dataDir, run, instruction, dependencies = {}, mode = 'manual') {
  run.supervision = { enabled: true, ...run.supervision }
  if (instruction) appendMessage(run, 'user', instruction)
  if (instruction) saveState(dataDir, run)
  try {
    const analysis = await analyzeRun(run, instruction, dependencies)
    const warnings = []
    for (const rawAction of analysis.actions) {
      try {
        const action = await supervisedAction(run, rawAction, dependencies)
        if (!action) warnings.push(`${rawAction.type} 与当前状态不匹配，未创建动作`)
      } catch (error) {
        warnings.push(`${rawAction.type} 未创建：${error.message || error}`)
      }
    }
    appendMessage(run, 'supervisor', analysis.conclusion, { mode })
    if (warnings.length) {
      appendMessage(run, 'system', warnings.map(item => `监督动作未生效：${item}`).join('\n'), { mode })
    }
    run.supervision = {
      ...run.supervision,
      enabled: true,
      last_analysis_at: now(),
      last_mode: mode,
      error: null,
      warnings,
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    run.supervision = { ...run.supervision, enabled: true, error: message, last_analysis_at: now() }
    appendMessage(run, 'system', `监督分析失败：${message}`, { mode })
  }
  return saveState(dataDir, run)
}

export async function instructFlow(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const runId = String(args.run_id || '')
  const instruction = String(args.instruction || '请分析当前运行状态，判断是否需要干预').trim()
  return withRunLock(dataDir, runId, async () => {
    const run = loadRun(dataDir, runId)
    // 草稿尚未执行：修改要求直接走会话级修订，重新澄清并规划，避免在草稿上做无效监督。
    if (run.status === 'draft') {
      return reviseFlow({ data_dir: dataDir, session_id: run.parent_session_id, instruction }, dependencies)
    }
    return superviseAndSave(dataDir, run, instruction, dependencies, 'manual')
  })
}

function definitionNodes(definition) {
  const nodes = new Map()
  function visit(node) {
    if (!node) return
    nodes.set(node.id, node)
    if (node.type === 'sequence') node.steps.forEach(visit)
    else if (node.type === 'branch') { visit(node.then); visit(node.else) }
    else if (node.type === 'fold' || node.type === 'loop') visit(node.body)
    else if (node.type === 'or_else') { visit(node.primary); visit(node.fallback) }
  }
  if (definition?.entry) visit(definition.entry)
  return nodes
}

function compatibleCache(run) {
  const nodes = definitionNodes(run.definition)
  return (run.trace || []).filter(entry => entry.status === 'completed' && nodes.has(entry.node_id)).map(entry => {
    const cached = clone(entry)
    cached.node_hash = hashNode(nodes.get(entry.node_id))
    cached.reused_from = { run_id: run.id, path: entry.path }
    return cached
  })
}

function resolveAction(run, action, status) {
  action.status = status
  action.resolved_at = now()
}

export function defineFlow(args) {
  const dataDir = resolveDataDir(args.data_dir)
  const name = String(args.name || '').trim()
  if (!name) throw new Error('name 不能为空')
  const definition = clone(args.definition)
  validateDefinition(definition)
  const record = definitionExists(dataDir, name)
    ? loadDefinitionRecord(dataDir, name)
    : { version: 1, name, active_version: 0, versions: [], created_at: now() }
  const version = (record.versions.at(-1)?.version || 0) + 1
  record.versions.push({ version, definition, created_at: now() })
  if (args.activate !== false) record.active_version = version
  record.updated_at = now()
  saveDefinition(dataDir, record)
  return {
    name,
    version,
    active_version: record.active_version,
    versions: record.versions.map(item => ({
      version: item.version,
      created_at: item.created_at,
      name: item.definition?.name || null,
    })),
  }
}

export function listDefinitions(args = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const records = listDefinitionRecords(dataDir)
  if (args.name) {
    const record = records.find(item => item.name === String(args.name))
    if (!record) throw new Error(`工作流定义不存在：${args.name}`)
    return {
      name: record.name,
      active_version: record.active_version,
      updated_at: record.updated_at || null,
      versions: record.versions.map(item => ({
        version: item.version,
        created_at: item.created_at,
        definition: item.version === record.active_version ? item.definition : undefined,
      })),
    }
  }
  return records.map(record => ({
    name: record.name,
    active_version: record.active_version,
    version_count: (record.versions || []).length,
    updated_at: record.updated_at || null,
  }))
}

export async function configureWorkspace(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  return withSessionLock(dataDir, sessionId, async () => {
    const session = loadSession(dataDir, sessionId)
    const workspace = resolveWorkspace(dataDir, session.id, args.workspace)
    const changed = session.workspace !== workspace
    const revision = changed ? (session.workspace_revision || 0) + 1 : (session.workspace_revision || 0)
    session.workspace = workspace
    session.workspace_revision = revision
    const parentMirror = session.parent_session_id && sessionExists(dataDir, session.parent_session_id)
      ? loadSession(dataDir, session.parent_session_id).dsh_session_id || null
      : null
    await alignSession(session, dependencies, revision ? `${session.id}-ws-${revision}` : session.id, parentMirror)
    appendSessionMessage(session, 'system', `会话工作目录已设为 ${session.workspace}`)
    saveSessionState(dataDir, session)
    if (session.draft_run_id) {
      try {
        const draft = loadRun(dataDir, session.draft_run_id)
        if (draft.status === 'draft') {
          draft.workspace = session.workspace
          draft.workspace_id = session.workspace_id || null
          draft.dsh_session_id = session.dsh_session_id || null
          appendMessage(draft, 'system', `会话工作目录更新为 ${session.workspace}`)
          saveState(dataDir, draft)
        }
      } catch {}
    }
    return sessionView(dataDir, session.id)
  })
}

async function activateVersion(dataDir, run, action, dependencies) {
  const draft = action.draft
  if (!draft?.definition) throw new Error('待确认动作缺少新工作流定义')
  const definition = clone(draft.definition)
  validateDefinition(definition)
  const launches = run.status !== 'draft'
  if (launches) assertExecutable(definition)
  const input = validateInput(definition, draft.input)
  const next = makeRunRecord({
    parent_session_id: run.parent_session_id,
    workspace: resolveWorkspace(dataDir, run.parent_session_id, run.workspace),
    workspace_id: run.workspace_id || null,
    dsh_session_id: run.dsh_session_id || null,
    name: run.name,
    task: run.task,
    definition,
    input,
    definition_version: (run.definition_version || 1) + 1,
    previous_run_id: run.id,
    supervision: run.supervision,
    planner: {
      kind: action.type,
      summary: draft.summary,
      citations: draft.citations || [],
      retrieval: draft.retrieval || null,
    },
    status: launches ? 'running' : 'draft',
  })
  const cache = compatibleCache(run)
  resolveAction(run, action, 'confirmed')
  run.status = 'superseded'
  run.superseded_by = next.id
  appendMessage(run, 'system', `已确认 ${action.type}，创建${launches ? '并启动' : ''}工作流版本 v${next.definition_version}`)
  saveState(dataDir, run)
  saveRun(dataDir, next)
  if (!launches) {
    addAction(next, 'start', { reason: '确认新草稿并启动执行' })
    appendMessage(next, 'system', `新草稿 v${next.definition_version} 已生成，等待确认启动`)
    return saveState(dataDir, next)
  }
  return advanceAndSave(dataDir, next, dependencies, { cache })
}

export async function confirmFlow(args, dependencies = {}) {
  if (typeof args.approved !== 'boolean') throw new Error('approved 必须是 boolean')
  const dataDir = resolveDataDir(args.data_dir)
  const runId = String(args.run_id || '')
  return withRunLock(dataDir, runId, async () => {
    const run = loadRun(dataDir, runId)
    const action = (run.pending_actions || []).find(item => item.id === args.action_id)
    if (!action) throw new Error('待确认动作不存在')
    if (action.status !== 'pending') throw new Error(`动作当前为 ${action.status}，不能重复处理`)
    if (!args.approved) {
      resolveAction(run, action, 'rejected')
      appendMessage(run, 'system', `已拒绝 ${action.type}：${action.reason}`)
      return saveState(dataDir, run)
    }
    const expected = action.expected
    const current = {
      status: run.status,
      current_path: run.current?.path || null,
      definition_version: run.definition_version || 1,
    }
    if (JSON.stringify(expected) !== JSON.stringify(current)) {
      resolveAction(run, action, 'stale')
      appendMessage(run, 'system', `${action.type} 已因运行状态变化而过期`)
      saveState(dataDir, run)
      throw new Error('动作已过期，请重新进行监督分析')
    }
    if (action.type === 'start') {
      if (run.status !== 'draft' || !run.definition) throw new Error('只有有效规划草稿可以启动')
      assertExecutable(run.definition)
      resolveAction(run, action, 'confirmed')
      run.status = 'running'
      run.error = null
      appendMessage(run, 'system', '已确认工作流，开始按 IR 执行')
      saveState(dataDir, run)
      const result = await advanceAndSave(dataDir, run, dependencies)
      await syncSessionAfterRun(dataDir, result, dependencies)
      return result
    }
    if (action.type === 'pause') {
      resolveAction(run, action, 'confirmed')
      run.paused_from = run.status
      run.status = 'paused'
      appendMessage(run, 'system', '已确认暂停；可在稳定边界继续推进')
      const result = saveState(dataDir, run)
      await syncSessionAfterRun(dataDir, result, dependencies)
      return result
    }
    if (action.type === 'terminate') {
      resolveAction(run, action, 'confirmed')
      run.status = 'cancelled'
      run.pending = null
      run.current = null
      run.cancelled_at = now()
      appendMessage(run, 'system', '已确认终止工作流，轨迹已保留')
      const result = saveState(dataDir, run)
      await syncSessionAfterRun(dataDir, result, dependencies)
      return result
    }
    if (action.type === 'replan' || action.type === 'insert_human') {
      const result = await activateVersion(dataDir, run, action, dependencies)
      await syncSessionAfterRun(dataDir, result, dependencies)
      return result
    }
    throw new Error(`未知确认动作：${action.type}`)
  })
}

export function getFlow(args) {
  return loadRun(resolveDataDir(args.data_dir), String(args.run_id || ''))
}

export function getSessionRuns(args = {}) {
  const parentSessionId = String(args.parent_session_id || '').trim()
  if (!parentSessionId) throw new Error('parent_session_id 不能为空')
  const runs = listRuns(resolveDataDir(args.data_dir))
    .filter(run => run.parent_session_id === parentSessionId)
  const messages = new Map()
  const actions = new Map()
  for (const run of runs) {
    for (const message of run.messages || []) {
      if (!messages.has(message.id)) messages.set(message.id, {
        ...message, run_id: run.id, definition_version: run.definition_version || 1,
      })
    }
    for (const action of run.pending_actions || []) {
      if (!actions.has(action.id)) actions.set(action.id, {
        ...action, run_id: run.id, definition_version: run.definition_version || 1,
      })
    }
  }
  return {
    parent_session_id: parentSessionId,
    runs: runs.map(run => {
      const { definition, ...rest } = run
      return {
        ...rest,
        build_placeholders: collectBuildPlaceholders(definition || {}).map(item => ({ node_id: item.node_id, label: item.label })),
      }
    }),
    messages: [...messages.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
    actions: [...actions.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
  }
}

function normalizeMailRefs(raw) {
  if (!isObject(raw)) return { run_id: null, node_path: null, node_id: null }
  return {
    run_id: raw.run_id ? String(raw.run_id) : null,
    node_path: raw.node_path ? String(raw.node_path) : null,
    node_id: raw.node_id ? String(raw.node_id) : null,
  }
}

function mailBody(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.length > MAIL_BODY_LIMIT ? `${text.slice(0, MAIL_BODY_LIMIT)}…[已截断]` : text
}

function appendMailEnvelope(dataDir, input) {
  const envelope = {
    id: `mail-${randomUUID().slice(0, 8)}`,
    from_session: input.from,
    to_session: input.to,
    kind: input.kind,
    subject: String(input.subject || '').trim() || input.kind,
    body: mailBody(input.body),
    refs: normalizeMailRefs(input.refs),
    requires_reply: Boolean(input.requires_reply),
    reply_to: input.reply_to || null,
    status: 'unread',
    created_at: now(),
  }
  appendMail(dataDir, envelope)
  return envelope
}

function resolveMailPair(dataDir, fromId, toId) {
  const from = loadSession(dataDir, fromId)
  const to = loadSession(dataDir, toId)
  if (sessionRoot(from) !== sessionRoot(to)) throw new Error('只能在同一个根会话树内通信')
  return { from, to }
}

function refreshBuildMailbox(dataDir, build) {
  if (!build?.session_id || !sessionExists(dataDir, build.session_id)) return []
  const session = loadSession(dataDir, build.session_id)
  const unread = unreadMails(dataDir, session).slice(-MAIL_INJECT_LIMIT)
  if (!unread.length) return []
  build.mailbox = [...(build.mailbox || []), ...unread.map(mail => ({
    id: mail.id,
    from_session: mail.from_session,
    kind: mail.kind,
    subject: mail.subject,
    body: mail.body,
  }))].slice(-MAIL_INJECT_LIMIT)
  session.mail_read = [...new Set([...(session.mail_read || []), ...unread.map(mail => mail.id)])]
  saveSessionState(dataDir, session)
  return unread
}

function notifyBuildHuman(dataDir, build) {
  const request = build.human
  const parentId = build.origin?.parent_session_id
  if (!request || !parentId || !sessionExists(dataDir, parentId) || build.human_mail_id) return null
  const envelope = appendMailEnvelope(dataDir, {
    from: build.session_id,
    to: parentId,
    kind: 'question',
    subject: `构建人工请求：${request.node_id}`,
    body: [
      `子会话 ${build.session_id} 在节点 ${request.path}（${request.node_id}）需要人工确认：`,
      request.question,
      request.options?.length ? `可选答案：${request.options.join(' / ')}` : '',
      request.suggested_zoom ? `建议 zoom：${request.suggested_zoom}` : '',
      '可以直接回复本信给出答复，也可以对子会话调用 flow_build answer。',
    ].filter(Boolean).join('\n'),
    refs: { run_id: build.origin?.run_id, node_path: request.path, node_id: request.node_id },
    requires_reply: true,
  })
  build.human_mail_id = envelope.id
  appendSessionMessage(loadSession(dataDir, build.session_id), 'system',
    `人工请求已通过信箱通知父会话 ${parentId}`, { mail_id: envelope.id })
  saveSessionState(dataDir, loadSession(dataDir, build.session_id))
  return envelope
}

function resolveHumanMail(dataDir, build, request) {
  const parentId = build.origin?.parent_session_id
  if (!request?.path || !parentId || !sessionExists(dataDir, parentId)) return null
  const parent = loadSession(dataDir, parentId)
  const resolved = new Set(parent.mail_resolved || [])
  const pending = loadMailbox(dataDir, parentId).filter(mail => mail.from_session === build.session_id
    && mail.kind === 'question'
    && mail.refs?.node_path === request.path
    && !resolved.has(mail.id))
  if (!pending.length) return null
  parent.mail_resolved = [...new Set([...resolved, ...pending.map(mail => mail.id)])]
  saveSessionState(dataDir, parent)
  return pending.map(mail => mail.id)
}

async function applyMailToBuild(dataDir, session, envelope, dependencies) {
  if (envelope.kind === 'bug_report') return rebuildFromMail(dataDir, session, envelope, dependencies)
  if (envelope.kind !== 'answer') return null
  if (!buildExists(dataDir, session.id)) {
    return { applied: false, reason: '目标会话没有构建状态，已按普通信件入信箱' }
  }
  return withSessionLock(dataDir, session.id, async () => {
    const build = loadBuild(dataDir, session.id)
    if (build.status !== 'waiting_human' || !build.human) {
      return { applied: false, reason: `构建当前为 ${build.status}，没有等待人工请求` }
    }
    const request = build.human
    if (envelope.refs?.node_path && envelope.refs.node_path !== request.path) {
      return { applied: false, reason: '信件引用的节点与等待中的请求不一致' }
    }
    const node = findBuildNode(build, { path: request.path, node_id: request.node_id })
    if (!node) return { applied: false, reason: '信件没有命中构建节点' }
    resetNodeForRebuild(build, node, { action: 'mailbox', answer: envelope.body })
    build.mail_reply_to = null
    saveBuildState(dataDir, build)
    const limit = build.limits.max_sessions + 8
    for (let index = 0; index < limit && build.status === 'building'; index += 1) {
      await stepBuildState(dataDir, build, dependencies)
    }
    return {
      applied: true,
      session_id: session.id,
      node_path: node.path,
      node_id: node.id,
      status: build.status,
      run_id: build.run_id || null,
    }
  })
}

async function rebuildFromMail(dataDir, session, envelope, dependencies) {
  if (!buildExists(dataDir, session.id)) {
    return { applied: false, reason: '目标会话没有构建状态，已按普通信件入信箱' }
  }
  return withSessionLock(dataDir, session.id, async () => {
    const build = loadBuild(dataDir, session.id)
    if (!['building', 'waiting_human', 'awaiting_confirm', 'awaiting_accept', 'accepted', 'failed'].includes(build.status)) {
      return { applied: false, reason: `构建当前为 ${build.status}，未触发重建` }
    }
    const node = findBuildNode(build, { path: envelope.refs?.node_path, node_id: envelope.refs?.node_id })
    if (!node) return { applied: false, reason: '信件没有命中构建节点' }
    resetNodeForRebuild(build, node, { action: 'mailbox', answer: envelope.body })
    build.mail_reply_to = { id: envelope.id, from_session: envelope.from_session, subject: envelope.subject }
    session.mail_read = [...new Set([...(session.mail_read || []), envelope.id])]
    saveSessionState(dataDir, session)
    saveBuildState(dataDir, build)
    const limit = build.limits.max_sessions + 8
    for (let index = 0; index < limit && build.status === 'building'; index += 1) {
      await stepBuildState(dataDir, build, dependencies)
    }
    return {
      applied: true,
      session_id: session.id,
      node_path: node.path,
      node_id: node.id,
      status: build.status,
      run_id: build.run_id || null,
    }
  })
}

export async function sendMail(args, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const fromId = String(args.session_id || args.from_session || '').trim()
  const toId = String(args.to_session || '').trim()
  if (!fromId) throw new Error('session_id 不能为空')
  if (!toId) throw new Error('to_session 不能为空')
  if (fromId === toId) throw new Error('不能给自己发信')
  const kind = String(args.kind || 'note').trim()
  if (!MAIL_KINDS.has(kind)) throw new Error(`kind 仅支持 ${[...MAIL_KINDS].join('/')}`)
  const { from, to } = resolveMailPair(dataDir, fromId, toId)
  if ((to.depth || 0) > sessionMaxDepth()) {
    throw new Error(`目标会话深度 ${to.depth} 超过信箱上限 ${sessionMaxDepth()}（RMS_FLOW_SESSION_MAX_DEPTH）`)
  }
  const refs = normalizeMailRefs(args.refs)
  const subject = String(args.subject || '').trim() || `${kind}: ${from.name || from.id}`
  const resolved = new Set(to.mail_resolved || [])
  const existing = loadMailbox(dataDir, toId).find(mail => mail.from_session === fromId
    && mail.subject === subject
    && (mail.refs?.node_path || null) === refs.node_path
    && !resolved.has(mail.id))
  if (existing) return { reused: true, mail: existing, rebuild: null }
  const envelope = appendMailEnvelope(dataDir, {
    from: fromId,
    to: toId,
    kind,
    subject,
    body: args.body,
    refs,
    requires_reply: hasOwn(args, 'requires_reply') ? args.requires_reply : ['question', 'bug_report'].includes(kind),
    reply_to: args.reply_to,
  })
  const delivered = kind === 'bug_report' || kind === 'answer'
    ? await applyMailToBuild(dataDir, to, envelope, dependencies)
    : null
  return {
    reused: false,
    mail: envelope,
    rebuild: kind === 'bug_report' ? delivered : null,
    applied: kind === 'answer' ? delivered : null,
  }
}

export function inboxMail(args = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  const session = loadSession(dataDir, sessionId)
  const mails = loadMailbox(dataDir, sessionId)
  const unread = unreadMails(dataDir, session)
  let markedRead = 0
  if (args.mark_read !== false && unread.length) {
    session.mail_read = [...new Set([...(session.mail_read || []), ...unread.map(mail => mail.id)])]
    saveSessionState(dataDir, session)
    markedRead = unread.length
  }
  return { session_id: sessionId, unread: unread.length, marked_read: markedRead, mails }
}

export function sessionMail(args = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const sessionId = String(args.session_id || '').trim()
  if (!sessionId) throw new Error('session_id 不能为空')
  const session = loadSession(dataDir, sessionId)
  const limit = Math.min(Math.max(Number(args.limit) || 300, 1), 1000)
  const allSessions = listSessions(dataDir)
  const byId = new Map(allSessions.map(item => [item.id, item]))
  const root = byId.get(sessionRoot(session)) || session
  const tree = [root, ...descendantSessions(allSessions, root.id)]
  if (!tree.some(item => item.id === session.id)) tree.push(session)
  const seen = new Set()
  const mails = []
  for (const item of tree) {
    const read = new Set(item.mail_read || [])
    const resolved = new Set(item.mail_resolved || [])
    for (const mail of loadMailbox(dataDir, item.id)) {
      if (seen.has(mail.id)) continue
      seen.add(mail.id)
      mails.push({
        ...mail,
        from_name: byId.get(mail.from_session)?.name || mail.from_session,
        to_name: byId.get(mail.to_session)?.name || mail.to_session,
        read: read.has(mail.id),
        resolved: resolved.has(mail.id),
      })
    }
  }
  mails.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  return {
    session_id: session.id,
    root_session_id: root.id,
    total: mails.length,
    unread: unreadMails(dataDir, session).length,
    tree_unread: mails.filter(mail => !mail.read).length,
    pending_reply: mails.filter(mail => mail.requires_reply && !mail.resolved).length,
    sessions: tree.map(item => ({
      id: item.id,
      name: item.name,
      status: item.status,
      parent_session_id: item.parent_session_id || null,
      unread_mail: unreadMails(dataDir, item).length,
    })),
    mails: mails.slice(-limit),
  }
}

export async function replyMail(args = {}, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const fromId = String(args.session_id || '').trim()
  const replyTo = String(args.reply_to || '').trim()
  if (!fromId) throw new Error('session_id 不能为空')
  if (!replyTo) throw new Error('reply_to 不能为空')
  if (!String(args.body || '').trim()) throw new Error('body 不能为空')
  const original = loadMailbox(dataDir, fromId).find(mail => mail.id === replyTo)
  if (!original) throw new Error(`没有找到要回复的信件：${replyTo}`)
  const { from, to } = resolveMailPair(dataDir, fromId, original.from_session)
  const envelope = appendMailEnvelope(dataDir, {
    from: fromId,
    to: original.from_session,
    kind: 'answer',
    subject: `re: ${original.subject}`,
    body: args.body,
    refs: original.refs,
    reply_to: original.id,
  })
  if (!from.mail_resolved?.includes(original.id)) {
    from.mail_resolved = [...(from.mail_resolved || []), original.id]
    saveSessionState(dataDir, from)
  }
  const applied = await applyMailToBuild(dataDir, to, envelope, dependencies)
  return { mail: envelope, applied }
}

export function listFlow(args = {}) {
  const parentSessionId = String(args.parent_session_id || '').trim()
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
  const filtered = listRuns(resolveDataDir(args.data_dir))
    .filter(run => !parentSessionId || run.parent_session_id === parentSessionId)
  const groups = new Map()
  for (const run of filtered.slice(0, limit)) {
    const key = run.parent_session_id
    if (!groups.has(key)) groups.set(key, { parent_session_id: key, runs: [] })
    groups.get(key).runs.push(runSummary(run))
  }
  return { total: filtered.length, groups: [...groups.values()] }
}
