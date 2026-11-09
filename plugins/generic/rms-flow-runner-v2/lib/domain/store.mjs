import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { assertDomainId, DOMAIN_STATES, MODEL_TYPES, PERSISTENCE_MODEL_KINDS } from './schema.mjs'

const DOMAIN_FILE = /^domain-(dom_[A-Za-z0-9_-]+)\.json$/

const now = () => new Date().toISOString()

const ensureDir = path => {
  mkdirSync(path, { recursive: true })
  return path
}

export const domainFile = (dataDir, id) => {
  assertDomainId(id)
  return join(dataDir, `domain-${id}.json`)
}

/** 领域工作区放在项目目录内，随项目 Git 仓库一起版本化。 */
export function domainWorkDir(dataDir, domain) {
  assertDomainId(domain.id)
  return join(dataDir, 'projects', domain.project_id, 'domains', domain.id, 'work')
}

/** 兼容旧文件：补齐会话游标、记忆、元素数组等结构。 */
export function ensureDomainShape(domain) {
  if (!domain || typeof domain !== 'object') return domain
  if (!Array.isArray(domain.ubiquitous_language)) domain.ubiquitous_language = []
  if (!Array.isArray(domain.models)) domain.models = []
  if (!Array.isArray(domain.stubs)) domain.stubs = []
  if (!Array.isArray(domain.interacts)) domain.interacts = []
  if (!Array.isArray(domain.exports)) domain.exports = []
  if (!Array.isArray(domain.imports)) domain.imports = []
  for (const model of domain.models) {
    if (!MODEL_TYPES.includes(model.type)) model.type = 'persistence'
    if (model.type !== 'persistence') model.kind = 'dto'
    else if (model.kind === 'aggregate' || !PERSISTENCE_MODEL_KINDS.includes(model.kind)) model.kind = 'entity'
  }
  for (const stub of domain.stubs) {
    if (!Array.isArray(stub.operations)) stub.operations = []
    for (const operation of stub.operations) {
      if (!Array.isArray(operation.request_model_ids)) operation.request_model_ids = []
      if (!Array.isArray(operation.response_model_ids)) operation.response_model_ids = []
    }
  }
  for (const interact of domain.interacts) {
    if (!Array.isArray(interact.request_model_ids)) {
      interact.request_model_ids = Array.isArray(interact.model_ids) ? interact.model_ids : []
    }
    if (!Array.isArray(interact.response_model_ids)) interact.response_model_ids = []
    delete interact.model_ids
  }
  if (!Array.isArray(domain.messages)) domain.messages = []
  if (!Array.isArray(domain.archive)) domain.archive = []
  if (!domain.memory || typeof domain.memory !== 'object') domain.memory = { entries: [], updated_at: now() }
  if (!Array.isArray(domain.memory.entries)) domain.memory.entries = []
  if (!Number.isInteger(domain.dsh_event_seq)) domain.dsh_event_seq = 0
  if (!Number.isInteger(domain.dsh_mirror_seq)) domain.dsh_mirror_seq = 0
  if (!Number.isInteger(domain.message_seq)) domain.message_seq = 0
  if (!Number.isInteger(domain.archive_seq)) domain.archive_seq = 0
  if (!domain.state) domain.state = DOMAIN_STATES.ACTIVE
  return domain
}

function atomicWrite(file, value) {
  ensureDir(join(file, '..'))
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return value
}

export function saveDomain(dataDir, domain) {
  domain.updated_at = now()
  return atomicWrite(domainFile(dataDir, domain.id), domain)
}

export function loadDomain(dataDir, id) {
  const file = domainFile(dataDir, id)
  if (!existsSync(file)) throw new Error(`领域不存在：${id}`)
  return ensureDomainShape(JSON.parse(readFileSync(file, 'utf8')))
}

export const domainExists = (dataDir, id) => existsSync(domainFile(dataDir, id))

export function listDomains(dataDir) {
  if (!existsSync(dataDir)) return []
  const rows = []
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !DOMAIN_FILE.test(entry.name)) continue
    try {
      rows.push(ensureDomainShape(JSON.parse(readFileSync(join(dataDir, entry.name), 'utf8'))))
    } catch {}
  }
  return rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function withFileLock(dataDir, key, label, operation) {
  const lockDir = ensureDir(join(dataDir, '.locks'))
  const lockFile = join(lockDir, `${key}.lock`)
  const deadline = Date.now() + Number(process.env.RMS_MATRIX_LOCK_WAIT_MS || 5000)
  let acquired = false
  while (!acquired) {
    try {
      const fd = openSync(lockFile, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: now() }), 'utf8')
      closeSync(fd)
      acquired = true
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      let stale = false
      try {
        stale = !processAlive(Number(JSON.parse(readFileSync(lockFile, 'utf8')).pid))
      } catch {}
      if (stale) {
        try { unlinkSync(lockFile) } catch {}
        continue
      }
      if (Date.now() >= deadline) throw new Error(`${label} 正在另一个进程中推进，请稍后重试`)
      await sleep(25)
    }
  }
  try {
    return await operation()
  } finally {
    if (existsSync(lockFile)) unlinkSync(lockFile)
  }
}

export function withDomainLock(dataDir, domainId, operation) {
  assertDomainId(domainId)
  return withFileLock(dataDir, `domain-${domainId}`, `领域 ${domainId}`, operation)
}

export async function updateDomain(dataDir, domainId, mutator) {
  return withDomainLock(dataDir, domainId, async () => {
    const domain = loadDomain(dataDir, domainId)
    const result = await mutator(domain)
    saveDomain(dataDir, domain)
    return result === undefined ? domain : result
  })
}
