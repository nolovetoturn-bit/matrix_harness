import { randomBytes } from 'node:crypto'
import { STATES } from './state.mjs'

const ASCII_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const SKELETON_LIMITS = Object.freeze({ maxNodes: 40, maxChildren: 8, maxBranches: 8 })

/** 骨架节点类型 = 最终节点类型，DAG 确认后锁定，预构建不得改变。 */
export const NODE_TYPES = Object.freeze(['llm', 'agent', 'script', 'http', 'tool', 'human', 'group', 'fanout', 'merge', 'branch', 'persist', 'stub'])
const BRANCH_TYPES = new Set(['llm', 'agent', 'script', 'http', 'tool', 'human', 'group', 'persist', 'stub'])

/** persist 节点支持的持久化操作。 */
export const PERSIST_OPERATIONS = Object.freeze(['create', 'get', 'update', 'delete', 'list'])

const MODEL_ID = /^mdl_[A-Za-z0-9_-]{4,40}$/
const STUB_ID = /^stb_[A-Za-z0-9_-]{4,40}$/

function modelIdList(value, path, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`骨架节点 ${path}.${field} 必须是数组`)
  const ids = value.map(item => trimText(item, 40)).filter(Boolean)
  for (const id of ids) {
    if (!MODEL_ID.test(id)) throw new Error(`骨架节点 ${path}.${field} 含非法 model_id：${id}`)
  }
  return [...new Set(ids)]
}

export const newMatrixId = () => `mx_${randomBytes(6).toString('hex')}`
export const newRunId = () => `run-${randomBytes(6).toString('hex')}`
export const newMessageId = () => `msg-${randomBytes(5).toString('hex')}`

export function assertMatrixId(id) {
  if (!/^mx_[A-Za-z0-9_-]{4,40}$/.test(String(id || ''))) throw new Error(`matrix_id 格式不正确：${id}`)
  return id
}

export function assertRunId(id) {
  if (!/^run-[A-Za-z0-9_-]{4,40}$/.test(String(id || ''))) throw new Error(`run_id 格式不正确：${id}`)
  return id
}

const trimText = (value, limit) => String(value ?? '').trim().slice(0, limit)

/**
 * 新建 matrix 记录（对应 docs/matrix-refactor.md §5.1）。
 * 所有字段都在创建时显式初始化，后续只通过 store 的 update 修改。
 */
export function createMatrixRecord({ task, name, parent_id = null, root_id = null, depth = 0, id = newMatrixId(), cwd, project_id = null, domain_binding = null }) {
  const text = trimText(task, 4000)
  if (!text) throw new Error('task 不能为空')
  const now = new Date().toISOString()
  return {
    version: 1,
    id,
    name: trimText(name, 120) || text.slice(0, 48),
    task: text,
    state: STATES.AWAITING_REQUIREMENT,
    parent_id,
    root_id: root_id || id,
    depth: Number.isInteger(depth) ? depth : 0,
    project_id,
    // 归档只影响可见性：暂不维护的根 matrix 从活跃视图移出，仍可打开/恢复
    archived_at: null,
    // 领域绑定：一个根 matrix 最多绑定一个 model/stub/interact
    domain_binding: domain_binding || null,
    // 领域依赖：stub 节点引用的 stub 根 matrix，预构建时解析
    domain_dependencies: [],
    stub_refs: {},
    analysis: null,
    clarifications: [],
    assumptions: [],
    acceptance_criteria: [],
    skeleton: null,
    dag: null,
    dag_confirmed_at: null,
    definition: null,
    children: [],
    prebuild_done: false,
    dsh_session_id: null,
    // 已归档到 matrix 的 dsh 会话事件游标（dsh → matrix）
    dsh_event_seq: 0,
    // 已回灌到 dsh 会话的归档游标（matrix 侧事件/动作/状态 → dsh）
    dsh_mirror_seq: 0,
    // 运行 I/O 模式：files（文件式，产物可审计）| inline（仅 stdin/stdout）
    execution_mode: 'files',
    cwd: cwd || null,
    run_ids: [],
    mailbox: { mails: [], total: 0 },
    messages: [],
    message_seq: 0,
    archive: [],
    archive_seq: 0,
    progress: { current_node: null, nodes: {}, started_at: null, finished_at: null },
    evaluation: null,
    error: null,
    history: [],
    created_at: now,
    updated_at: now,
  }
}

