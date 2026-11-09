import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { archiveEntry, chatMessage } from '../matrix/messages.mjs'
import { listQuestions } from '../matrix/questions.mjs'
import { deriveState, STATES } from '../matrix/state.mjs'
import { loadAll, loadMatrix, resolveDataDir, saveMatrix } from '../matrix/store.mjs'
import { intake } from '../matrix/service.mjs'
import { autoCheckpoint } from '../project/git.mjs'
import { assertProjectId } from '../project/schema.mjs'
import { appendProjectOperation, ensureProjectsMigrated, loadProject, projectWorkDir, saveProject, updateProject } from '../project/store.mjs'
import { ensureProjectSession } from '../project/session.mjs'
import {
  addDomainMemoryEntry,
  domainMemoryEntries,
  removeDomainMemoryEntry,
  updateDomainMemoryEntry,
  writeDomainMemoryFile,
} from './memory.mjs'
import {
  assertDomainId,
  createDomainRecord,
  DOMAIN_STATES,
  normalizeInteractInput,
  normalizeModelInput,
  normalizeStubInput,
} from './schema.mjs'
import { domainBrief, ensureDomainSession } from './session.mjs'
import {
  buildExportPackage,
  latestExportForDomain,
  listExports,
  loadExport,
  nextVersionOf,
  saveExport,
} from './registry.mjs'
import { applyImportToDomain, removeImportFromDomain, upgradeImportInDomain } from './import.mjs'
import {
  domainWorkDir,
  ensureDomainShape,
  loadDomain,
  saveDomain,
  updateDomain,
} from './store.mjs'

const dataDirOf = args => resolveDataDir(args.data_dir)
const now = () => new Date().toISOString()

/** 解析 project_id：显式参数优先；否则用项目会话或领域会话自动绑定。 */
function projectIdOf(args = {}, context = {}) {
  const explicit = String(args.project_id || '').trim()
  if (explicit) return assertProjectId(explicit)
  const sessionId = String((context && context.sessionId) || '').trim()
  if (/^pj_[A-Za-z0-9_-]{4,40}$/.test(sessionId)) return assertProjectId(sessionId)
  const prefixedProject = /^(pj_[A-Za-z0-9]+)-/.exec(sessionId)
  if (prefixedProject) return assertProjectId(prefixedProject[1])
  const prefixedDomain = /^(dom_[A-Za-z0-9]+)-/.exec(sessionId)
  if (prefixedDomain) {
    try {
      return loadDomain(dataDirOf(args), prefixedDomain[1]).project_id
    } catch {}
  }
  throw new Error('无法从当前会话确定 project_id：请在参数中显式传 project_id')
}

function domainIdOf(args = {}, context = {}) {
  const explicit = String(args.domain_id || (typeof args.id === 'string' && args.id.startsWith('dom_') ? args.id : '') || '').trim()
  if (explicit) return assertDomainId(explicit)
  const sessionId = String((context && context.sessionId) || '').trim()
  if (/^dom_[A-Za-z0-9_-]{4,40}$/.test(sessionId)) return assertDomainId(sessionId)
  const prefixed = /^(dom_[A-Za-z0-9]+)-/.exec(sessionId)
  if (prefixed) return assertDomainId(prefixed[1])
  throw new Error('无法从当前会话确定 domain_id：请在参数中显式传 domain_id')
}

function requireDomain(dataDir, domainId) {
  return ensureDomainShape(loadDomain(dataDir, domainId))
}

function requireProject(dataDir, projectId) {
  assertProjectId(projectId)
  return loadProject(dataDir, projectId)
}

const pluralOf = kind => ({ model: 'models', stub: 'stubs', interact: 'interacts' })[kind]

function elementOf(domain, kind, selector = {}) {
  const list = domain[pluralOf(kind)] || []
  const id = String(selector.element_id || selector.id || '').trim()
  if (id) return list.find(item => item.id === id) || null
  const name = String(selector.name || '').trim().toLowerCase()
  return name ? list.find(item => String(item.name || '').toLowerCase() === name) || null : null
}

function matrixSummary(matrixId, matrices) {
  if (!matrixId) return null
  const matrix = matrices.get(matrixId)
  if (!matrix) return { id: matrixId, missing: true }
  const state = deriveState(matrix, matrices)
  return {
    id: matrix.id,
    name: matrix.name,
    state,
    runnable: state === STATES.RUNNABLE,
    accepted: state === STATES.ACCEPTED,
    archived_at: matrix.archived_at || null,
    children_total: (matrix.children || []).length,
    updated_at: matrix.updated_at,
  }
}

function coverageOf(domain) {
  const count = kind => {
    const list = domain[kind] || []
    return { total: list.length, implemented: list.filter(item => item.matrix_id).length }
  }
  return { models: count('models'), stubs: count('stubs'), interacts: count('interacts') }
}

