/**
 * 领域节点策略：约束 persist / stub 节点只能出现在合适的领域元素根 matrix，
 * 并在骨架生成、DAG 确认、预构建三个入口统一校验，防止绕过提示词或面板。
 */
import { PERSIST_OPERATIONS, walkSkeleton } from '../matrix/schema.mjs'
import { loadDomain } from './store.mjs'

export { PERSIST_OPERATIONS }

const BASE_NODE_TYPES = Object.freeze(['llm', 'agent', 'script', 'http', 'tool', 'human', 'group', 'fanout', 'merge', 'branch'])

const ELEMENT_LABELS = { model: 'Model', stub: 'Stub', interact: 'Interact' }

const listOf = (domain, elementType) => {
  if (elementType === 'model') return domain.models || []
  if (elementType === 'stub') return domain.stubs || []
  if (elementType === 'interact') return domain.interacts || []
  return []
}

function describeElement(context) {
  const label = ELEMENT_LABELS[context.elementType] || context.elementType
  return `${label} ${context.element.name}（${context.element.id}）`
}

/** 解析 matrix 的领域绑定；未绑定领域时返回 null。 */
export function domainContextOf(dataDir, matrix) {
  const binding = matrix && matrix.domain_binding
  if (!binding || !binding.domain_id) return null
  if (!dataDir) throw new Error('matrix 已绑定领域，但缺少 dataDir，无法校验领域节点约束')
  const domain = loadDomain(dataDir, binding.domain_id)
  const element = listOf(domain, binding.element_type).find(item => item.id === binding.element_id)
  if (!element) throw new Error(`领域元素不存在：${binding.element_type} ${binding.element_id}`)
  return { domain, element, elementType: binding.element_type }
}

/** 当前领域元素允许的骨架节点类型。 */
export function allowedNodeTypes(context) {
  if (!context) return [...BASE_NODE_TYPES]
  const persist = context.elementType === 'stub'
    || (context.elementType === 'model' && context.element.type === 'persistence')
  return [...BASE_NODE_TYPES, ...(persist ? ['persist'] : []), 'stub']
}

/** 校验单个 persist / stub 节点是否符合当前领域契约。 */
export function assertDomainNode(node, context) {
  if (!node || (node.type !== 'persist' && node.type !== 'stub')) return node
  const label = `节点「${node.label || node.id}」（${node.id}）`
  if (!context) throw new Error(`${label} 是 ${node.type} 节点：只有领域元素根 matrix 才能使用`)
  if (!allowedNodeTypes(context).includes(node.type)) {
    throw new Error(`${label} 是 ${node.type} 节点，不允许在 ${describeElement(context)} 中使用`)
  }
  if (node.type === 'persist') {
    const model = (context.domain.models || []).find(item => item.id === node.model_id)
    if (!model) throw new Error(`${label} 的 model_id 不存在于当前领域：${node.model_id}`)
    if (model.type !== 'persistence') {
      throw new Error(`${label} 只能操作 persistence model，${model.name} 是 ${model.type}`)
    }
    if (!PERSIST_OPERATIONS.includes(node.operation)) {
      throw new Error(`${label} 的 operation 只能是 ${PERSIST_OPERATIONS.join('/')} 之一`)
    }
    return node
  }
  const stub = (context.domain.stubs || []).find(item => item.id === node.stub_id)
  if (!stub) throw new Error(`${label} 的 stub_id 不存在于当前领域：${node.stub_id}`)
  const operation = (stub.operations || []).find(item => item.name === node.operation)
  if (!operation) throw new Error(`${label} 引用的 ${stub.name} 不存在 operation：${node.operation}`)
  for (const [field, expected] of [['request_model_ids', 'request'], ['response_model_ids', 'response']]) {
    for (const id of node[field] || []) {
      if (!(operation[field] || []).includes(id)) {
        throw new Error(`${label} 的 ${field} 与 ${stub.name}.${operation.name} 契约不一致：${id}`)
      }
      const model = (context.domain.models || []).find(item => item.id === id)
      if (!model || model.type !== expected) {
        throw new Error(`${label} 的 ${field} 只能引用 type=${expected} model：${id}`)
      }
    }
  }
  return node
}

/** 校验整份骨架的领域节点约束。 */
export function assertDomainSkeleton(context, skeleton) {
  if (!skeleton || !skeleton.entry) return skeleton
  walkSkeleton(skeleton.entry, ({ node }) => assertDomainNode(node, context))
  return skeleton
}

/** 解析 stub 节点依赖的根 matrix id；未建根 matrix 时给出可操作错误。 */
export function stubMatrixIdsOf(context, skeleton) {
  const ids = []
  if (!skeleton || !skeleton.entry) return ids
  walkSkeleton(skeleton.entry, ({ node }) => {
    if (!node || node.type !== 'stub') return
    const stub = (context.domain.stubs || []).find(item => item.id === node.stub_id)
    if (!stub) throw new Error(`stub 节点 ${node.id} 的 stub_id 不存在：${node.stub_id}`)
    if (!stub.matrix_id) {
      throw new Error(`stub ${stub.name}（${stub.id}）尚未创建根 matrix，不能作为 stub 节点调用；请先为它创建并验收根 matrix`)
    }
    if (!ids.includes(stub.matrix_id)) ids.push(stub.matrix_id)
  })
  return ids
}

/** 注入 planSkeleton 的领域上下文；未绑定领域时返回 null。 */
export function domainPromptContext(context) {
  if (!context) return null
  const models = (context.domain.models || []).map(model => ({
    id: model.id,
    name: model.name,
    type: model.type,
    kind: model.kind,
    attributes: (model.attributes || []).map(attribute => attribute.name).filter(Boolean),
  }))
  const stubs = (context.domain.stubs || []).map(stub => ({
    id: stub.id,
    name: stub.name,
    operations: (stub.operations || []).map(operation => ({
      name: operation.name,
      request_model_ids: operation.request_model_ids || [],
      response_model_ids: operation.response_model_ids || [],
    })),
  }))
  const element = {
    type: context.elementType,
    id: context.element.id,
    name: context.element.name,
    kind: context.element.kind,
    ...(context.element.type ? { model_type: context.element.type } : {}),
    ...(context.elementType === 'interact'
      ? {
        request_model_ids: context.element.request_model_ids || [],
        response_model_ids: context.element.response_model_ids || [],
        stub_ids: context.element.stub_ids || [],
      }
      : {}),
    ...(context.elementType === 'stub'
      ? {
        operations: (context.element.operations || []).map(operation => ({
          name: operation.name,
          request_model_ids: operation.request_model_ids || [],
          response_model_ids: operation.response_model_ids || [],
        })),
      }
      : {}),
  }
  return {
    domain: {
      id: context.domain.id,
      name: context.domain.name,
      brief: context.domain.brief,
      bounded_context: context.domain.bounded_context || context.domain.name,
    },
    element,
    allowed_node_types: allowedNodeTypes(context),
    models,
    stubs,
    rules: [
      'persist 节点只能操作当前领域的 persistence model，且只允许出现在 persistence model 根 matrix 与 stub 根 matrix。',
      'stub 节点只能调用当前领域的 stub operation，request/response model 必须与 operation 契约一致。',
      'interact 根 matrix 禁止 persist 节点，允许 stub 节点。',
      'request/response model 根 matrix 禁止 persist 节点。',
    ],
  }
}
