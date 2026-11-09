import { randomBytes } from 'node:crypto'

export const DOMAIN_STATES = Object.freeze({ DRAFT: 'draft', ACTIVE: 'active', ARCHIVED: 'archived' })

export const MODEL_TYPES = Object.freeze(['request', 'response', 'persistence'])
export const MODEL_KINDS = Object.freeze(['entity', 'value_object', 'domain_event', 'dto'])
export const PERSISTENCE_MODEL_KINDS = Object.freeze(['entity', 'value_object', 'domain_event'])
export const STUB_KINDS = Object.freeze(['repository', 'domain_service', 'external_service', 'acl', 'notification', 'other'])
export const INTERACT_KINDS = Object.freeze(['command', 'query', 'use_case'])

export const DOMAIN_LIMITS = Object.freeze({ elements: 200, fields: 50 })

export const newDomainId = () => `dom_${randomBytes(6).toString('hex')}`
export const newModelId = () => `mdl_${randomBytes(6).toString('hex')}`
export const newStubId = () => `stb_${randomBytes(6).toString('hex')}`
export const newInteractId = () => `itx_${randomBytes(6).toString('hex')}`

const idOf = (prefix, value) => new RegExp(`^${prefix}[A-Za-z0-9_-]{4,40}$`)
const trim = (value, limit) => String(value ?? '').trim().slice(0, limit)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function assertDomainId(id) {
  if (!/^dom_[A-Za-z0-9_-]{4,40}$/.test(String(id || ''))) throw new Error(`domain_id 格式不正确：${id}`)
  return id
}
export function assertModelId(id) {
  if (!idOf('mdl_').test(String(id || ''))) throw new Error(`model_id 格式不正确：${id}`)
  return id
}
export function assertStubId(id) {
  if (!idOf('stb_').test(String(id || ''))) throw new Error(`stub_id 格式不正确：${id}`)
  return id
}
export function assertInteractId(id) {
  if (!idOf('itx_').test(String(id || ''))) throw new Error(`interact_id 格式不正确：${id}`)
  return id
}

export function createDomainRecord({ project_id, name, brief = '', cwd = null, id = newDomainId() }) {
  const title = trim(name, 120)
  if (!title) throw new Error('领域名称不能为空')
  const now = new Date().toISOString()
  return {
    version: 1,
    id,
    project_id,
    name: title,
    brief: trim(brief, 4000),
    bounded_context: title,
    ubiquitous_language: [],
    state: DOMAIN_STATES.ACTIVE,
    cwd: cwd || null,
    dsh_session_id: null,
    parent_session_id: project_id,
    // 已归档到领域的 dsh 会话事件游标
    dsh_event_seq: 0,
    dsh_mirror_seq: 0,
    memory: { entries: [], updated_at: now },
    models: [],
    stubs: [],
    interacts: [],
    // 领域能力导出 / 导入记录（导入项本身以 readonly 副本存于 models/stubs）
    exports: [],
    imports: [],
    messages: [],
    message_seq: 0,
    archive: [],
    archive_seq: 0,
    created_at: now,
    updated_at: now,
  }
}

const stringList = (value, limit = 30) => (Array.isArray(value) ? value : [])
  .map(item => trim(item, 300))
  .filter(Boolean)
  .slice(0, limit)