function domainView(dataDir, domain) {
  const matrices = loadAll(dataDir)
  const project = (() => {
    try { return loadProject(dataDir, domain.project_id) } catch { return null }
  })()
  const decorate = (kind, item) => ({
    ...item,
    matrix: matrixSummary(item.matrix_id, matrices),
    contract_errors: contractErrors(domain, kind, item),
  })
  const oplog = project && Array.isArray(project.oplog)
    ? project.oplog.filter(entry => (entry.target_type === 'domain' && entry.target_id === domain.id)
      || (entry.target_type === 'domain_element' && entry.detail && entry.detail.domain_id === domain.id))
    : []
  return {
    id: domain.id,
    project_id: domain.project_id,
    project_name: project ? project.name : null,
    name: domain.name,
    brief: domain.brief,
    bounded_context: domain.bounded_context || domain.name,
    ubiquitous_language: domain.ubiquitous_language || [],
    state: domain.state,
    cwd: domain.cwd,
    dsh_session_id: domain.dsh_session_id,
    parent_session_id: domain.parent_session_id,
    models: (domain.models || []).map(item => decorate('model', item)),
    stubs: (domain.stubs || []).map(item => decorate('stub', item)),
    interacts: (domain.interacts || []).map(item => decorate('interact', item)),
    exports: domain.exports || [],
    imports: domain.imports || [],
    coverage: coverageOf(domain),
    memory: {
      entries: domainMemoryEntries(domain),
      updated_at: domain.memory.updated_at,
      file: domain.cwd ? join(domain.cwd, 'DOMAIN_MEMORY.md') : null,
      file_exists: domain.cwd ? existsSync(join(domain.cwd, 'DOMAIN_MEMORY.md')) : false,
    },
    messages: domain.messages || [],
    archive: domain.archive || [],
    oplog,
    questions: listQuestions(dataDir, domain.id),
    created_at: domain.created_at,
    updated_at: domain.updated_at,
  }
}

/** dsh 会话 → 领域归档，重复轮询不重复写入。 */
async function syncDomainArchive(dataDir, domain, dependencies = {}) {
  if (typeof dependencies.sessionEvents !== 'function' || !domain.dsh_session_id) return
  const since = Number(domain.dsh_event_seq) || 0
  let snapshot
  try {
    snapshot = await dependencies.sessionEvents({ sessionId: domain.dsh_session_id, sinceSeq: since })
  } catch {
    return
  }
  const events = (snapshot && snapshot.events) || []
  const cursor = Number(snapshot && snapshot.cursor)
  const textOf = content => Array.isArray(content)
    ? content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('').trim()
    : ''
  let changed = false
  for (const event of events) {
    if (!event || Number(event.seq) < since) continue
    const data = event.data || {}
    if (event.type === 'assistant/message') {
      const source = data.message && data.message.source
      const mirrored = source && source.kind === 'model' && source.model === 'matrix-mirror'
      const text = textOf(data.message && data.message.content)
      if (text && !mirrored) {
        chatMessage(domain, 'assistant', text, { source: 'dsh', session_time: event.time })
        changed = true
      }
    } else if (event.type === 'user/message') {
      const source = data.source && data.source.kind
      const text = textOf(data.content)
      if (source === 'user' && text) {
        chatMessage(domain, 'user', text, { source: 'dsh', session_time: event.time })
        changed = true
      }
    } else if (event.type === 'tool/call') {
      archiveEntry(domain, {
        type: 'tool',
        source: 'dsh',
        text: String(data.name || ''),
        data: { name: data.name, callId: data.callId, arguments: data.arguments, session_time: event.time },
      })
      changed = true
    }
  }
  if (Number.isInteger(cursor) && cursor > since) {
    domain.dsh_event_seq = cursor
    changed = true
  }
  if (changed) saveDomain(dataDir, domain)
}

async function detailOf(dataDir, domainId, dependencies = {}) {
  const domain = requireDomain(dataDir, domainId)
  await syncDomainArchive(dataDir, domain, dependencies)
  const view = domainView(dataDir, domain)
  if (typeof dependencies.agentStatus === 'function' && view.dsh_session_id) {
    try {
      view.agent = await dependencies.agentStatus({ sessionId: view.dsh_session_id })
    } catch {
      view.agent = null
    }
  }
  return view
}

async function logDomainOperation(dataDir, project, domain, { action, targetType = 'domain', targetId = domain.id, targetName = domain.name, detail = null } = {}) {
  await updateProject(dataDir, project.id, current => {
    appendProjectOperation(current, {
      action,
      target_type: targetType,
      target_id: targetId,
      target_name: targetName,
      detail: { domain_id: domain.id, ...(detail || {}) },
    })
  })
}

