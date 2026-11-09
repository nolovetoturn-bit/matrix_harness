/**
 * 只读能力注册表访问层：读取 <dataDir>/registry/domain-exports 下的不可变导出包。
 * 本插件不提供任何写入入口，所有 checksum 校验在读取时完成。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const EXPORT_FILE = /^exp_[A-Za-z0-9_-]+\.json$/

export function resolveDataDir(value) {
  const configured = String(value || process.env.RMS_MATRIX_DATA_DIR || '').trim()
  if (configured) return resolve(configured)
  const base = process.env.LOCALAPPDATA || homedir()
  return join(base, 'rms-flow-runner', 'matrix')
}

export function registryExportDir(dataDir) {
  return join(resolveDataDir(dataDir), 'registry', 'domain-exports')
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

export function checksumOf(pkg) {
  const payload = {
    domain_id: pkg.domain_id,
    version: pkg.version,
    name: pkg.name,
    summary: pkg.summary,
    models: pkg.models || [],
    stubs: pkg.stubs || [],
  }
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')
}

export function assertValidPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') throw new Error('导出包必须是对象')
  if (!pkg.export_id || !pkg.domain_id || !Number.isInteger(pkg.version) || pkg.version < 1) {
    throw new Error('导出包缺少 export_id / domain_id / version')
  }
  if (checksumOf(pkg) !== pkg.checksum) throw new Error(`导出包校验失败：${pkg.export_id}`)
  return pkg
}

export function loadPackage(dataDir, exportId) {
  const id = String(exportId || '').trim()
  if (!EXPORT_FILE.test(`${id}.json`)) throw new Error(`export_id 格式不正确：${exportId}`)
  const file = join(registryExportDir(dataDir), `${id}.json`)
  if (!existsSync(file)) throw new Error(`导出包不存在：${id}`)
  return assertValidPackage(JSON.parse(readFileSync(file, 'utf8')))
}

/** 读取全部导出包；坏包跳过，避免一个损坏文件影响检索。 */
export function listPackages(dataDir, { query = '', domainId = null, limit = 200 } = {}) {
  const dir = registryExportDir(dataDir)
  if (!existsSync(dir)) return []
  const keyword = String(query || '').trim().toLowerCase()
  const rows = []
  for (const name of readdirSync(dir)) {
    if (!EXPORT_FILE.test(name)) continue
    try {
      const pkg = assertValidPackage(JSON.parse(readFileSync(join(dir, name), 'utf8')))
      if (domainId && pkg.domain_id !== domainId) continue
      if (keyword) {
        const haystack = [
          pkg.name,
          pkg.summary,
          ...(pkg.models || []).map(model => model.name),
          ...(pkg.stubs || []).flatMap(stub => [stub.name, ...(stub.operations || []).map(operation => operation.name)]),
        ].join(' ').toLowerCase()
        if (!haystack.includes(keyword)) continue
      }
      rows.push(pkg)
    } catch {}
  }
  rows.sort((a, b) => a.domain_id === b.domain_id
    ? b.version - a.version
    : String(b.created_at).localeCompare(String(a.created_at)))
  return rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 200)))
}

export function summarizePackage(pkg) {
  return {
    export_id: pkg.export_id,
    domain_id: pkg.domain_id,
    version: pkg.version,
    name: pkg.name,
    summary: pkg.summary,
    model_count: (pkg.models || []).length,
    stub_count: (pkg.stubs || []).length,
    checksum: pkg.checksum,
    created_at: pkg.created_at,
  }
}
