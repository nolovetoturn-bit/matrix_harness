import { implementNode } from '../ai.mjs'
import { validateDefinition } from '../runner.mjs'
import { skeletonContractIssues } from './contracts.mjs'
import { agentEvent } from './messages.mjs'
import { intakeMatrix } from './require.mjs'
import { childTaskOf, compileSkeleton, createMatrixRecord, newMatrixId, readonlyDefinition, walkSkeleton } from './schema.mjs'
import { assertDomainSkeleton, domainContextOf, stubMatrixIdsOf } from '../domain/policy.mjs'
import { childrenOf, STATES, stateAfterPrebuild } from './state.mjs'
import { listRuns, loadAll, loadMatrix, matrixWorkDir, nodeDir, saveMatrix, updateMatrix } from './store.mjs'

const now = () => new Date().toISOString()

function stepNodes(skeleton) {
  const nodes = []
  walkSkeleton(skeleton.entry, ({ node, path }) => {
    // fanout/merge/branch 是控制节点；persist/stub 由运行时直接执行，都不进入编码流程
    if (path !== 'entry'
      && !['group', 'fanout', 'merge', 'branch', 'persist', 'stub'].includes(node.type)) {
      nodes.push({ node, path })
    }
  })
  return nodes
}

function groupNodes(skeleton) {
  const nodes = []
  walkSkeleton(skeleton.entry, ({ node, path }) => {
    if (node.type === 'group') nodes.push({ node, path })
  })
  return nodes
}

function siblingSummaries(skeleton, node) {
  return (skeleton.entry.children || [])
    .filter(item => item.id !== node.id)
    .map(item => ({ id: item.id, label: item.label, type: item.type, intent: item.intent }))
}

function childRefsOf(matrix) {
  const result = {}
  for (const ref of matrix.children || []) result[ref.node_id] = ref
  return result
}

/**
 * 把预构建进度回填到只读 DAG：面板据此显示编码状态与节点源码。
 * 存储的 dag 可能是在节点尚未实现时生成的，读取时也要重新标注。
 */
function annotateDag(matrix, dag) {
  if (!dag || !Array.isArray(dag.nodes)) return dag
  const progress = matrix.progress?.nodes || {}
  const nodes = dag.nodes.map(node => {
    const path = String(node.path || `entry/${node.id}`)
    const entry = progress[path] || progress[`entry/${node.id}`] || null
    const implementation = entry && entry.implementation ? entry.implementation : null
    const buildStatus = node.group ? 'completed' : (entry && entry.status ? entry.status : (node.build_status || 'planned'))
    return {
      ...node,
      build_status: buildStatus,
      ...(implementation
        ? {
          implementation,
          ...(typeof implementation.code === 'string' ? { code: implementation.code } : {}),
        }
        : {}),
    }
  })
  return { ...dag, nodes }
}

export function dagViewOf(matrix) {
  const dag = matrix.dag || (matrix.skeleton ? readonlyDefinition(matrix.skeleton) : null)
  const view = annotateDag(matrix, dag)
  if (!view) return view
  const issues = skeletonContractIssues(matrix.skeleton)
  return {
    ...view,
    root_inputs: matrix.skeleton?.entry?.inputs ?? null,
    root_outputs: matrix.skeleton?.entry?.outputs ?? null,
    contract_ok: issues.ok,
    contract_errors: issues.errors,
    nodes: (view.nodes || []).map(node => ({
      ...node,
      contract_missing: issues.nodeIssues[node.id] || [],
    })),
  }
}

/** DAG 只读定义随 group→子 matrix、stub→目标 matrix 引用回填而刷新。 */
function refreshDag(matrix) {
  matrix.dag = annotateDag(matrix, readonlyDefinition(matrix.skeleton, {
    childRefs: childRefsOf(matrix),
    stubRefs: matrix.stub_refs || {},
  }))
}