/** 新建领域：落领域文件、挂到项目、建项目会话下的领域会话、初始化领域记忆。 */
export async function domainCreate(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const projectId = projectIdOf(args, context)
  let project = requireProject(dataDir, projectId)
  const name = String(args.name || '').trim()
  if (!name) throw new Error('领域名称不能为空')
  const domain = createDomainRecord({ project_id: projectId, name, brief: args.brief || args.description || '' })
  if (Array.isArray(args.ubiquitous_language)) {
    domain.ubiquitous_language = args.ubiquitous_language
      .map(item => String(item || '').trim()).filter(Boolean).slice(0, 50)
  }
  domain.cwd = domainWorkDir(dataDir, domain)
  saveDomain(dataDir, domain)
  await updateProject(dataDir, projectId, current => {
    current.domain_ids = [...(current.domain_ids || []).filter(id => id !== domain.id), domain.id]
    appendProjectOperation(current, {
      action: 'domain_create',
      target_type: 'domain',
      target_id: domain.id,
      target_name: domain.name,
      detail: { domain_id: domain.id, brief: domain.brief },
    })
  })
  // 重新读取，避免用 updateProject 之前的旧对象覆盖 domain_ids
  project = requireProject(dataDir, projectId)
  try {
    await ensureProjectSession(project, { ...dependencies, dataDir })
    saveProject(dataDir, project)
    await ensureDomainSession(domain, project, { ...dependencies, dataDir })
    writeDomainMemoryFile(domain)
  } finally {
    saveDomain(dataDir, domain)
  }
  await autoCheckpoint(dataDir, projectId, `新建领域 ${domain.name}`, dependencies)
  return detailOf(dataDir, domain.id, dependencies)
}

export function domainList(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  ensureProjectsMigrated(dataDir)
  const projectId = projectIdOf(args, context)
  const project = requireProject(dataDir, projectId)
  const includeArchived = args.include_archived === true
  const domains = (project.domain_ids || [])
    .map(id => {
      try { return loadDomain(dataDir, id) } catch { return null }
    })
    .filter(Boolean)
    .filter(domain => includeArchived || domain.state === DOMAIN_STATES.ACTIVE)
    .map(domain => {
      const coverage = coverageOf(domain)
      return {
        id: domain.id,
        name: domain.name,
        brief: domain.brief,
        bounded_context: domain.bounded_context,
        state: domain.state,
        models: coverage.models.total,
        stubs: coverage.stubs.total,
        interacts: coverage.interacts.total,
        implemented: coverage.models.implemented + coverage.stubs.implemented + coverage.interacts.implemented,
        total: coverage.models.total + coverage.stubs.total + coverage.interacts.total,
        dsh_session_id: domain.dsh_session_id,
        updated_at: domain.updated_at,
      }
    })
  return { project_id: projectId, total: domains.length, domains }
}

export async function domainGet(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  return detailOf(dataDir, domainIdOf(args, context), dependencies)
}

export async function domainUpdate(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const domain = await updateDomain(dataDir, domainId, current => {
    if (args.name !== undefined) {
      const name = String(args.name || '').trim()
      if (!name) throw new Error('领域名称不能为空')
      current.name = name.slice(0, 120)
    }
    if (args.brief !== undefined) current.brief = String(args.brief || '').trim().slice(0, 4000)
    if (args.bounded_context !== undefined) current.bounded_context = String(args.bounded_context || '').trim().slice(0, 120) || current.name
    if (args.ubiquitous_language !== undefined) {
      current.ubiquitous_language = (Array.isArray(args.ubiquitous_language) ? args.ubiquitous_language : [])
        .map(item => String(item || '').trim()).filter(Boolean).slice(0, 50)
    }
  })
  await logDomainOperation(dataDir, requireProject(dataDir, domain.project_id), domain, { action: 'domain_update' })
  await autoCheckpoint(dataDir, domain.project_id, `更新领域 ${domain.name}`, dependencies)
  return detailOf(dataDir, domainId, dependencies)
}

export async function domainArchive(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const domain = await updateDomain(dataDir, domainId, current => {
    current.state = DOMAIN_STATES.ARCHIVED
  })
  await logDomainOperation(dataDir, requireProject(dataDir, domain.project_id), domain, { action: 'domain_archive' })
  await autoCheckpoint(dataDir, domain.project_id, `归档领域 ${domain.name}`, dependencies)
  return detailOf(dataDir, domainId, dependencies)
}

/** 领域记忆：list / add / update / remove，变更同步 DOMAIN_MEMORY.md。 */
export async function domainMemory(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const action = String(args.action || 'list').trim()
  const domain = requireDomain(dataDir, domainId)
  if (action === 'list') {
    return {
      domain_id: domain.id,
      entries: domainMemoryEntries(domain),
      updated_at: domain.memory.updated_at,
      file: domain.cwd ? join(domain.cwd, 'DOMAIN_MEMORY.md') : null,
    }
  }
  const result = await updateDomain(dataDir, domainId, current => {
    current.cwd = current.cwd || domainWorkDir(dataDir, current)
    let entry = null
    if (action === 'add') entry = addDomainMemoryEntry(current, { text: args.text, tags: args.tags })
    else if (action === 'update') entry = updateDomainMemoryEntry(current, { id: args.entry_id || args.id, text: args.text })
    else if (action === 'remove') removeDomainMemoryEntry(current, args.entry_id || args.id)
    else throw new Error(`不支持的 domain_memory action：${action}`)
    writeDomainMemoryFile(current)
  })
  await logDomainOperation(dataDir, requireProject(dataDir, domain.project_id), result, {
    action: `memory_${action}`,
    targetType: 'domain_element',
    targetId: args.entry_id || args.id || null,
    targetName: null,
    detail: { text: String(args.text || '').slice(0, 200) },
  })
  await autoCheckpoint(dataDir, domain.project_id, `领域记忆 ${action}`, dependencies)
  return {
    domain_id: domainId,
    entries: domainMemoryEntries(result),
    updated_at: result.memory.updated_at,
    file: result.cwd ? join(result.cwd, 'DOMAIN_MEMORY.md') : null,
  }
}

