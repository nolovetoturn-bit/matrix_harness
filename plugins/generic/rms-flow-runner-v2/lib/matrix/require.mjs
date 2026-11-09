import { agentEvent, chatMessage } from './messages.mjs'
import { analyzeRequirement, planSkeleton } from '../ai.mjs'
import { assertSkeletonContracts } from './contracts.mjs'
import { readonlyDefinition } from './schema.mjs'
import { STATES } from './state.mjs'
import { matrixWorkDir } from './store.mjs'
import { loadProject, projectWorkDir } from '../project/store.mjs'
import { loadDomain } from '../domain/store.mjs'
import { assertDomainSkeleton, domainContextOf, domainPromptContext } from '../domain/policy.mjs'

const now = () => new Date().toISOString()

/** 会话镜像的 workspace：有项目时统一到项目 cwd（dsh 侧栏按项目分组），否则用根 matrix 的 work。 */
function sessionWorkspaceOf(matrix, dataDir) {
  if (matrix.project_id) {
    try {
      const project = loadProject(dataDir, matrix.project_id)
      return project.cwd || projectWorkDir(dataDir, project.id)
    } catch {}
  }
  return matrixWorkDir(dataDir, matrix.root_id || matrix.id)
}

/**
 * 每个 matrix 一个 dsh 会话；子 matrix 通过 parentSession 挂到父会话下，dsh 侧栏自然成树。
 * @param {string|null} sessionId - 指定绑定会话 id（坏会话换绑时使用）；缺省用 matrix.id
 */
export async function ensureMatrixSession(matrix, dependencies = {}, parentMatrix = null, sessionId = null) {
  if (matrix.dsh_session_id && !sessionId) return matrix
  matrix.cwd = matrix.cwd || matrixWorkDir(dependencies.dataDir, matrix.id)
  if (typeof dependencies.sessionMirror !== 'function') return matrix
  // dsh 侧栏按 workspace 分组、组内才能按 parentSession 嵌套；整棵 matrix 树的会话统一挂在项目
  // 的工作目录下（无项目时退回根 matrix 的 work）。matrix.cwd 仍然是各自独立的工作目录，只影响执行。
  const targetSession = sessionId || matrix.dsh_session_id || matrix.id
  const sessionWorkspace = sessionWorkspaceOf(matrix, dependencies.dataDir)
  // 领域元素的根 matrix 会话挂到领域会话下；子 matrix 仍挂父 matrix
  let parentSessionId = parentMatrix ? parentMatrix.dsh_session_id || parentMatrix.id : null
  if (!parentMatrix && matrix.domain_binding) {
    try {
      const domain = loadDomain(dependencies.dataDir, matrix.domain_binding.domain_id)
      parentSessionId = domain.dsh_session_id || domain.id
    } catch {}
  }
  const mirrored = await dependencies.sessionMirror({
    sessionId: targetSession,
    // 绑定语境里的 matrix id 与 dsh 会话 id 分开：坏会话换绑后会话 id 会带后缀
    matrixId: matrix.id,
    workspace: sessionWorkspace,
    title: matrix.name,
    task: matrix.task,
    parentSessionId,
  })
  matrix.dsh_session_id = mirrored.session_id || targetSession
  return matrix
}

/** 需求分析结果落到 matrix 上：信息足够 → awaiting_requirement；不足 → clarifying。 */
export function applyAnalysis(matrix, analysis) {
  matrix.analysis = {
    sufficient: analysis.sufficient,
    questions: analysis.questions || [],
    missing: analysis.missing || [],
    summary: analysis.summary || '',
    analyzed_at: now(),
  }
  if (analysis.assumptions && analysis.assumptions.length) {
    matrix.assumptions = [...new Set([...(matrix.assumptions || []), ...analysis.assumptions])].slice(0, 20)
  }
  if (analysis.sufficient) {
    matrix.state = STATES.AWAITING_REQUIREMENT
    agentEvent(matrix, `需求分析完成：信息足够。${analysis.summary || ''}`.trim())
  } else {
    matrix.state = STATES.CLARIFYING
    agentEvent(matrix, `需求分析：信息不足，需要澄清。\n${(analysis.questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n')}`)
  }
}

/**
 * 受理：建 matrix → 建会话 → 需求分析。
 */
export async function intakeMatrix({ dataDir, task, name, parent_id = null, parentMatrix = null, record, dependencies = {} }) {
  await ensureMatrixSession(record, { ...dependencies, dataDir }, parentMatrix)
  chatMessage(record, 'user', task)
  agentEvent(record, `受理任务，开始需求分析。`)
  const analysis = await analyzeRequirement({
    task: record.task,
    round: 0,
    clarifications: [],
  }, dependencies)
  applyAnalysis(record, analysis)
  return record
}

/** 回答澄清问题后重新分析。 */
export async function answerClarification(matrix, answer, dependencies = {}) {
  const text = String(answer || '').trim()
  if (!text) throw new Error('answer 不能为空')
  const pendingQuestions = matrix.analysis?.questions || []
  matrix.clarifications = [...(matrix.clarifications || []), { question: pendingQuestions.join(' / ') || '澄清', answer: text, at: now() }].slice(-20)
  chatMessage(matrix, 'user', text)
  const analysis = await analyzeRequirement({
    task: matrix.task,
    round: (matrix.clarifications || []).length,
    clarifications: matrix.clarifications,
  }, dependencies)
  applyAnalysis(matrix, analysis)
  return matrix
}

