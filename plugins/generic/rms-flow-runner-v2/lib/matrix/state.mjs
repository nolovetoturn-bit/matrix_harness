/**
 * matrix 状态机（纯函数，无 IO）。
 *
 * 门禁态（稳定）：awaiting_requirement / awaiting_dag / awaiting_prebuild / runnable / accepted
 * 瞬态：clarifying / building / awaiting_children / waiting_human / failed / cancelled
 *
 * awaiting_children 是“自身预构建完成、但仍有未验收子矩阵”的展示态：
 * 它不是可运行门禁态，不允许验收与运行，child accepted 后由 recomputeAfterChildAccept 升级为 runnable。
 */

export const STATES = Object.freeze({
  AWAITING_REQUIREMENT: 'awaiting_requirement',
  AWAITING_DAG: 'awaiting_dag',
  AWAITING_PREBUILD: 'awaiting_prebuild',
  RUNNABLE: 'runnable',
  ACCEPTED: 'accepted',
  CLARIFYING: 'clarifying',
  BUILDING: 'building',
  AWAITING_CHILDREN: 'awaiting_children',
  WAITING_HUMAN: 'waiting_human',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const GATE_STATES = Object.freeze([
  STATES.AWAITING_REQUIREMENT,
  STATES.AWAITING_DAG,
  STATES.AWAITING_PREBUILD,
  STATES.RUNNABLE,
  STATES.ACCEPTED,
])

export const TRANSIENT_STATES = Object.freeze([
  STATES.CLARIFYING,
  STATES.BUILDING,
  STATES.AWAITING_CHILDREN,
  STATES.WAITING_HUMAN,
  STATES.FAILED,
  STATES.CANCELLED,
])

const TERMINAL_STATES = new Set([STATES.ACCEPTED, STATES.CANCELLED])

/** 动作 → 合法起始状态。未列出的动作一律拒绝。 */
export const TRANSITIONS = Object.freeze({
  answer: [STATES.CLARIFYING],
  revise: [STATES.AWAITING_REQUIREMENT, STATES.AWAITING_DAG, STATES.AWAITING_PREBUILD],
  'generate-dag': [STATES.AWAITING_REQUIREMENT],
  'confirm-dag': [STATES.AWAITING_DAG],
  prebuild: [STATES.AWAITING_PREBUILD],
  'reopen-dag': [
    STATES.AWAITING_PREBUILD,
    STATES.AWAITING_CHILDREN,
    STATES.RUNNABLE,
    STATES.ACCEPTED,
    STATES.FAILED,
  ],
  retry: [STATES.FAILED],
  accept: [STATES.RUNNABLE],
  run: [STATES.RUNNABLE],
  evaluate: [STATES.RUNNABLE, STATES.ACCEPTED],
  cancel: [
    STATES.AWAITING_REQUIREMENT,
    STATES.AWAITING_DAG,
    STATES.AWAITING_PREBUILD,
    STATES.RUNNABLE,
    STATES.CLARIFYING,
    STATES.BUILDING,
    STATES.AWAITING_CHILDREN,
    STATES.WAITING_HUMAN,
    STATES.FAILED,
  ],
})

export const ACTION_LABELS = Object.freeze({
  answer: '回答澄清',
  revise: '提交修订',
  'generate-dag': '生成骨架 DAG',
  'confirm-dag': '确认 DAG',
  prebuild: '启动预构建',
  'reopen-dag': '回到 DAG 确认',
  retry: '重试',
  accept: '验收通过',
  run: '运行',
  evaluate: '评估运行',
  cancel: '终止',
})

export const isGateState = state => GATE_STATES.includes(state)
export const isTerminalState = state => TERMINAL_STATES.has(state)
export const isAccepted = matrix => Boolean(matrix && matrix.state === STATES.ACCEPTED)

/** 直接子矩阵（按 skeleton 顺序：children[] 记录 node_path，排序稳定） */
export const childrenOf = (matrix, matrices) => {
  const refs = Array.isArray(matrix?.children) ? matrix.children : []
  return refs
    .map(ref => matrices instanceof Map ? matrices.get(ref.matrix_id) : matrices[ref.matrix_id])
    .filter(Boolean)
}

export const allChildrenAccepted = (matrix, matrices) => childrenOf(matrix, matrices).every(isAccepted)

/** stub 节点依赖的领域根 matrix（domain_dependencies）。 */
export const dependenciesOf = (matrix, matrices) => (matrix?.domain_dependencies || [])
  .map(id => matrices instanceof Map ? matrices.get(id) : matrices[id])
  .filter(Boolean)

/** 依赖缺失或未验收都视为不满足，避免静默放行。 */
export function allDependenciesAccepted(matrix, matrices) {
  const ids = matrix?.domain_dependencies || []
  if (!ids.length) return true
  return ids.every(id => {
    const dependency = matrices instanceof Map ? matrices.get(id) : matrices[id]
    return Boolean(dependency && isAccepted(dependency))
  })
}

/** 可运行前置：全部子矩阵与全部领域依赖均已验收。 */
export const allPrerequisitesAccepted = (matrix, matrices) =>
  allChildrenAccepted(matrix, matrices) && allDependenciesAccepted(matrix, matrices)

/**
 * 预构建完成后的门禁态：全部直接子矩阵与领域依赖 accepted 才可运行。
 * 未验收依赖存在时进入 awaiting_children（展示“等待依赖验收”）。
 */
export function stateAfterPrebuild(matrix, matrices) {
  if (matrix.state === STATES.ACCEPTED) return STATES.ACCEPTED
  if (!matrix.prebuild_done) return matrix.state
  return allPrerequisitesAccepted(matrix, matrices) ? STATES.RUNNABLE : STATES.AWAITING_CHILDREN
}

/**
 * 子矩阵验收后自底向上重算：只允许“升级到 runnable”，永不回退。
 * @returns {boolean} 是否有状态变化
 */
export function recomputeAfterChildAccept(matrix, matrices) {
  if (matrix.state === STATES.ACCEPTED || matrix.state === STATES.CANCELLED) return false
  if (!matrix.prebuild_done) return false
  if (matrix.state === STATES.RUNNABLE) return false
  if (!allPrerequisitesAccepted(matrix, matrices)) return false
  matrix.state = STATES.RUNNABLE
  return true
}

/**
 * 校验动作是否合法；不合法时抛出带当前状态的中文错误。
 * @param {object} matrix - matrix 记录
 * @param {string} action - 动作名
 */
export function assertTransition(matrix, action) {
  const from = TRANSITIONS[action]
  if (!from) throw new Error(`不支持的动作：${action}`)
  if (!from.includes(matrix.state)) {
    throw new Error(`当前状态 ${matrix.state} 不允许执行 ${ACTION_LABELS[action] || action}（允许：${from.join(' / ')}）`)
  }
}

export const canAccept = (matrix, matrices) => deriveState(matrix, matrices) === STATES.RUNNABLE
export const canRun = (matrix, matrices) => deriveState(matrix, matrices) === STATES.RUNNABLE

/**
 * 对外展示状态。runnable 以“自身预构建完成 && 全部子矩阵 accepted”为唯一口径，
 * 避免外部把 awaiting_children 误判成可运行。
 */
export function deriveState(matrix, matrices) {
  if (matrix.state === STATES.ACCEPTED || matrix.state === STATES.CANCELLED) return matrix.state
  if (matrix.state === STATES.BUILDING || matrix.state === STATES.FAILED || matrix.state === STATES.WAITING_HUMAN) {
    return matrix.state
  }
  if (matrix.prebuild_done) return allPrerequisitesAccepted(matrix, matrices) ? STATES.RUNNABLE : STATES.AWAITING_CHILDREN
  return matrix.state
}

/** 当前状态下输入框的路由语义（面板提示用）。 */
export const INPUT_ROUTING = Object.freeze({
  [STATES.CLARIFYING]: { target: 'answer', hint: '当前输入将作为澄清问题的回答' },
  [STATES.AWAITING_REQUIREMENT]: { target: 'revise', hint: '当前输入将作为需求修订，重新分析需求' },
  [STATES.AWAITING_DAG]: { target: 'revise', hint: '当前输入将作为 DAG 修改意见，重新生成骨架' },
  [STATES.AWAITING_PREBUILD]: { target: 'revise', hint: '当前输入将修订需求并回到 DAG 确认' },
  [STATES.WAITING_HUMAN]: { target: 'answer', hint: '当前输入将回答节点提出的人工问题' },
  [STATES.BUILDING]: { target: 'mail', hint: '当前输入将作为指令注入下一次节点会话（信箱）' },
  [STATES.RUNNABLE]: { target: 'supervise', hint: '当前输入将作为监督分析意见（只读，不直接改定义）' },
  [STATES.ACCEPTED]: { target: 'supervise', hint: '已验收，当前输入仅做只读监督分析' },
  [STATES.FAILED]: { target: 'retry', hint: '当前输入将作为重试说明' },
  [STATES.AWAITING_CHILDREN]: { target: 'supervise', hint: '等待子矩阵验收，当前输入仅做只读监督分析' },
  [STATES.CANCELLED]: { target: 'none', hint: '已终止，只读查看' },
})

export function inputRouting(state) {
  return INPUT_ROUTING[state] || { target: 'none', hint: '只读查看' }
}