/** 项目 oplog 记录领域记忆变更是由 logDomainOperation 统一处理的，这里只保留占位。 */
function appendProjectOperationForMemory() {}

function validateRelations(domain, model, extraId = null) {
  const models = new Map((domain.models || []).map(item => [item.id, item]))
  if (extraId) models.set(extraId, model)
  for (const relation of model.relations || []) {
    if (!relation.target_model_id) continue
    const target = models.get(relation.target_model_id)
    if (!target) throw new Error(`model ${model.name} 的关系指向不存在的 model：${relation.target_model_id}`)
    if (target.type !== model.type) {
      throw new Error(`model ${model.name} 的关系只能引用同 type model：${relation.target_model_id}`)
    }
  }
}

function validateStub(domain, stub) {
  const models = new Map((domain.models || []).map(item => [item.id, item]))
  for (const operation of stub.operations || []) {
    for (const [field, type] of [['request_model_ids', 'request'], ['response_model_ids', 'response']]) {
      for (const id of operation[field] || []) {
        const model = models.get(id)
        if (!model) throw new Error(`stub ${stub.name}.${operation.name} 引用了不存在的 model：${id}`)
        if (model.type !== type) {
          throw new Error(`stub ${stub.name}.${operation.name} 的 ${field} 只能引用 type=${type} model：${id}`)
        }
      }
    }
  }
}

function validateInteract(domain, interact) {
  const models = new Map((domain.models || []).map(item => [item.id, item]))
  const stubIds = new Set((domain.stubs || []).map(item => item.id))
  for (const [field, type] of [['request_model_ids', 'request'], ['response_model_ids', 'response']]) {
    for (const id of interact[field] || []) {
      const model = models.get(id)
      if (!model) throw new Error(`interact ${interact.name} 引用了不存在的 model：${id}`)
      if (model.type !== type) {
        throw new Error(`interact ${interact.name} 的 ${field} 只能引用 type=${type} model，禁止 persistence 等其它类型：${id}`)
      }
    }
  }
  const missingStubs = (interact.stub_ids || []).filter(id => !stubIds.has(id))
  if (missingStubs.length) throw new Error(`interact ${interact.name} 引用了不存在的 stub：${missingStubs.join('、')}`)
  if (!interact.request_model_ids.length && !interact.response_model_ids.length && !interact.stub_ids.length) {
    throw new Error(`interact ${interact.name} 至少要引用一个 model 或 stub`)
  }
}

function validateElement(domain, kind, element) {
  if (kind === 'model') return validateRelations(domain, element)
  if (kind === 'stub') return validateStub(domain, element)
  return validateInteract(domain, element)
}

function contractErrors(domain, kind, element) {
  try {
    validateElement(domain, kind, element)
    return []
  } catch (error) {
    return [error.message]
  }
}

function validateModelDependents(domain, modelId) {
  for (const model of domain.models || []) {
    if ((model.relations || []).some(relation => relation.target_model_id === modelId)) validateRelations(domain, model)
  }
  for (const stub of domain.stubs || []) {
    const used = (stub.operations || []).some(operation => [...(operation.request_model_ids || []), ...(operation.response_model_ids || [])].includes(modelId))
    if (used) validateStub(domain, stub)
  }
  for (const interact of domain.interacts || []) {
    if ([...(interact.request_model_ids || []), ...(interact.response_model_ids || [])].includes(modelId)) validateInteract(domain, interact)
  }
}

const KIND_NORMALIZER = {
  model: normalizeModelInput,
  stub: normalizeStubInput,
  interact: normalizeInteractInput,
}

function kindGuid(domain, kind) {
  if (kind === 'model') return domain.models || []
  if (kind === 'stub') return domain.stubs || []
  if (kind === 'interact') return domain.interacts || []
  throw new Error(`未知领域元素类型：${kind}`)
}

function setKindList(domain, kind, list) {
  if (kind === 'model') domain.models = list
  else if (kind === 'stub') domain.stubs = list
  else if (kind === 'interact') domain.interacts = list
  else throw new Error(`未知领域元素类型：${kind}`)
}

