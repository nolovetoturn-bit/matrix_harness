/**
 * 领域能力导入：把不可变导出包落成本地只读 model/stub 副本。
 * 导入项保留 provider 映射，支持引用保护、版本锁定与显式升级。
 */
import { randomBytes } from 'node:crypto'
import { newModelId, newStubId } from './schema.mjs'

const now = () => new Date().toISOString()
const clone = value => (value === undefined ? null : structuredClone(value))

export const newImportId = () => `imp_${randomBytes(6).toString('hex')}`

const nameKey = value => String(value || '').trim().toLowerCase()

function nameExists(list, name, ignoreIds = new Set()) {
  return (list || []).some(item => !ignoreIds.has(item.id) && nameKey(item.name) === nameKey(name))
}

function importedElementIds(record) {
  return new Set([
    ...Object.values(record.model_map || {}),
    ...Object.values(record.stub_map || {}),
  ])
}

/**
 * 找出导入项被哪些本地元素引用；同一导入内部的相互引用不算外部引用。
 * @returns {{kind:string,name:string}[]}
 */
export function externalReferences(domain, { modelId = null, stubId = null, ignoreIds = new Set() } = {}) {
  const refs = []
  for (const model of domain.models || []) {
    if (ignoreIds.has(model.id)) continue
    if (modelId && (model.relations || []).some(relation => relation.target_model_id === modelId)) {
      refs.push({ kind: 'model', name: model.name })
    }
  }
  for (const stub of domain.stubs || []) {
    if (ignoreIds.has(stub.id)) continue
    const used = (stub.operations || []).some(operation => modelId
      && [...(operation.request_model_ids || []), ...(operation.response_model_ids || [])].includes(modelId))
    if (used) refs.push({ kind: 'stub', name: stub.name })
  }
  for (const interact of domain.interacts || []) {
    if (ignoreIds.has(interact.id)) continue
    const usedModel = modelId
      && [...(interact.request_model_ids || []), ...(interact.response_model_ids || [])].includes(modelId)
    const usedStub = stubId && (interact.stub_ids || []).includes(stubId)
    if (usedModel || usedStub) refs.push({ kind: 'interact', name: interact.name })
  }
  return refs
}

function buildModelRecord(model, localId, modelMap) {
  const relations = (model.relations || [])
    .map(relation => {
      const target = modelMap[relation.target_model_id]
      return target ? { ...clone(relation), target_model_id: target } : null
    })
    .filter(Boolean)
  return {
    id: localId,
    name: model.name,
    type: model.type,
    kind: model.kind || 'dto',
    description: model.description || '',
    attributes: clone(model.attributes || []),
    invariants: clone(model.invariants || []),
    relations,
    matrix_id: null,
    readonly: true,
    origin: model.origin || null,
  }
}

function buildStubRecord(stub, localId, modelMap) {
  return {
    id: localId,
    name: stub.name,
    kind: stub.kind,
    description: stub.description || '',
    operations: (stub.operations || []).map(operation => ({
      name: operation.name,
      request_model_ids: (operation.request_model_ids || []).map(id => modelMap[id]).filter(Boolean),
      response_model_ids: (operation.response_model_ids || []).map(id => modelMap[id]).filter(Boolean),
      ...(operation.description ? { description: operation.description } : {}),
    })),
    matrix_id: null,
    readonly: true,
    scope: 'domain',
    origin: stub.origin || null,
  }
}