function normalizeContract(value, path, field) {
  if (value === undefined || value === null) {
    throw new Error(`骨架节点 ${path}.${field} 不能为空：必须声明契约（JSON 对象、字符串或数组）`)
  }
  if (typeof value === 'string') {
    const text = trimText(value, 800)
    if (!text) throw new Error(`骨架节点 ${path}.${field} 不能为空`)
    return text
  }
  if (Array.isArray(value)) {
    const items = value.map(item => trimText(item, 300)).filter(Boolean).slice(0, 20)
    if (!items.length) throw new Error(`骨架节点 ${path}.${field} 不能是空数组`)
    return items
  }
  if (isObject(value)) {
    if (!Object.keys(value).length) throw new Error(`骨架节点 ${path}.${field} 不能是空对象`)
    return value
  }
  throw new Error(`骨架节点 ${path}.${field} 只能是对象、字符串或数组`)
}

/**
 * 骨架是扁平的：根节点下直接是 step / group 节点；group 的子结构由子 matrix 自己生成，
 * 因此任何节点都不允许再带 children。
 */
function normalizeSkeletonNode(raw, path, seen, stats, options = {}) {
  if (!isObject(raw)) throw new Error(`骨架节点 ${path} 必须是对象`)
  const id = trimText(raw.id, 64)
  if (!ASCII_ID.test(id)) throw new Error(`骨架节点 ${path}.id 必须是 ASCII 字母开头的 id：${raw.id}`)
  if (seen.has(id)) throw new Error(`骨架节点 id 重复：${id}`)
  seen.add(id)
  stats.nodes += 1
  if (stats.nodes > SKELETON_LIMITS.maxNodes) {
    throw new Error(`骨架节点总数超过上限 ${SKELETON_LIMITS.maxNodes}`)
  }
  const type = trimText(raw.type, 20)
  if (!NODE_TYPES.includes(type)) {
    throw new Error(`骨架节点 ${path}.type 必须是 ${NODE_TYPES.join('/')} 之一，实际为：${type || '空'}`)
  }
  const isFanout = type === 'fanout'
  const isMerge = type === 'merge'
  const isBranch = type === 'branch'
  const isPersist = type === 'persist'
  const isStub = type === 'stub'
  if (options.branch && !BRANCH_TYPES.has(type)) {
    throw new Error(`分支 ${path} 只能是 ${[...BRANCH_TYPES].join('/')} 之一，不能嵌套 ${type}`)
  }
  if (!isFanout && Array.isArray(raw.children) && raw.children.length) {
    throw new Error(`骨架节点 ${path} 不允许 children：子结构请声明 type=group，由子 matrix 自行生成骨架`)
  }
  const intent = trimText(raw.intent, 700)
  if (!intent) throw new Error(`骨架节点 ${path}.intent 不能为空`)
  const node = {
    id,
    label: trimText(raw.label, 80) || id,
    type,
    intent,
    inputs: normalizeContract(raw.inputs, path, 'inputs'),
    outputs: normalizeContract(raw.outputs, path, 'outputs'),
    complexity: Number.isInteger(raw.complexity) ? Math.min(Math.max(raw.complexity, 1), 5) : 3,
    children: [],
  }

  if (isFanout) {
    if (!isObject(node.inputs) || !isObject(node.outputs)) {
      throw new Error(`骨架节点 ${path} 是 fanout：inputs/outputs 必须是字段对象，便于逐分支对齐契约`)
    }
    if (!Array.isArray(raw.children) || !raw.children.length) {
      throw new Error(`骨架节点 ${path} 是 fanout：必须用 children 声明 1..${SKELETON_LIMITS.maxBranches} 个分支`)
    }
    if (raw.children.length > SKELETON_LIMITS.maxBranches) {
      throw new Error(`骨架节点 ${path} 的 fanout 分支不能超过 ${SKELETON_LIMITS.maxBranches} 个`)
    }
    const collect = raw.collect === undefined ? 'keyed' : trimText(raw.collect, 20)
    if (!['keyed', 'array'].includes(collect)) {
      throw new Error(`骨架节点 ${path}.collect 仅支持 keyed/array`)
    }
    node.collect = collect
    const carry = raw.carry === undefined ? [] : raw.carry
    if (!Array.isArray(carry) || carry.some(key => typeof key !== 'string' || !key.trim())) {
      throw new Error(`骨架节点 ${path}.carry 必须是非空字段名字符串数组`)
    }
    const carried = [...new Set(carry.map(key => key.trim()))]
    if (carried.length !== carry.length) throw new Error(`骨架节点 ${path}.carry 字段名不能重复`)
    if (carried.length && collect === 'array') {
      throw new Error(`骨架节点 ${path}.carry 只支持 collect=keyed`)
    }
    node.carry = carried
    node.children = raw.children.map((child, index) => normalizeSkeletonNode(
      child,
      `${path}/${child && child.id ? child.id : index}`,
      seen,
      stats,
      { branch: true },
    ))
    if (carried.length) {
      const missingInputs = carried.filter(key => !hasOwn(node.inputs, key))
      if (missingInputs.length) throw new Error(`骨架节点 ${path}.carry 字段不在输入中：${missingInputs.join('、')}`)
      const collisions = carried.filter(key => node.children.some(branch => branch.id === key))
      if (collisions.length) throw new Error(`骨架节点 ${path}.carry 字段不能与分支 id 重名：${collisions.join('、')}`)
    }
    if (collect === 'keyed') {
      const missing = node.children.map(branch => branch.id).concat(carried)
        .filter(key => !hasOwn(node.outputs, key))
      if (missing.length) {
        throw new Error(`骨架节点 ${path} 是 fanout：outputs 必须覆盖分支 id 与 carry，缺少 ${missing.join('、')}`)
      }
    }
  } else if (isMerge) {
    if (!isObject(node.inputs) || !isObject(node.outputs)) {
      throw new Error(`骨架节点 ${path} 是 merge：inputs/outputs 必须是字段对象，便于校验 mapping`)
    }
    if (!isObject(raw.mapping) || !Object.keys(raw.mapping).length) {
      throw new Error(`骨架节点 ${path} 是 merge：必须声明 mapping 表达式对象`)
    }
    const outputKeys = Object.keys(node.outputs)
    const mappingKeys = Object.keys(raw.mapping)
    const missing = outputKeys.filter(key => !mappingKeys.includes(key))
    const extra = mappingKeys.filter(key => !outputKeys.includes(key))
    if (missing.length || extra.length) {
      throw new Error(`骨架节点 ${path} 的 mapping 与 outputs 必须一一对应（缺少：${missing.join('、') || '无'}；多出：${extra.join('、') || '无'}）`)
    }
    node.mapping = structuredClone(raw.mapping)
  } else if (isBranch) {
    if (!isObject(node.inputs) || !isObject(node.outputs)) {
      throw new Error(`骨架节点 ${path} 是 branch：inputs/outputs 必须是字段对象，便于校验两路分支契约`)
    }
    if (!isObject(raw.condition) || !Object.keys(raw.condition).length) {
      throw new Error(`骨架节点 ${path} 是 branch：condition 必须是非空表达式对象`)
    }
    if (!isObject(raw.then)) throw new Error(`骨架节点 ${path} 是 branch：必须声明 then 节点`)
    node.condition = structuredClone(raw.condition)
    node.then = normalizeSkeletonNode(raw.then, `${path}/${raw.then.id || 'then'}`, seen, stats, { branch: true })
    if (raw.else !== undefined && raw.else !== null) {
      node.else = normalizeSkeletonNode(raw.else, `${path}/${raw.else.id || 'else'}`, seen, stats, { branch: true })
    }
  } else if (isPersist) {
    if (!MODEL_ID.test(String(raw.model_id || ''))) {
      throw new Error(`骨架节点 ${path} 是 persist：model_id 必须是 mdl_ 开头的 model id`)
    }
    const operation = trimText(raw.operation, 20)
    if (!PERSIST_OPERATIONS.includes(operation)) {
      throw new Error(`骨架节点 ${path} 是 persist：operation 只能是 ${PERSIST_OPERATIONS.join('/')} 之一`)
    }
    if (raw.key !== undefined) {
      const key = trimText(raw.key, 80)
      if (!key) throw new Error(`骨架节点 ${path}.key 不能为空`)
      node.key = key
    }
    if (raw.where !== undefined && raw.where !== null) {
      if (!isObject(raw.where)) throw new Error(`骨架节点 ${path}.where 必须是对象`)
      node.where = structuredClone(raw.where)
    }
    node.model_id = raw.model_id
    node.operation = operation
  } else if (isStub) {
    if (!STUB_ID.test(String(raw.stub_id || ''))) {
      throw new Error(`骨架节点 ${path} 是 stub：stub_id 必须是 stb_ 开头的 stub id`)
    }
    const operation = trimText(raw.operation, 80)
    if (!operation) throw new Error(`骨架节点 ${path}.operation 不能为空`)
    node.stub_id = raw.stub_id
    node.operation = operation
    node.request_model_ids = modelIdList(raw.request_model_ids, path, 'request_model_ids')
    node.response_model_ids = modelIdList(raw.response_model_ids, path, 'response_model_ids')
  }
  return node
}