/** 生成/重新生成骨架 DAG。 */
export async function generateSkeleton(matrix, { instruction = null, dataDir = null } = {}, dependencies = {}) {
  agentEvent(matrix, instruction ? `按修改意见重新生成骨架 DAG：${instruction}` : '开始生成骨架 DAG。')
  const domainContext = domainContextOf(dataDir, matrix)
  const planned = await planSkeleton({
    task: matrix.task,
    analysis: matrix.analysis,
    clarifications: matrix.clarifications,
    assumptions: matrix.assumptions,
    instruction,
    previousSkeleton: matrix.skeleton,
    childHint: matrix.depth > 0 ? { depth: matrix.depth } : null,
    domainContext: domainPromptContext(domainContext),
  }, dependencies)
  assertSkeletonContracts(planned.skeleton)
  assertDomainSkeleton(domainContext, planned.skeleton)
  matrix.skeleton = planned.skeleton
  matrix.skeleton.summary = planned.summary
  // 新骨架会替换旧 DAG，旧子 matrix 引用随旧结构失效；预构建时按新 group 节点重新创建
  matrix.children = []
  matrix.stub_refs = {}
  matrix.domain_dependencies = []
  // DAG 确认阶段即可查看只读定义：节点类型与 Cin/Cout 已锁定
  matrix.dag = readonlyDefinition(matrix.skeleton, { childRefs: childRefsOf(matrix) })
  matrix.dag_confirmed_at = null
  matrix.acceptance_criteria = planned.acceptance_criteria.length
    ? planned.acceptance_criteria
    : (matrix.acceptance_criteria || [])
  if (planned.assumptions.length) {
    matrix.assumptions = [...new Set([...(matrix.assumptions || []), ...planned.assumptions])].slice(0, 20)
  }
  matrix.state = STATES.AWAITING_DAG
  matrix.definition = null
  matrix.prebuild_done = false
  matrix.progress = { current_node: null, nodes: {}, started_at: null, finished_at: null }
  matrix.evaluation = null
  matrix.error = null
  delete matrix.accepted_at
  const typed = (matrix.skeleton.entry.children || []).map(node => `${node.id}:${node.type}`).join(' / ')
  agentEvent(matrix, `骨架 DAG 已生成（${planned.skeleton.node_count} 个节点：${typed}）：${planned.summary}`)
  return matrix
}

/** 需求修订：按当前状态决定重分析还是重生成 DAG。 */
export async function reviseMatrix(matrix, { task, instruction, dataDir = null } = {}, dependencies = {}) {
  const revision = String(instruction || '').trim()
  if (task !== undefined && String(task || '').trim()) {
    matrix.task = String(task).trim().slice(0, 4000)
    chatMessage(matrix, 'user', matrix.task)
  } else if (revision) {
    chatMessage(matrix, 'user', revision)
  }
  if (matrix.state === STATES.AWAITING_DAG) {
    return generateSkeleton(matrix, { instruction: revision || '按最新修订意见调整骨架', dataDir }, dependencies)
  }
  if (matrix.state === STATES.AWAITING_PREBUILD) {
    await generateSkeleton(matrix, { instruction: revision || '按最新修订意见重新生成骨架', dataDir }, dependencies)
    return matrix
  }
  const analysis = await analyzeRequirement({
    task: matrix.task,
    round: (matrix.clarifications || []).length,
    clarifications: matrix.clarifications,
    instruction: revision || null,
  }, dependencies)
  applyAnalysis(matrix, analysis)
  if (analysis.sufficient && matrix.skeleton) {
    // 需求被修订后旧骨架已失效，要求重新确认
    matrix.skeleton = null
    matrix.dag = null
    matrix.dag_confirmed_at = null
    matrix.definition = null
    matrix.prebuild_done = false
    agentEvent(matrix, '需求已修订，原骨架失效，请重新生成 DAG。')
  }
  return matrix
}

export function confirmDag(matrix, { dataDir = null } = {}) {
  if (matrix.state !== STATES.AWAITING_DAG) throw new Error(`当前状态 ${matrix.state} 不允许确认 DAG`)
  assertSkeletonContracts(matrix.skeleton)
  assertDomainSkeleton(domainContextOf(dataDir, matrix), matrix.skeleton)
  matrix.dag = readonlyDefinition(matrix.skeleton, { childRefs: childRefsOf(matrix) })
  matrix.dag_confirmed_at = new Date().toISOString()
  matrix.state = STATES.AWAITING_PREBUILD
  const typed = (matrix.skeleton?.entry?.children || []).map(node => node.id).join(' / ')
  agentEvent(matrix, `人工确认骨架 DAG（${typed}），节点类型与 Cin/Cout 已锁定，等待启动预构建。`)
  return matrix
}

function childRefsOf(matrix) {
  const result = {}
  for (const ref of matrix.children || []) result[ref.node_id] = ref
  return result
}