export function normalizeModelInput(raw = {}, { id } = {}) {
  if (!isObject(raw)) throw new Error('model 必须是对象')
  const name = trim(raw.name, 120)
  if (!name) throw new Error('model.name 不能为空')
  const type = trim(raw.type, 24) || 'persistence'
  if (!MODEL_TYPES.includes(type)) throw new Error(`model.type 只能是 ${MODEL_TYPES.join('/')} 之一`)
  const rawKind = trim(raw.kind, 24) || (type === 'persistence' ? 'entity' : 'dto')
  const kind = type === 'persistence' ? (rawKind === 'aggregate' ? 'entity' : rawKind) : 'dto'
  if (type === 'persistence' && !PERSISTENCE_MODEL_KINDS.includes(kind)) {
    throw new Error(`persistence model.kind 只能是 ${PERSISTENCE_MODEL_KINDS.join('/')} 之一`)
  }
  const attributes = (Array.isArray(raw.attributes) ? raw.attributes : [])
    .filter(isObject)
    .slice(0, DOMAIN_LIMITS.fields)
    .map(attribute => ({
      name: trim(attribute.name, 80),
      type: trim(attribute.type, 60) || 'string',
      required: Boolean(attribute.required),
      ...(attribute.description ? { description: trim(attribute.description, 200) } : {}),
    }))
    .filter(attribute => attribute.name)
  const relations = (Array.isArray(raw.relations) ? raw.relations : [])
    .filter(isObject)
    .slice(0, DOMAIN_LIMITS.fields)
    .map(relation => ({
      target_model_id: trim(relation.target_model_id, 40) || null,
      kind: trim(relation.kind, 40) || 'association',
      ...(relation.description ? { description: trim(relation.description, 200) } : {}),
    }))
  return {
    id: id || (raw.id && /^mdl_[A-Za-z0-9_-]{4,40}$/.test(raw.id) ? raw.id : newModelId()),
    name,
    type,
    kind,
    description: trim(raw.description, 1000),
    attributes,
    invariants: stringList(raw.invariants, 20),
    relations,
    matrix_id: raw.matrix_id || null,
  }
}

export function normalizeStubInput(raw = {}, { id } = {}) {
  if (!isObject(raw)) throw new Error('stub 必须是对象')
  const name = trim(raw.name, 120)
  if (!name) throw new Error('stub.name 不能为空')
  const kind = trim(raw.kind, 24) || 'domain_service'
  if (!STUB_KINDS.includes(kind)) throw new Error(`stub.kind 只能是 ${STUB_KINDS.join('/')} 之一`)
  const operations = (Array.isArray(raw.operations) ? raw.operations : [])
    .filter(isObject)
    .slice(0, DOMAIN_LIMITS.fields)
    .map(operation => ({
      name: trim(operation.name, 80),
      request_model_ids: stringList(operation.request_model_ids, 50),
      response_model_ids: stringList(operation.response_model_ids, 50),
      ...(operation.description ? { description: trim(operation.description, 300) } : {}),
      // 旧契约仅作迁移期参考；新写契约使用 request/response model ids。
      ...(operation.input !== undefined ? { input: operation.input } : {}),
      ...(operation.output !== undefined ? { output: operation.output } : {}),
    }))
    .filter(operation => operation.name)
  return {
    id: id || (raw.id && /^stb_[A-Za-z0-9_-]{4,40}$/.test(raw.id) ? raw.id : newStubId()),
    name,
    kind,
    description: trim(raw.description, 1000),
    operations,
    matrix_id: raw.matrix_id || null,
  }
}

export function normalizeInteractInput(raw = {}, { id } = {}) {
  if (!isObject(raw)) throw new Error('interact 必须是对象')
  const name = trim(raw.name, 120)
  if (!name) throw new Error('interact.name 不能为空')
  const kind = trim(raw.kind, 24) || 'use_case'
  if (!INTERACT_KINDS.includes(kind)) throw new Error(`interact.kind 只能是 ${INTERACT_KINDS.join('/')} 之一`)
  return {
    id: id || (raw.id && /^itx_[A-Za-z0-9_-]{4,40}$/.test(raw.id) ? raw.id : newInteractId()),
    name,
    kind,
    description: trim(raw.description, 1000),
    actors: stringList(raw.actors, 20),
    request_model_ids: stringList(raw.request_model_ids !== undefined ? raw.request_model_ids : raw.model_ids, 50),
    response_model_ids: stringList(raw.response_model_ids, 50),
    stub_ids: stringList(raw.stub_ids, 50),
    preconditions: stringList(raw.preconditions, 20),
    postconditions: stringList(raw.postconditions, 20),
    main_flow: stringList(raw.main_flow, 30),
    alternatives: stringList(raw.alternatives, 20),
    matrix_id: raw.matrix_id || null,
  }
}

export function elementIdsOf(domain) {
  return {
    models: (domain.models || []).map(item => item.id),
    stubs: (domain.stubs || []).map(item => item.id),
    interacts: (domain.interacts || []).map(item => item.id),
  }
}