/**
 * 归一化 LLM 产出的骨架 DAG。根节点固定为 root（代表当前 matrix 本身）；
 * 根下每个节点都必须是 llm/agent/script/http/tool/human/group 之一，并带 Cin/Cout 契约。
 */
export function normalizeSkeleton(raw) {
  if (!isObject(raw)) throw new Error('skeleton 必须是对象')
  const entryRaw = isObject(raw.entry) ? raw.entry : raw
  if (!isObject(entryRaw)) throw new Error('skeleton.entry 必须是对象')
  const childrenRaw = Array.isArray(entryRaw.children) ? entryRaw.children : []
  if (!childrenRaw.length) throw new Error('骨架必须有至少一个节点')
  if (childrenRaw.length > SKELETON_LIMITS.maxChildren) {
    throw new Error(`骨架节点不能超过 ${SKELETON_LIMITS.maxChildren} 个`)
  }
  const stats = { nodes: 0 }
  const seen = new Set()
  const children = childrenRaw.map((child, index) => normalizeSkeletonNode(
    child,
    `entry/${child && child.id ? child.id : index}`,
    seen,
    stats,
  ))
  const root = {
    id: 'root',
    label: trimText(entryRaw.label, 80) || 'root',
    type: 'root',
    intent: trimText(entryRaw.intent, 700) || '完成本 matrix 的任务',
    inputs: entryRaw.inputs === undefined ? null : normalizeContract(entryRaw.inputs, 'entry', 'inputs'),
    outputs: null,
    complexity: null,
    children,
  }
  return { version: 1, entry: root, node_count: stats.nodes }
}