/** 元素 upsert：id 或同名视为更新；matrix_id 只能通过领域 matrix 工具设置。 */
export async function domainElementUpsert(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const kind = String(args.kind || '').trim()
  if (!KIND_NORMALIZER[kind]) throw new Error(`kind 只能是 model / stub / interact`)
  const raw = { ...(args.element || args.payload || {}) }
  let touched = null
  const domain = await updateDomain(dataDir, domainId, current => {
    ensureDomainShape(current)
    const list = kindGuid(current, kind)
    const existing = elementOf(current, kind, { element_id: raw.id, name: raw.name })
    if (existing && existing.readonly) {
      throw new Error(`${kind} ${existing.name} 是导入项，只读；请通过 domain_import_upgrade 升级契约`)
    }
    const normalized = KIND_NORMALIZER[kind](raw, { id: existing ? existing.id : undefined })
    normalized.matrix_id = existing ? existing.matrix_id : null
    normalized.created_at = existing ? existing.created_at : now()
    normalized.updated_at = now()
    if (kind === 'model') validateRelations(current, normalized, normalized.id)
    if (kind === 'stub') validateStub(current, normalized)
    if (kind === 'interact') {
      // 先把其它元素放回列表，引用校验才能看到已存在元素
      if (existing) {
        const idx = list.findIndex(item => item.id === existing.id)
        list[idx] = normalized
      }
      validateInteract(current, normalized)
      if (!existing) {
        if (list.length >= 200) throw new Error('领域元素数量超过上限')
        list.push(normalized)
      }
    } else if (existing) {
      const idx = list.findIndex(item => item.id === existing.id)
      list[idx] = normalized
    } else {
      if (list.length >= 200) throw new Error('领域元素数量超过上限')
      list.push(normalized)
    }
    setKindList(current, kind, list)
    if (kind === 'model') validateModelDependents(current, normalized.id)
    touched = normalized
    archiveEntry(current, {
      type: 'event',
      source: 'domain',
      text: `${existing ? '更新' : '新增'} ${kind} ${normalized.name}（${normalized.id}）`,
      data: { kind, element_id: normalized.id },
    })
  })
  await logDomainOperation(dataDir, requireProject(dataDir, domain.project_id), domain, {
    action: `domain_${kind}_upsert`,
    targetType: 'domain_element',
    targetId: touched ? touched.id : null,
    targetName: touched ? touched.name : null,
  })
  await autoCheckpoint(dataDir, domain.project_id, `领域元素 ${kind} ${touched ? touched.name : ''}`, dependencies)
  return detailOf(dataDir, domainId, dependencies)
}

export async function domainElementRemove(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const kind = String(args.kind || '').trim()
  if (!KIND_NORMALIZER[kind]) throw new Error(`kind 只能是 model / stub / interact`)
  let removed = null
  const domain = await updateDomain(dataDir, domainId, current => {
    ensureDomainShape(current)
    const list = kindGuid(current, kind)
    const target = elementOf(current, kind, args)
    if (!target) throw new Error(`${kind} 不存在：${args.element_id || args.id || args.name || ''}`)
    if (target.readonly) throw new Error(`${kind} ${target.name} 是导入项，只读；请通过 domain_import_remove 移除`)
    if (target.matrix_id) throw new Error(`${kind} ${target.name} 已有根 matrix，请先在 matrix 侧解除绑定`)
    // 跨元素引用保护：被流程或服务契约引用的 model/stub 不允许删除。
    if (kind === 'model' || kind === 'stub') {
      const used = (current.interacts || []).filter(interact => kind === 'model'
        ? [...(interact.request_model_ids || []), ...(interact.response_model_ids || [])].includes(target.id)
        : (interact.stub_ids || []).includes(target.id))
      if (used.length) throw new Error(`${kind} ${target.name} 仍被 interact 引用：${used.map(item => item.name).join('、')}`)
      if (kind === 'model') {
        const usedByStubs = (current.stubs || []).filter(stub => (stub.operations || []).some(operation =>
          [...(operation.request_model_ids || []), ...(operation.response_model_ids || [])].includes(target.id)))
        if (usedByStubs.length) throw new Error(`model ${target.name} 仍被 stub 引用：${usedByStubs.map(item => item.name).join('、')}`)
        const usedByModels = (current.models || []).filter(model => model.id !== target.id
          && (model.relations || []).some(relation => relation.target_model_id === target.id))
        if (usedByModels.length) throw new Error(`model ${target.name} 仍被 model 关系引用：${usedByModels.map(item => item.name).join('、')}`)
      }
    }
    setKindList(current, kind, list.filter(item => item.id !== target.id))
    removed = target
    archiveEntry(current, {
      type: 'event',
      source: 'domain',
      text: `删除 ${kind} ${target.name}（${target.id}）`,
      data: { kind, element_id: target.id },
    })
  })
  await logDomainOperation(dataDir, requireProject(dataDir, domain.project_id), domain, {
    action: `domain_${kind}_remove`,
    targetType: 'domain_element',
    targetId: removed ? removed.id : null,
    targetName: removed ? removed.name : null,
  })
  await autoCheckpoint(dataDir, domain.project_id, `删除领域元素 ${kind}`, dependencies)
  return detailOf(dataDir, domainId, dependencies)
}