/** stub_id → 目标根 matrix 映射；由预构建解析并写回 matrix.stub_refs。 */
function stubRefsOf(context, skeleton) {
  const refs = {}
  if (!context || !skeleton) return refs
  walkSkeleton(skeleton.entry, ({ node }) => {
    if (node.type !== 'stub') return
    const stub = (context.domain.stubs || []).find(item => item.id === node.stub_id)
    if (stub && stub.matrix_id) refs[node.stub_id] = stub.matrix_id
  })
  return refs
}

function recordNode(matrix, path, patch) {
  matrix.progress = matrix.progress || { current_node: null, nodes: {} }
  matrix.progress.nodes[path] = {
    ...(matrix.progress.nodes[path] || {}),
    ...patch,
    updated_at: now(),
  }
}

/**
 * 为 group 节点创建（或复用）子 matrix，并记录父节点引用。
 * 只创建、不构建：子 matrix 自己走需求→骨架→预构建→验收。
 */
async function ensureChildMatrix(dataDir, matrix, node, path, dependencies) {
  const existing = (matrix.children || []).find(ref => ref.node_id === node.id)
  if (existing) {
    if (!matrix.progress.nodes[path] || matrix.progress.nodes[path].status !== 'completed') {
      recordNode(matrix, path, { status: 'completed', matrix_id: existing.matrix_id, session_id: null })
    }
    refreshDag(matrix)
    saveMatrix(dataDir, matrix)
    return existing
  }
  const child = createMatrixRecord({
    id: newMatrixId(),
    task: childTaskOf(matrix, node, path),
    name: node.label,
    parent_id: matrix.id,
    root_id: matrix.root_id,
    depth: (matrix.depth || 0) + 1,
  })
  child.cwd = matrixWorkDir(dataDir, child.id)
  saveMatrix(dataDir, child)
  matrix.children = [...(matrix.children || []), { node_id: node.id, node_path: path, matrix_id: child.id }]
  agentEvent(matrix, `为子流程节点 ${node.label}（${node.id}）创建子 matrix ${child.id}`)
  recordNode(matrix, path, { status: 'building', matrix_id: child.id })
  refreshDag(matrix)
  saveMatrix(dataDir, matrix)

  try {
    await intakeMatrix({
      dataDir,
      task: child.task,
      parentMatrix: matrix,
      record: child,
      dependencies,
    })
    saveMatrix(dataDir, child)
  } catch (error) {
    child.state = STATES.FAILED
    child.error = { path, node_id: node.id, message: error && error.message ? error.message : String(error) }
    agentEvent(child, `受理失败：${child.error.message}`)
    saveMatrix(dataDir, child)
  }
  // 子 matrix 已创建并完成受理：父节点这一步视为完成（后续验收由子矩阵状态驱动）
  recordNode(matrix, path, { status: 'completed', matrix_id: child.id })
  refreshDag(matrix)
  saveMatrix(dataDir, matrix)
  return { node_id: node.id, node_path: path, matrix_id: child.id }
}