/** 深度优先遍历骨架（含 root），提供 path 与父节点。 */
export function walkSkeleton(entry, visit, parent = null, path = 'entry', depth = 0) {
  if (!entry) return
  visit({ node: entry, path, parent, depth })
  const nested = [...(entry.children || [])]
  // branch 的 then/else 也是骨架的一部分，需要逐节点实现和校验
  if (entry.type === 'branch') {
    if (isObject(entry.then)) nested.push(entry.then)
    if (isObject(entry.else)) nested.push(entry.else)
  }
  for (const child of nested) {
    walkSkeleton(child, visit, entry, `${path}/${child.id}`, depth + 1)
  }
}

export function skeletonNodeAt(entry, path) {
  let found = null
  walkSkeleton(entry, item => {
    if (item.path === path) found = item
  })
  return found
}

/**
 * 由骨架合成 DAG 只读定义（对齐旧版 readonlyEntry）：
 * 每个节点保留已声明的类型与 Cin/Cout 契约；group 渲染为 subflow 占位（matrix_id 预构建后回填），
 * 其余节点按声明类型渲染为不可执行的只读节点。DAG 确认阶段即可查看。
 */
export function readonlyDefinition(skeleton, { childRefs = {}, stubRefs = {} } = {}) {
  if (!skeleton || !skeleton.entry) return null
  const flat = []
  const specialFields = node => {
    if (node.type === 'persist') {
      return {
        model_id: node.model_id,
        operation: node.operation,
        ...(node.key ? { key: node.key } : {}),
        ...(node.where ? { where: structuredClone(node.where) } : {}),
        build_status: 'direct',
      }
    }
    if (node.type === 'stub') {
      return {
        stub_id: node.stub_id,
        operation: node.operation,
        request_model_ids: structuredClone(node.request_model_ids || []),
        response_model_ids: structuredClone(node.response_model_ids || []),
        matrix_id: stubRefs[node.stub_id] || null,
        build_status: 'direct',
      }
    }
    return { build_status: 'planned' }
  }
  const viewOf = node => {
    const ref = childRefs[node.id]
    const base = {
      path: `entry/${node.id}`,
      id: node.id,
      label: node.label,
      type: node.type === 'group' ? 'subflow' : node.type,
      group: node.type === 'group',
      readonly: true,
      intent: node.intent,
      inputs: node.inputs,
      outputs: node.outputs,
      complexity: node.complexity,
      ...specialFields(node),
    }
    if (node.type === 'fanout') {
      const branches = (node.children || []).map(branch => {
        const branchRef = childRefs[branch.id]
        const branchView = {
          path: `entry/${node.id}/${branch.id}`,
          id: branch.id,
          label: branch.label,
          type: branch.type === 'group' ? 'subflow' : branch.type,
          group: branch.type === 'group',
          readonly: true,
          branch_of: node.id,
          intent: branch.intent,
          inputs: branch.inputs,
          outputs: branch.outputs,
          complexity: branch.complexity,
        }
        if (branch.type === 'group') {
          return {
            ...branchView,
            matrix_id: branchRef ? branchRef.matrix_id : null,
            matrix_path: branchRef ? branchRef.node_path : null,
            build: { task: branch.intent, readonly: true },
          }
        }
        return { ...branchView, ...specialFields(branch) }
      })
      return {
        ...base,
        collect: node.collect || 'keyed',
        carry: node.carry || [],
        branches,
        build_status: 'planned',
      }
    }
    if (node.type === 'merge') {
      return { ...base, mapping: structuredClone(node.mapping), build_status: 'planned' }
    }
    if (node.type === 'branch') {
      const childView = (child, role) => {
        const childRef = childRefs[child.id]
        const view = {
          path: `entry/${node.id}/${child.id}`,
          id: child.id,
          label: child.label,
          type: child.type === 'group' ? 'subflow' : child.type,
          group: child.type === 'group',
          readonly: true,
          branch_of: node.id,
          branch_role: role,
          intent: child.intent,
          inputs: child.inputs,
          outputs: child.outputs,
          complexity: child.complexity,
        }
        if (child.type === 'group') {
          return {
            ...view,
            matrix_id: childRef ? childRef.matrix_id : null,
            matrix_path: childRef ? childRef.node_path : null,
            build: { task: child.intent, readonly: true },
          }
        }
        return { ...view, ...specialFields(child) }
      }
      return {
        ...base,
        condition: structuredClone(node.condition),
        then: childView(node.then, 'then'),
        else: node.else ? childView(node.else, 'else') : null,
        build_status: 'planned',
      }
    }
    if (node.type === 'group') {
      return {
        ...base,
        matrix_id: ref ? ref.matrix_id : null,
        matrix_path: ref ? ref.node_path : null,
        build: { task: node.intent, readonly: true },
      }
    }
    return { ...base }
  }

  const nodes = (skeleton.entry.children || []).map(node => {
    const view = viewOf(node)
    flat.push(view)
    for (const branch of view.branches || []) flat.push(branch)
    if (view.then) flat.push(view.then)
    if (view.else) flat.push(view.else)
    return view
  })
  const entry = nodes.length === 1 ? nodes[0] : { id: 'root_seq', type: 'sequence', readonly: true, steps: nodes }
  return {
    version: 1,
    name: skeleton.entry.label || 'matrix',
    readonly: true,
    entry,
    nodes: flat,
  }
}