function describeElement(domain, kind, element) {
  const lines = [
    `【所属项目】${domain.project_id}`,
    `【限界上下文】${domain.name}（${domain.id}）${domain.brief ? `｜${domain.brief}` : ''}`,
    `【通用语言】${(domain.ubiquitous_language || []).join('、') || '（无）'}`,
  ]
  if (kind === 'model') {
    lines.push(
      `【领域元素】Model ${element.name}（${element.id}）`,
      `【模型角色】${element.type}`,
      `【模型类型】${element.kind}`,
      `【职责】${element.description || '（未填写）'}`,
      `【属性】${JSON.stringify(element.attributes || [])}`,
      `【不变量】${(element.invariants || []).join('；') || '（无）'}`,
      `【关系】${JSON.stringify(element.relations || [])}`,
    )
  } else if (kind === 'stub') {
    lines.push(
      `【领域元素】Stub ${element.name}（${element.id}）`,
      `【服务类型】${element.kind}`,
      `【职责】${element.description || '（未填写）'}`,
      `【操作契约】${JSON.stringify(element.operations || [])}`,
    )
  } else {
    const modelName = id => (domain.models || []).find(item => item.id === id)?.name || id
    const requestNames = (element.request_model_ids || []).map(modelName)
    const responseNames = (element.response_model_ids || []).map(modelName)
    const stubNames = (element.stub_ids || []).map(id => (domain.stubs || []).find(item => item.id === id)?.name || id)
    lines.push(
      `【领域元素】Interact ${element.name}（${element.id}）`,
      `【交互类型】${element.kind}`,
      `【Actor】${(element.actors || []).join('、') || '（未填写）'}`,
      `【请求模型】${requestNames.join('、') || '（无）'}`,
      `【响应模型】${responseNames.join('、') || '（无）'}`,
      `【涉及服务】${stubNames.join('、') || '（无）'}`,
      `【前置条件】${(element.preconditions || []).join('；') || '（无）'}`,
      `【后置条件】${(element.postconditions || []).join('；') || '（无）'}`,
      `【主流程】${(element.main_flow || []).join(' → ') || '（未填写）'}`,
      `【扩展/异常】${(element.alternatives || []).join('；') || '（无）'}`,
    )
  }
  lines.push(
    '',
    '【实现约束】',
    '- 本元素只允许一个根 matrix；',
    '- 若元素包含多个子流程，必须在该根 matrix 的骨架 DAG 中用 group 节点拆分，由预构建创建子 matrix；不要创建额外根 matrix；',
    '- 先完成需求分析，再生成骨架 DAG。',
  )
  return lines.join('\n')
}

/** 为领域元素创建唯一根 matrix（1:1）。 */
export async function domainMatrixIntake(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const domain = requireDomain(dataDir, domainId)
  const project = requireProject(dataDir, domain.project_id)
  if (domain.state === DOMAIN_STATES.ARCHIVED) throw new Error('领域已归档，不能创建实现 matrix')
  const kind = String(args.kind || '').trim()
  if (!KIND_NORMALIZER[kind]) throw new Error('kind 只能是 model / stub / interact')
  const element = elementOf(domain, kind, args)
  if (!element) throw new Error(`${kind} 不存在：${args.element_id || args.id || args.name || ''}`)
  validateElement(domain, kind, element)
  if (element.matrix_id) throw new Error(`${kind} ${element.name} 已有根 matrix：${element.matrix_id}（一个元素只允许一个根 matrix）`)
  domain.cwd = domain.cwd || domainWorkDir(dataDir, domain)
  await ensureProjectSession(project, { ...dependencies, dataDir })
  saveProject(dataDir, project)
  await ensureDomainSession(domain, project, { ...dependencies, dataDir })
  saveDomain(dataDir, domain)

  const binding = { domain_id: domain.id, element_type: kind, element_id: element.id }
  const created = await intake({
    data_dir: args.data_dir,
    task: describeElement(domain, kind, element),
    name: `${domain.name} · ${element.name}`,
    project_id: domain.project_id,
    domain_binding: binding,
  }, dependencies)
  // intake 返回详情；再回填领域元素的 matrix_id
  const updated = await updateDomain(dataDir, domainId, current => {
    const target = elementOf(current, kind, { element_id: element.id })
    if (target) target.matrix_id = created.id
    archiveEntry(current, {
      type: 'event',
      source: 'domain',
      text: `为 ${kind} ${element.name} 创建根 matrix ${created.id}`,
      data: { kind, element_id: element.id, matrix_id: created.id },
    })
  })
  await logDomainOperation(dataDir, project, updated, {
    action: 'domain_matrix_intake',
    targetType: 'domain_element',
    targetId: element.id,
    targetName: element.name,
    detail: { kind, matrix_id: created.id },
  })
  await autoCheckpoint(dataDir, domain.project_id, `领域元素 ${element.name} 创建 matrix`, dependencies)
  const view = await detailOf(dataDir, domainId, dependencies)
  return { ...view, created_matrix_id: created.id }
}