async function implementStep(dataDir, matrix, node, path, dependencies) {
  const workDir = matrixWorkDir(dataDir, matrix.id)
  const cwd = nodeDir(workDir, path)
  const feedback = matrix.progress?.nodes?.[path]?.error || null
  const attempt = (matrix.progress?.nodes?.[path]?.attempts || 0) + 1
  // 每个节点一个独立 dsh 会话，挂到本 matrix 会话下。
  // 末尾带一次性后缀：进程中断后再次预构建时不会撞上已存在的同名会话。
  const sessionId = `${matrix.id}-${node.id}-${attempt}-${Date.now().toString(36)}`
  recordNode(matrix, path, { status: 'building', node_id: node.id, path, error: null })
  matrix.progress.current_node = { node_id: node.id, path, label: node.label, kind: node.type, session_id: sessionId }
  saveMatrix(dataDir, matrix)

  // human 节点不需要编码会话：按 DAG 中锁定的类型与契约直接合成
  if (node.type === 'human') {
    const nodeIr = {
      id: node.id,
      type: 'human',
      label: node.label,
      prompt: `${node.intent}\n\n【需要提供】${typeof node.outputs === 'string' ? node.outputs : JSON.stringify(node.outputs)}`,
    }
    recordNode(matrix, path, {
      status: 'completed',
      node_id: node.id,
      path,
      attempts: attempt,
      session_id: null,
      implementation: nodeIr,
      error: null,
    })
    matrix.progress.current_node = null
    saveMatrix(dataDir, matrix)
    agentEvent(matrix, `人工节点 ${node.label}（${path}）已按 DAG 定义生成，等待运行期人工输入`)
    return nodeIr
  }

  agentEvent(matrix, `开始实现节点 ${node.label}（${path}，类型 ${node.type}）`)
  const implementation = await implementNode({
    task: matrix.task,
    node,
    siblings: siblingSummaries(matrix.skeleton, node),
    previousNodes: stepNodes(matrix.skeleton)
      .filter(item => item.path !== path && matrix.progress?.nodes?.[item.path]?.status === 'completed')
      .map(item => ({ id: item.node.id, label: item.node.label, type: item.node.type, intent: item.node.intent })),
    acceptanceCriteria: matrix.acceptance_criteria,
    instructions: matrix.instructions || [],
    feedback,
    workspace: workDir,
    cwd,
    sessionId,
    parentSessionId: matrix.dsh_session_id,
  }, dependencies)
  const actualSession = implementation.session_id || sessionId
  const nodeIr = implementation.node
  if (!nodeIr || nodeIr.type !== node.type) {
    throw new Error(`节点 ${path} 在 DAG 中声明为 ${node.type}，实现却返回 ${nodeIr?.type || '空'}；DAG 确认后不得改变节点类型`)
  }
  if (nodeIr.id !== node.id) throw new Error(`节点 id 必须为 ${node.id}`)
  validateDefinition({ version: 1, entry: nodeIr })
  recordNode(matrix, path, {
    status: 'completed',
    node_id: node.id,
    path,
    attempts: attempt,
    session_id: actualSession,
    implementation: nodeIr,
    error: null,
  })
  matrix.progress.current_node = null
  saveMatrix(dataDir, matrix)
  agentEvent(matrix, `节点 ${node.label}（${path}）预构建完成`)
  return nodeIr
}

function implementationsOf(matrix) {
  const result = {}
  for (const [path, item] of Object.entries(matrix.progress?.nodes || {})) {
    if (item && item.status === 'completed' && item.implementation && !item.matrix_id) {
      result[path] = item.implementation
    }
  }
  return result
}

/**
 * 逐节点预构建（P3）。幂等：已完成的节点与已创建的子 matrix 会直接复用。
 * 单个节点失败只让本 matrix 进入 failed，不波及其它 matrix。
 */