/**
 * matrix 引用环检测：沿 parent_id 链向上，若遇到自身则拒绝。
 * 新 matrix 只挂在已存在的父链上，因此只需检查父链不包含自身。
 */
export function assertNoCycle(matrices, matrixId) {
  const seen = new Set()
  let cursor = matrices instanceof Map ? matrices.get(matrixId) : matrices[matrixId]
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error(`matrix 引用出现环：${[...seen, cursor.id].join(' → ')}`)
    seen.add(cursor.id)
    cursor = cursor.parent_id ? (matrices instanceof Map ? matrices.get(cursor.parent_id) : matrices[cursor.parent_id]) : null
  }
}

/**
 * 把骨架编译成可执行 definition。
 * group 节点编译为引用子 matrix 的 subflow；step 节点使用预构建产出的 IR。
 */
export function compileSkeleton(skeleton, { implementations = {}, childRefs = {}, stubRefs = {}, projectId = null } = {}) {
  const build = (node, path) => {
    if (node.type === 'group') {
      const ref = childRefs[node.id]
      if (!ref) throw new Error(`子节点 ${path} 缺少子 matrix 引用`)
      return { id: node.id, type: 'subflow', label: node.label, matrix_id: ref.matrix_id, matrix_path: ref.node_path }
    }
    if (node.type === 'fanout') {
      return {
        id: node.id,
        type: 'fanout',
        label: node.label,
        inputs: structuredClone(node.inputs),
        outputs: structuredClone(node.outputs),
        collect: node.collect || 'keyed',
        ...(node.carry && node.carry.length ? { carry: structuredClone(node.carry) } : {}),
        branches: (node.children || []).map(branch => build(branch, `${path}/${branch.id}`)),
      }
    }
    if (node.type === 'merge') {
      return {
        id: node.id,
        type: 'merge',
        label: node.label,
        inputs: structuredClone(node.inputs),
        outputs: structuredClone(node.outputs),
        mapping: structuredClone(node.mapping),
      }
    }
    if (node.type === 'branch') {
      return {
        id: node.id,
        type: 'branch',
        label: node.label,
        condition: structuredClone(node.condition),
        then: build(node.then, `${path}/${node.then.id}`),
        ...(node.else ? { else: build(node.else, `${path}/${node.else.id}`) } : {}),
      }
    }
    if (node.type === 'persist') {
      return {
        id: node.id,
        type: 'persist',
        label: node.label,
        model_id: node.model_id,
        project_id: projectId,
        operation: node.operation,
        ...(node.key ? { key: node.key } : {}),
        ...(node.where ? { where: structuredClone(node.where) } : {}),
        inputs: structuredClone(node.inputs),
        outputs: structuredClone(node.outputs),
      }
    }
    if (node.type === 'stub') {
      const matrixId = stubRefs[node.stub_id]
      if (!matrixId) throw new Error(`stub 节点 ${path} 未解析到目标 matrix：${node.stub_id}`)
      return {
        id: node.id,
        type: 'stub',
        label: node.label,
        stub_id: node.stub_id,
        operation: node.operation,
        request_model_ids: structuredClone(node.request_model_ids || []),
        response_model_ids: structuredClone(node.response_model_ids || []),
        matrix_id: matrixId,
        inputs: structuredClone(node.inputs),
        outputs: structuredClone(node.outputs),
      }
    }
    const impl = implementations[path]
    if (!impl) throw new Error(`节点 ${path} 尚未预构建`)
    const cloned = structuredClone(impl)
    if (cloned.type !== node.type) {
      throw new Error(`节点 ${path} 在 DAG 中声明为 ${node.type}，实现却返回 ${cloned.type || '空'}；DAG 确认后不得改变节点类型`)
    }
    cloned.id = node.id
    if (node.label && cloned.label === undefined) cloned.label = node.label
    return cloned
  }
  const children = (skeleton.entry.children || []).map(child => build(child, `entry/${child.id}`))
  if (!children.length) throw new Error('骨架没有可编译的节点')
  const entry = children.length === 1 ? children[0] : { id: 'root', type: 'sequence', steps: children }
  // 根入口契约只有在 entry.inputs 是标准 schema 对象时才编译进 definition，供 validateInput 使用
  const rawInputs = skeleton.entry.inputs
  const inputs = rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs)
    && Object.values(rawInputs).every(spec => spec && typeof spec === 'object'
      && !Array.isArray(spec) && typeof spec.type === 'string')
    ? structuredClone(rawInputs)
    : null
  return {
    version: 1,
    name: skeleton.entry.label || 'matrix',
    ...(inputs ? { inputs } : {}),
    entry,
  }
}

/** 子 matrix 的任务描述：让子会话只靠这段文字也能独立完成需求分析。 */
export function childTaskOf(parent, node, path) {
  const inputs = typeof node.inputs === 'string' ? node.inputs : JSON.stringify(node.inputs)
  const outputs = typeof node.outputs === 'string' ? node.outputs : JSON.stringify(node.outputs)
  return [
    `【父 matrix】${parent.name}（${parent.id}）`,
    `【父任务】${parent.task}`,
    `【本子流程节点】${node.label}（${node.id}，路径 ${path}）`,
    `【节点类型】${node.type}（已在父 DAG 中锁定为 group，对应一个独立子 matrix）`,
    `【要做的事】${node.intent}`,
    `【输入契约 Cin】${inputs}`,
    `【输出契约 Cout】${outputs}`,
    '你是一个独立 matrix：需要自行完成需求澄清、骨架 DAG、预构建与验收；不要假设父矩阵会内联展开你。',
  ].join('\n')
}