/** 把已有的未绑定根 matrix 挂到领域元素。 */
export async function domainBindMatrix(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const domain = requireDomain(dataDir, domainId)
  const project = requireProject(dataDir, domain.project_id)
  const kind = String(args.kind || '').trim()
  if (!KIND_NORMALIZER[kind]) throw new Error('kind 只能是 model / stub / interact')
  const element = elementOf(domain, kind, args)
  if (!element) throw new Error(`${kind} 不存在：${args.element_id || args.id || args.name || ''}`)
  validateElement(domain, kind, element)
  if (element.matrix_id) throw new Error(`${kind} ${element.name} 已有根 matrix：${element.matrix_id}`)
  const matrixId = String(args.matrix_id || '').trim()
  if (!matrixId) throw new Error('matrix_id 不能为空')
  const matrix = loadMatrix(dataDir, matrixId)
  if (matrix.parent_id) throw new Error('只能绑定根 matrix')
  if (matrix.project_id !== domain.project_id) throw new Error('matrix 不属于该领域所在项目')
  if (matrix.domain_binding) throw new Error(`matrix 已绑定领域 ${matrix.domain_binding.domain_id}`)
  matrix.domain_binding = { domain_id: domain.id, element_type: kind, element_id: element.id }
  saveMatrix(dataDir, matrix)
  const updated = await updateDomain(dataDir, domainId, current => {
    const target = elementOf(current, kind, { element_id: element.id })
    if (target) target.matrix_id = matrix.id
    archiveEntry(current, {
      type: 'event',
      source: 'domain',
      text: `绑定根 matrix ${matrix.id} 到 ${kind} ${element.name}`,
      data: { kind, element_id: element.id, matrix_id: matrix.id },
    })
  })
  if (!project.root_matrix_ids.includes(matrix.id)) {
    await updateProject(dataDir, project.id, current => {
      current.root_matrix_ids = [...current.root_matrix_ids, matrix.id]
    })
  }
  await logDomainOperation(dataDir, project, updated, {
    action: 'domain_bind_matrix',
    targetType: 'domain_element',
    targetId: element.id,
    targetName: element.name,
    detail: { kind, matrix_id: matrix.id },
  })
  await autoCheckpoint(dataDir, domain.project_id, `绑定 domain matrix`, dependencies)
  return detailOf(dataDir, domainId, dependencies)
}

export function domainSummary(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domain = requireDomain(dataDir, domainIdOf(args, context))
  const view = domainView(dataDir, domain)
  const rows = [...view.models, ...view.stubs, ...view.interacts]
  const implemented = rows.filter(row => row.matrix)
  const byState = {}
  for (const row of implemented) {
    const state = row.matrix.missing ? 'missing' : row.matrix.state
    byState[state] = (byState[state] || 0) + 1
  }
  return {
    domain_id: domain.id,
    name: domain.name,
    state: domain.state,
    coverage: view.coverage,
    implemented: implemented.length,
    total: rows.length,
    matrix_states: byState,
    matrices: implemented.map(row => ({ element_type: row.kind, element_id: row.id, element_name: row.name, matrix: row.matrix })),
  }
}

/** 领域会话输入：写领域归档后交给项目会话下的领域 agent。 */
export async function domainChat(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const text = String(args.text || '').trim()
  if (!text) throw new Error('text 不能为空')
  const domain = requireDomain(dataDir, domainId)
  const project = requireProject(dataDir, domain.project_id)
  domain.cwd = domain.cwd || domainWorkDir(dataDir, domain)
  await ensureProjectSession(project, { ...dependencies, dataDir })
  saveProject(dataDir, project)
  await ensureDomainSession(domain, project, { ...dependencies, dataDir })
  chatMessage(domain, 'user', text, { source: 'panel' })
  archiveEntry(domain, { type: 'action', source: 'panel', text: 'chat', data: { text } })
  writeDomainMemoryFile(domain)
  saveDomain(dataDir, domain)
  if (domain.dsh_session_id && typeof dependencies.matrixChat === 'function') {
    const delivery = await dependencies.matrixChat({
      sessionId: domain.dsh_session_id,
      matrixId: domain.id,
      text,
      dataDir,
      cwd: project.cwd || projectWorkDir(dataDir, project.id),
      title: domain.name,
      task: domain.brief,
      brief: domainBrief(domain, project),
    })
    if (delivery && delivery.recreated) {
      await updateDomain(dataDir, domainId, current => { current.dsh_event_seq = 0 })
    }
  }
  return detailOf(dataDir, domainId, dependencies)
}

export async function domainEnsureSession(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const domain = requireDomain(dataDir, domainId)
  const project = requireProject(dataDir, domain.project_id)
  await ensureProjectSession(project, { ...dependencies, dataDir })
  saveProject(dataDir, project)
  await ensureDomainSession(domain, project, { ...dependencies, dataDir })
  saveDomain(dataDir, domain)
  return { domain_id: domain.id, dsh_session_id: domain.dsh_session_id, parent_session_id: domain.parent_session_id, cwd: project.cwd }
}

/** 元素矩阵的 runnable 汇总，供面板概览。 */
export function domainRunnable(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domain = requireDomain(dataDir, domainIdOf(args, context))
  const matrices = loadAll(dataDir)
  const view = domainView(dataDir, domain)
  return {
    domain_id: domain.id,
    runnable: [...view.models, ...view.stubs, ...view.interacts]
      .filter(row => row.matrix && !row.matrix.missing && row.matrix.runnable)
      .map(row => ({ element_type: row.kind, element_id: row.id, element_name: row.name, matrix_id: row.matrix.id })),
  }
}