/** 把导出包写入目标领域（调用方负责加锁与落盘）。 */
export function applyImportToDomain(domain, pkg) {
  if (!Array.isArray(domain.imports)) domain.imports = []
  if (domain.imports.some(record => record.export_id === pkg.export_id)) {
    throw new Error(`该导出包已导入：${pkg.export_id}`)
  }
  const modelMap = {}
  for (const model of pkg.models || []) {
    if (nameExists(domain.models, model.name)) throw new Error(`目标领域已存在同名 Model：${model.name}`)
    modelMap[model.id] = newModelId()
  }
  const stubMap = {}
  for (const stub of pkg.stubs || []) {
    if (nameExists(domain.stubs, stub.name)) throw new Error(`目标领域已存在同名 Stub：${stub.name}`)
    stubMap[stub.id] = newStubId()
  }
  for (const model of pkg.models || []) {
    if ((model.relations || []).some(relation => relation.target_model_id && !modelMap[relation.target_model_id])) {
      throw new Error(`导出包 ${pkg.export_id} 的 model 关系超出导出范围：${model.name}`)
    }
    domain.models.push({
      ...buildModelRecord(model, modelMap[model.id], modelMap),
      origin: { export_id: pkg.export_id, domain_id: pkg.domain_id, version: pkg.version, model_id: model.id },
      created_at: now(),
      updated_at: now(),
    })
  }
  for (const stub of pkg.stubs || []) {
    for (const operation of stub.operations || []) {
      for (const id of [...(operation.request_model_ids || []), ...(operation.response_model_ids || [])]) {
        if (!modelMap[id]) throw new Error(`导出包 ${pkg.export_id} 的 stub ${stub.name}.${operation.name} 引用了未导出的 model：${id}`)
      }
    }
    domain.stubs.push({
      ...buildStubRecord(stub, stubMap[stub.id], modelMap),
      origin: { export_id: pkg.export_id, domain_id: pkg.domain_id, version: pkg.version, stub_id: stub.id },
      created_at: now(),
      updated_at: now(),
    })
  }
  const record = {
    id: newImportId(),
    export_id: pkg.export_id,
    provider_domain_id: pkg.domain_id,
    version: pkg.version,
    checksum: pkg.checksum,
    model_map: modelMap,
    stub_map: stubMap,
    imported_at: now(),
  }
  domain.imports.push(record)
  return record
}

/** 移除导入：被本地元素引用或已创建适配矩阵时拒绝。 */
export function removeImportFromDomain(domain, importId) {
  const record = (domain.imports || []).find(item => item.id === importId || item.export_id === importId)
  if (!record) throw new Error(`导入记录不存在：${importId}`)
  const ignoreIds = importedElementIds(record)
  const modelIds = Object.values(record.model_map || {})
  const stubIds = Object.values(record.stub_map || {})
  const elements = [...(domain.models || []), ...(domain.stubs || [])]
  const bound = elements.filter(item => ignoreIds.has(item.id) && item.matrix_id)
  if (bound.length) throw new Error(`导入项已创建根 matrix，不能移除：${bound.map(item => item.name).join('、')}`)
  const blocking = []
  for (const modelId of modelIds) {
    const refs = externalReferences(domain, { modelId, ignoreIds })
    if (refs.length) blocking.push(`${modelId}（${refs.map(ref => ref.name).join('、')}）`)
  }
  for (const stubId of stubIds) {
    const refs = externalReferences(domain, { stubId, ignoreIds })
    if (refs.length) blocking.push(`${stubId}（${refs.map(ref => ref.name).join('、')}）`)
  }
  if (blocking.length) throw new Error(`导入项仍被本地元素引用，不能移除：${blocking.join('；')}`)
  domain.models = (domain.models || []).filter(model => !ignoreIds.has(model.id))
  domain.stubs = (domain.stubs || []).filter(stub => !ignoreIds.has(stub.id))
  domain.imports = (domain.imports || []).filter(item => item.id !== record.id)
  return record
}

function contentKey(value) {
  return JSON.stringify(value === undefined ? null : value)
}

