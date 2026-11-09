import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 200
const now = () => new Date().toISOString()
const clip = (value, limit) => String(value ?? '').trim().slice(0, limit)

function ensureMemory(domain) {
  if (!domain.memory || typeof domain.memory !== 'object') domain.memory = { entries: [], updated_at: now() }
  if (!Array.isArray(domain.memory.entries)) domain.memory.entries = []
  return domain.memory
}

export function domainMemoryEntries(domain) {
  return ensureMemory(domain).entries
}

export function addDomainMemoryEntry(domain, { text, tags = [] } = {}) {
  const body = clip(text, 4000)
  if (!body) throw new Error('领域记忆内容不能为空')
  const memory = ensureMemory(domain)
  const entry = {
    id: `dmem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: body,
    tags: Array.isArray(tags) ? tags.map(tag => clip(tag, 40)).filter(Boolean).slice(0, 8) : [],
    created_at: now(),
    updated_at: now(),
  }
  memory.entries = [...memory.entries, entry].slice(-MAX_ENTRIES)
  memory.updated_at = now()
  return entry
}

export function updateDomainMemoryEntry(domain, { id, text } = {}) {
  const body = clip(text, 4000)
  if (!body) throw new Error('领域记忆内容不能为空')
  const memory = ensureMemory(domain)
  const entry = memory.entries.find(item => item.id === id)
  if (!entry) throw new Error(`领域记忆不存在：${id}`)
  entry.text = body
  entry.updated_at = now()
  memory.updated_at = now()
  return entry
}

export function removeDomainMemoryEntry(domain, id) {
  const memory = ensureMemory(domain)
  const before = memory.entries.length
  memory.entries = memory.entries.filter(item => item.id !== id)
  if (memory.entries.length === before) throw new Error(`领域记忆不存在：${id}`)
  memory.updated_at = now()
  return memory.entries
}

export function domainMemoryMarkdown(domain) {
  const entries = domainMemoryEntries(domain)
  const lines = [
    `# 领域记忆 · ${domain.name}`,
    '',
    `> 限界上下文：${domain.bounded_context || domain.name}`,
    `> 由 rms-flow-runner 维护；更新于 ${domain.memory.updated_at || domain.updated_at}`,
    '',
  ]
  if (!entries.length) lines.push('（暂无领域记忆）')
  for (const entry of entries) {
    lines.push(`## ${entry.id}`)
    lines.push(entry.text)
    if (entry.tags && entry.tags.length) lines.push(`标签：${entry.tags.join('、')}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function writeDomainMemoryFile(domain) {
  const dir = domain.cwd
  if (!dir) return null
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'DOMAIN_MEMORY.md')
    writeFileSync(file, domainMemoryMarkdown(domain), 'utf8')
    return file
  } catch {
    return null
  }
}