/** 导出领域能力：只包含 request/response model 与 stub，包不可变。 */
export async function domainExportCreate(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  let pkg = null
  const domain = await updateDomain(dataDir, domainId, current => {
    ensureDomainShape(current)
    const version = nextVersionOf(dataDir, current.id, current.exports)
    pkg = buildExportPackage({
      domain: current,
      version,
      name: args.name === undefined ? null : args.name,
      summary: args.summary === undefined ? null : args.summary,
    })
    saveExport(dataDir, pkg)
    current.exports = [...(current.exports || []), {
      id: pkg.export_id,
      version: pkg.version,
      name: pkg.name,
      created_at: pkg.created_at,
      model_ids: pkg.models.map(model => model.id),
      stub_ids: pkg.stubs.map(stub => stub.id),
    }]
  })
  await logDomainOperation(dataDir, requireProject(dataDir, domain.project_id), domain, {
    action: 'domain_export_create',
    targetType: 'domain_export',
    targetId: pkg.export_id,
    targetName: pkg.name,
    detail: { version: pkg.version, models: pkg.models.length, stubs: pkg.stubs.length },
  })
  await autoCheckpoint(dataDir, domain.project_id, `导出领域能力 ${pkg.name}`, dependencies)
  return { ...(await detailOf(dataDir, domainId, dependencies)), export: pkg }
}

/** 列出该领域的导出包（按版本倒序）。 */
export function domainExportList(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domain = requireDomain(dataDir, domainIdOf(args, context))
  return { domain_id: domain.id, exports: listExports(dataDir, { domainId: domain.id, limit: 200 }) }
}

/** 读取导出包详情。 */
export function domainExportGet(args = {}) {
  const dataDir = dataDirOf(args)
  const exportId = String(args.export_id || '').trim()
  if (!exportId) throw new Error('export_id 不能为空')
  return loadExport(dataDir, exportId)
}

/** 导入能力：生成本地只读 model/stub 副本，并记录 provider 映射与版本锁定。 */
export async function domainImportApply(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const exportId = String(args.export_id || '').trim()
  if (!exportId) throw new Error('export_id 不能为空')
  const pkg = loadExport(dataDir, exportId)
  let record = null
  const domain = await updateDomain(dataDir, domainId, current => {
    ensureDomainShape(current)
    record = applyImportToDomain(current, pkg)
  })
  await logDomainOperation(dataDir, requireProject(dataDir, domain.project_id), domain, {
    action: 'domain_import_apply',
    targetType: 'domain_import',
    targetId: record.id,
    targetName: pkg.name,
    detail: { export_id: exportId, provider_domain_id: pkg.domain_id, version: pkg.version },
  })
  await autoCheckpoint(dataDir, domain.project_id, `导入领域能力 ${pkg.name}`, dependencies)
  return { ...(await detailOf(dataDir, domainId, dependencies)), imported: record }
}

/** 列出当前领域的导入记录。 */
export function domainImportList(args = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domain = requireDomain(dataDir, domainIdOf(args, context))
  return { domain_id: domain.id, imports: domain.imports || [] }
}

/** 移除导入：被本地引用或已有适配矩阵时拒绝。 */
export async function domainImportRemove(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const importId = String(args.import_id || args.id || args.export_id || '').trim()
  if (!importId) throw new Error('import_id 不能为空')
  let record = null
  const domain = await updateDomain(dataDir, domainId, current => {
    ensureDomainShape(current)
    record = removeImportFromDomain(current, importId)
  })
  await logDomainOperation(dataDir, requireProject(dataDir, domain.project_id), domain, {
    action: 'domain_import_remove',
    targetType: 'domain_import',
    targetId: record.id,
    targetName: record.export_id,
    detail: { export_id: record.export_id, version: record.version },
  })
  await autoCheckpoint(dataDir, domain.project_id, `移除导入能力 ${record.export_id}`, dependencies)
  return { ...(await detailOf(dataDir, domainId, dependencies)), removed_import: record }
}

/** 升级导入：保留本地 id 与适配矩阵，并返回契约差异。 */
export async function domainImportUpgrade(args = {}, dependencies = {}, context = {}) {
  const dataDir = dataDirOf(args)
  const domainId = domainIdOf(args, context)
  const importId = String(args.import_id || args.id || '').trim()
  if (!importId) throw new Error('import_id 不能为空')
  const domain = requireDomain(dataDir, domainId)
  const record = (domain.imports || []).find(item => item.id === importId || item.export_id === importId)
  if (!record) throw new Error(`导入记录不存在：${importId}`)
  const oldPkg = loadExport(dataDir, record.export_id)
  const newPkg = args.export_id
    ? loadExport(dataDir, String(args.export_id))
    : latestExportForDomain(dataDir, record.provider_domain_id)
  let diff = null
  const updated = await updateDomain(dataDir, domainId, current => {
    ensureDomainShape(current)
    diff = upgradeImportInDomain(current, oldPkg, newPkg, record.id)
  })
  await logDomainOperation(dataDir, requireProject(dataDir, updated.project_id), updated, {
    action: 'domain_import_upgrade',
    targetType: 'domain_import',
    targetId: record.id,
    targetName: newPkg.name,
    detail: { export_id: newPkg.export_id, version_from: diff.version_from, version_to: diff.version_to },
  })
  await autoCheckpoint(dataDir, updated.project_id, `升级导入能力 ${newPkg.name} v${newPkg.version}`, dependencies)
  return { ...(await detailOf(dataDir, domainId, dependencies)), upgrade_diff: diff }
}