/** 升级导入：保留既有本地 id 与适配矩阵，只同步契约内容。 */
export function upgradeImportInDomain(domain, oldPkg, newPkg, importId) {
  const record = (domain.imports || []).find(item => item.id === importId || item.export_id === importId)
  if (!record) throw new Error(`导入记录不存在：${importId}`)
  if (newPkg.domain_id !== record.provider_domain_id) throw new Error('新导出包不属于原 provider 领域')
  if (newPkg.version <= record.version) throw new Error(`新版本 ${newPkg.version} 不高于当前版本 ${record.version}`)

  const oldModels = new Map((oldPkg.models || []).map(model => [model.id, model]))
  const newModels = new Map((newPkg.models || []).map(model => [model.id, model]))
  const oldStubs = new Map((oldPkg.stubs || []).map(stub => [stub.id, stub]))
  const newStubs = new Map((newPkg.stubs || []).map(stub => [stub.id, stub]))
  const ignoreIds = importedElementIds(record)

  for (const providerId of oldModels.keys()) {
    if (newModels.has(providerId)) continue
    const localId = record.model_map[providerId]
    const refs = externalReferences(domain, { modelId: localId, ignoreIds })
    if (refs.length) throw new Error(`新版本移除了仍被引用的 Model：${oldModels.get(providerId).name}（${refs.map(ref => ref.name).join('、')}）`)
  }
  for (const providerId of oldStubs.keys()) {
    if (newStubs.has(providerId)) continue
    const localId = record.stub_map[providerId]
    const stub = (domain.stubs || []).find(item => item.id === localId)
    if (stub && stub.matrix_id) throw new Error(`新版本移除了已有适配 matrix 的 Stub：${oldStubs.get(providerId).name}`)
    const refs = externalReferences(domain, { stubId: localId, ignoreIds })
    if (refs.length) throw new Error(`新版本移除了仍被引用的 Stub：${oldStubs.get(providerId).name}（${refs.map(ref => ref.name).join('、')}）`)
  }

  const modelMap = {}
  const toAddModels = []
  for (const providerId of newModels.keys()) {
    const existing = record.model_map[providerId]
    if (existing) {
      modelMap[providerId] = existing
      continue
    }
    const model = newModels.get(providerId)
    if (nameExists(domain.models, model.name, ignoreIds)) throw new Error(`目标领域已存在同名 Model：${model.name}`)
    modelMap[providerId] = newModelId()
    toAddModels.push({ providerId, localId: modelMap[providerId] })
  }
  const stubMap = {}
  const toAddStubs = []
  for (const providerId of newStubs.keys()) {
    const existing = record.stub_map[providerId]
    if (existing) {
      stubMap[providerId] = existing
      continue
    }
    const stub = newStubs.get(providerId)
    if (nameExists(domain.stubs, stub.name, ignoreIds)) throw new Error(`目标领域已存在同名 Stub：${stub.name}`)
    stubMap[providerId] = newStubId()
    toAddStubs.push({ providerId, localId: stubMap[providerId] })
  }

  // 先删除被 provider 移除的导入项
  for (const providerId of oldModels.keys()) {
    if (newModels.has(providerId)) continue
    const localId = record.model_map[providerId]
    domain.models = domain.models.filter(model => model.id !== localId)
  }
  for (const providerId of oldStubs.keys()) {
    if (newStubs.has(providerId)) continue
    const localId = record.stub_map[providerId]
    domain.stubs = domain.stubs.filter(stub => stub.id !== localId)
  }

  const changedModels = []
  for (const [providerId, model] of newModels.entries()) {
    const localId = modelMap[providerId]
    const existing = (domain.models || []).find(item => item.id === localId)
    const next = {
      ...buildModelRecord(model, localId, modelMap),
      origin: { export_id: newPkg.export_id, domain_id: newPkg.domain_id, version: newPkg.version, model_id: providerId },
      matrix_id: existing ? existing.matrix_id : null,
      created_at: existing ? existing.created_at : now(),
      updated_at: now(),
    }
    if (existing) {
      if (contentKey({ attributes: existing.attributes, invariants: existing.invariants, relations: existing.relations })
        !== contentKey({ attributes: next.attributes, invariants: next.invariants, relations: next.relations })) {
        changedModels.push(next.name)
      }
      Object.assign(existing, next)
    } else {
      domain.models.push(next)
    }
  }

  const changedStubs = []
  for (const [providerId, stub] of newStubs.entries()) {
    const localId = stubMap[providerId]
    const existing = (domain.stubs || []).find(item => item.id === localId)
    const next = {
      ...buildStubRecord(stub, localId, modelMap),
      origin: { export_id: newPkg.export_id, domain_id: newPkg.domain_id, version: newPkg.version, stub_id: providerId },
      matrix_id: existing ? existing.matrix_id : null,
      created_at: existing ? existing.created_at : now(),
      updated_at: now(),
    }
    if (existing) {
      if (contentKey(existing.operations) !== contentKey(next.operations)) changedStubs.push(next.name)
      Object.assign(existing, next)
    } else {
      domain.stubs.push(next)
    }
  }

  record.export_id = newPkg.export_id
  record.version = newPkg.version
  record.checksum = newPkg.checksum
  record.model_map = modelMap
  record.stub_map = stubMap
  record.upgraded_at = now()

  return {
    import_id: record.id,
    version_from: oldPkg.version,
    version_to: newPkg.version,
    export_id: newPkg.export_id,
    added_models: toAddModels.map(item => newModels.get(item.providerId).name),
    removed_models: [...oldModels.keys()].filter(id => !newModels.has(id)).map(id => oldModels.get(id).name),
    added_stubs: toAddStubs.map(item => newStubs.get(item.providerId).name),
    removed_stubs: [...oldStubs.keys()].filter(id => !newStubs.has(id)).map(id => oldStubs.get(id).name),
    changed_models: changedModels,
    changed_stubs: changedStubs,
  }
}