export async function prebuildMatrix({ dataDir, matrixId, dependencies = {}, onProgress } = {}) {
  let matrix = loadMatrix(dataDir, matrixId)
  if (!matrix.skeleton) throw new Error('尚未生成骨架 DAG，不能预构建')
  const domainContext = domainContextOf(dataDir, matrix)
  assertDomainSkeleton(domainContext, matrix.skeleton)
  const stubRefs = stubRefsOf(domainContext, matrix.skeleton)
  const domainDependencies = domainContext ? stubMatrixIdsOf(domainContext, matrix.skeleton) : []
  matrix = await updateMatrix(dataDir, matrixId, current => {
    if (current.state === STATES.AWAITING_PREBUILD) {
      current.state = STATES.BUILDING
      current.error = null
      current.prebuild_done = false
      current.progress.started_at = current.progress.started_at || now()
      agentEvent(current, '启动预构建。')
    } else if (current.state !== STATES.BUILDING && current.state !== STATES.FAILED) {
      throw new Error(`当前状态 ${current.state} 不允许预构建`)
    }
    current.stub_refs = stubRefs
    current.domain_dependencies = domainDependencies
    return current
  })

  const groups = groupNodes(matrix.skeleton)
  for (const group of groups) {
    matrix = loadMatrix(dataDir, matrixId)
    const done = matrix.progress?.nodes?.[group.path]?.status === 'completed'
    if (done && (matrix.children || []).some(ref => ref.node_id === group.node.id)) continue
    await ensureChildMatrix(dataDir, matrix, group.node, group.path, dependencies)
    matrix = loadMatrix(dataDir, matrixId)
    if (onProgress) onProgress({ matrix })
  }

  const steps = stepNodes(matrix.skeleton)
  for (const step of steps) {
    matrix = loadMatrix(dataDir, matrixId)
    if (matrix.progress?.nodes?.[step.path]?.status === 'completed' && matrix.progress.nodes[step.path].implementation) continue
    try {
      await implementStep(dataDir, matrix, step.node, step.path, dependencies)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      await updateMatrix(dataDir, matrixId, current => {
        recordNode(current, step.path, { status: 'failed', node_id: step.node.id, path: step.path, error: message })
        current.state = STATES.FAILED
        current.error = { path: step.path, node_id: step.node.id, message }
        current.progress.current_node = null
        agentEvent(current, `预构建失败于 ${step.node.label}（${step.path}）：${message}`)
        return current
      })
      throw error
    }
    if (onProgress) onProgress({ matrix: loadMatrix(dataDir, matrixId) })
  }

  matrix = await updateMatrix(dataDir, matrixId, current => {
    const definition = compileSkeleton(current.skeleton, {
      implementations: implementationsOf(current),
      childRefs: childRefsOf(current),
      stubRefs: current.stub_refs || {},
      projectId: current.project_id,
    })
    validateDefinition(definition)
    current.definition = definition
    // 可执行定义生成后，只读 DAG 也补齐为最终节点（含实际实现与编码状态）
    refreshDag(current)
    current.prebuild_done = true
    current.error = null
    current.progress.current_node = null
    current.progress.finished_at = now()
    const matrices = loadAll(dataDir)
    current.state = stateAfterPrebuild(current, matrices)
    const pendingChildren = childrenOf(current, matrices).filter(child => child.state !== STATES.ACCEPTED).length
    agentEvent(current, current.state === STATES.RUNNABLE
      ? '预构建完成，全部子矩阵已验收，当前可运行。'
      : `预构建完成，仍在等待 ${pendingChildren} 个子矩阵验收。`)
    return current
  })
  return matrix
}

/**
 * 重试：只重置失败节点，已完成节点与子 matrix 保留。
 */
export async function retryPrebuild({ dataDir, matrixId, instruction = null, dependencies = {} } = {}) {
  await updateMatrix(dataDir, matrixId, matrix => {
    if (matrix.state !== STATES.FAILED) throw new Error(`当前状态 ${matrix.state}，只有 failed 可以重试`)
    const failedPath = matrix.error?.path
    if (failedPath && matrix.progress?.nodes?.[failedPath]) {
      matrix.progress.nodes[failedPath].status = 'pending'
      matrix.progress.nodes[failedPath].error = instruction || '人工重试'
    }
    matrix.error = null
    matrix.state = STATES.BUILDING
    matrix.prebuild_done = false
    agentEvent(matrix, instruction ? `人工重试：${instruction}` : '人工重试失败节点')
    return matrix
  })
  return prebuildMatrix({ dataDir, matrixId, dependencies })
}

export function skeletonGroupNode(matrix, nodeId) {
  return skeletonNodeAt(matrix.skeleton?.entry, nodeId)
}

function skeletonNodeById(skeleton, id) {
  let found = null
  walkSkeleton(skeleton.entry, ({ node }) => {
    if (!found && node.id === id) found = node
  })
  return found
}

function progressEntryOf(matrix, nodePath) {
  const raw = String(nodePath || '').trim()
  if (!raw) throw new Error('node_path 不能为空')
  const candidates = new Set([raw, raw.startsWith('entry/') ? raw.slice(6) : `entry/${raw}`])
  for (const [key, entry] of Object.entries(matrix.progress?.nodes || {})) {
    if (candidates.has(key) || (entry && entry.node_id === raw)) return { key, entry }
  }
  throw new Error(`节点不存在或尚未预构建：${nodePath}`)
}

/**
 * 修复单个节点的实现：节点 id / 类型 / Cin-Cout 契约不变，只替换实现并刷新 definition。
 * 支持两种方式：
 *   - code：直接给出 script 节点的完整新代码（dsh agent 自己改产物）
 *   - instruction：交给编码会话按修复说明重写（会附带当前实现与最近一次运行错误）
 */
