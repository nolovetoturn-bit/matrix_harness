/**
 * 领域能力注册表：不可变导出包放 <dataDir>/registry/domain-exports/，
 * 供跨项目检索与导入。导出包只包含 request/response model 与 stub 契约。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EXPORT_FILE = /^exp_[A-Za-z0-9_-]+\.json$/
const now = () => new Date().toISOString()

export const newExportId = version => `exp_${randomBytes(6).toString('hex')}_v${version}`

export function registryExportDir(dataDir) {
  return join(dataDir, 'registry', 'domain-exports')
}

export function exportFile(dataDir, exportId) {
  const id = String(exportId || '')
  if (!EXPORT_FILE.test(`${id}.json`)) throw new Error(`export_id 格式不正确：${exportId}`)
  return join(registryExportDir(dataDir), `${id}.json`)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

function checksumPayload(pkg) {
  return {
    domain_id: pkg.domain_id,
    version: pkg.version,
    name: pkg.name,
    summary: pkg.summary,
    models: pkg.models || [],
    stubs: pkg.stubs || [],
  }
}

export function checksumOf(pkg) {
  return createHash('sha256').update(JSON.stringify(canonical(checksumPayload(pkg)))).digest('hex')
}

export function assertValidExport(pkg) {
  if (!pkg || typeof pkg !== 'object') throw new Error('导出包必须是对象')
  if (!pkg.export_id || !pkg.domain_id || !Number.isInteger(pkg.version) || pkg.version < 1) {
    throw new Error('导出包缺少 export_id / domain_id / version')
  }
  if (checksumOf(pkg) !== pkg.checksum) throw new Error(`导出包校验失败：${pkg.export_id}`)
  return pkg
}

/** 生成不可变导出包：persistence model、interact、matrix 定义与运行数据一律不导出。 */
export function buildExportPackage({ domain, version, name = null, summary = null }) {
  const exportedModels = (domain.models || [])
    .filter(model => !model.readonly && (model.type === 'request' || model.type === 'response'))
  const exportedIds = new Set(exportedModels.map(model => model.id))
  const models = exportedModels.map(model => ({
    id: model.id,
    name: model.name,
    type: model.type,
    kind: 'dto',
    description: model.description || '',
    attributes: structuredClone(model.attributes || []),
    invariants: structuredClone(model.invariants || []),
    relations: (model.relations || [])
      .filter(relation => relation.target_model_id && exportedIds.has(relation.target_model_id))
      .map(relation => structuredClone(relation)),
  }))
  const stubs = (domain.stubs || [])
    .filter(stub => !stub.readonly)
    .map(stub => ({
      id: stub.id,
      name: stub.name,
      kind: stub.kind,
      description: stub.description || '',
      operations: (stub.operations || []).map(operation => ({
        name: operation.name,
        description: operation.description || '',
        request_model_ids: (operation.request_model_ids || []).filter(id => exportedIds.has(id)),
        response_model_ids: (operation.response_model_ids || []).filter(id => exportedIds.has(id)),
      })),
    }))
  const packageId = newExportId(version)
  const pkg = {
    export_id: packageId,
    domain_id: domain.id,
    version,
    name: String(name || domain.name).trim().slice(0, 120) || domain.name,
    summary: String(summary === null || summary === undefined ? domain.brief || '' : summary).trim().slice(0, 4000),
    models,
    stubs,
    created_at: now(),
  }
  return { ...pkg, checksum: checksumOf(pkg) }
}

export function saveExport(dataDir, pkg) {
  assertValidExport(pkg)
  const dir = registryExportDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const file = exportFile(dataDir, pkg.export_id)
  if (existsSync(file)) throw new Error(`导出包已存在且不可覆盖：${pkg.export_id}`)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return pkg
}

export function loadExport(dataDir, exportId) {
  const file = exportFile(dataDir, exportId)
  if (!existsSync(file)) throw new Error(`导出包不存在：${exportId}`)
  const pkg = assertValidExport(JSON.parse(readFileSync(file, 'utf8')))
  return pkg
}

export function listExports(dataDir, { domainId = null, query = '', limit = 50 } = {}) {
  const dir = registryExportDir(dataDir)
  if (!existsSync(dir)) return []
  const keyword = String(query || '').trim().toLowerCase()
  const rows = []
  for (const name of readdirSync(dir)) {
    if (!EXPORT_FILE.test(name)) continue
    try {
      const pkg = assertValidExport(JSON.parse(readFileSync(join(dir, name), 'utf8')))
      if (domainId && pkg.domain_id !== domainId) continue
      if (keyword) {
        const haystack = [
          pkg.name,
          pkg.summary,
          ...(pkg.models || []).map(model => model.name),
          ...(pkg.stubs || []).map(stub => stub.name),
        ].join(' ').toLowerCase()
        if (!haystack.includes(keyword)) continue
      }
      rows.push(pkg)
    } catch {}
  }
  rows.sort((a, b) => a.domain_id === b.domain_id
    ? b.version - a.version
    : String(b.created_at).localeCompare(String(a.created_at)))
  return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map(pkg => ({
    export_id: pkg.export_id,
    domain_id: pkg.domain_id,
    version: pkg.version,
    name: pkg.name,
    summary: pkg.summary,
    model_count: (pkg.models || []).length,
    stub_count: (pkg.stubs || []).length,
    checksum: pkg.checksum,
    created_at: pkg.created_at,
  }))
}

export function latestExportForDomain(dataDir, domainId, exportId = null) {
  if (exportId) {
    const pkg = loadExport(dataDir, exportId)
    if (pkg.domain_id !== domainId) throw new Error('导出包不属于该领域')
    return pkg
  }
  const rows = listExports(dataDir, { domainId, limit: 200 })
  if (!rows.length) throw new Error(`没有可升级的导出包：${domainId}`)
  return loadExport(dataDir, rows[0].export_id)
}

export function nextVersionOf(dataDir, domainId, declared = []) {
  const registryVersions = listExports(dataDir, { domainId, limit: 200 }).map(row => row.version)
  const declaredVersions = (declared || []).map(item => Number(item.version) || 0)
  return Math.max(0, ...registryVersions, ...declaredVersions) + 1
}

/** 供面板/宿主复制导出包副本，避免直接暴露文件路径。 */
export function exportPackagesOf(dataDir, domain) {
  return ((domain && domain.exports) || [])
    .map(item => {
      try { return loadExport(dataDir, item.id) } catch { return null }
    })
    .filter(Boolean)
}