export async function reviseNode({ dataDir, matrixId, nodePath, instruction = null, code = null, runtime = null, dependencies = {} } = {}) {
  const matrix = loadMatrix(dataDir, matrixId)
  if (!matrix.skeleton) throw new Error('尚未生成骨架 DAG，不能修复节点')
  const { key, entry } = progressEntryOf(matrix, nodePath)
  if (!entry || !entry.implementation) throw new Error(`节点 ${nodePath} 还没有完成预构建，无法修复`)
  const current = entry.implementation
  const skeletonNode = skeletonNodeById(matrix.skeleton, current.id)
  if (!skeletonNode) throw new Error(`骨架中不存在节点 ${current.id}`)

  let nodeIr
  const hasCode = code !== null && code !== undefined && String(code).trim() !== ''
  if (hasCode) {
    if (current.type !== 'script') throw new Error(`节点 ${current.id} 类型为 ${current.type}，只有 script 节点支持直接替换 code`)
    nodeIr = { ...current, code: String(code) }
    if (runtime) nodeIr.runtime = String(runtime)
    validateDefinition({ version: 1, entry: nodeIr })
  } else {
    const hint = String(instruction || '').trim()
    if (!hint) throw new Error('修复节点需要 instruction（修复说明）或 code')
    const runs = listRuns(dataDir, matrixId)
    const failed = runs.find(run => run.status === 'failed' && run.error && run.error.node_id === current.id)
      || runs.find(run => run.status === 'failed')
    const feedback = [
      hint,
      failed && failed.error
        ? `最近一次运行失败（${failed.error.path || failed.error.node_id || current.id}）：${failed.error.message}`
        : null,
    ].filter(Boolean).join('\n\n')
    const workDir = matrixWorkDir(dataDir, matrix.id)
    const cwd = nodeDir(workDir, key)
    const sessionId = `${matrix.id}-${current.id}-fix-${Date.now().toString(36)}`
    const implementation = await implementNode({
      task: matrix.task,
      node: skeletonNode,
      siblings: siblingSummaries(matrix.skeleton, skeletonNode),
      previousNodes: [],
      acceptanceCriteria: matrix.acceptance_criteria,
      instructions: matrix.instructions || [],
      feedback,
      previousImplementation: current,
      workspace: workDir,
      cwd,
      sessionId,
      parentSessionId: matrix.dsh_session_id,
    }, dependencies)
    nodeIr = implementation.node
    if (!nodeIr || nodeIr.type !== current.type) {
      throw new Error(`修复节点 ${current.id} 时类型必须保持为 ${current.type}，实际为 ${nodeIr?.type || '空'}`)
    }
    if (nodeIr.id !== current.id) throw new Error(`修复节点的 id 必须保持为 ${current.id}`)
    validateDefinition({ version: 1, entry: nodeIr })
  }

  recordNode(matrix, key, {
    status: 'completed',
    node_id: current.id,
    path: key,
    attempts: (entry.attempts || 0) + 1,
    implementation: nodeIr,
    error: null,
    session_id: entry.session_id || null,
  })
  refreshDag(matrix)
  matrix.definition = compileSkeleton(matrix.skeleton, {
    implementations: implementationsOf(matrix),
    childRefs: childRefsOf(matrix),
    stubRefs: matrix.stub_refs || {},
    projectId: matrix.project_id,
  })
  validateDefinition(matrix.definition)
  matrix.prebuild_done = true
  matrix.error = null
  // 实现变了，之前的评估与验收作废；可运行状态保留，方便立刻重跑验证
  matrix.evaluation = null
  delete matrix.accepted_at
  if (matrix.state === STATES.ACCEPTED) matrix.state = STATES.RUNNABLE
  const matrices = loadAll(dataDir)
  matrix.state = stateAfterPrebuild(matrix, matrices)
  agentEvent(matrix, `已修复节点 ${current.label || current.id}（${key}），definition 已刷新；请重新运行验证。`)
  saveMatrix(dataDir, matrix)
  return matrix
}
