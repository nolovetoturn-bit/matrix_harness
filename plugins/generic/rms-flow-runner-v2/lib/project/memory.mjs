import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 200
const now = () => new Date().toISOString()
const clip = (value, limit) => String(value ?? '').trim().slice(0, limit)

const newEntryId = () => `mem-${randomBytes(5).toString('hex')}`

function ensureMemory(project) {
  if (!project.memory || typeof project.memory !== 'object') project.memory = { entries: [], updated_at: now() }
  if (!Array.isArray(project.memory.entries)) project.memory.entries = []
  return project.memory
}

export function memoryEntries(project) {
  return ensureMemory(project).entries
}

export function addMemoryEntry(project, { text, tags = [] } = {}) {
  const body = clip(text, 4000)
  if (!body) throw new Error('记忆内容不能为空')
  const memory = ensureMemory(project)
  const entry = {
    id: newEntryId(),
    text: body,
    tags: Array.isArray(tags) ? tags.map(tag => clip(tag, 40)).filter(Boolean).slice(0, 8) : [],
    created_at: now(),
    updated_at: now(),
  }
  memory.entries = [...memory.entries, entry].slice(-MAX_ENTRIES)
  memory.updated_at = now()
  return entry
}

export function updateMemoryEntry(project, { id, text } = {}) {
  const body = clip(text, 4000)
  if (!body) throw new Error('记忆内容不能为空')
  const memory = ensureMemory(project)
  const entry = memory.entries.find(item => item.id === id)
  if (!entry) throw new Error(`记忆不存在：${id}`)
  entry.text = body
  entry.updated_at = now()
  memory.updated_at = now()
  return entry
}

export function removeMemoryEntry(project, id) {
  const memory = ensureMemory(project)
  const before = memory.entries.length
  memory.entries = memory.entries.filter(item => item.id !== id)
  if (memory.entries.length === before) throw new Error(`记忆不存在：${id}`)
  memory.updated_at = now()
  return memory.entries
}

/** 项目记忆以结构化条目为准，同时落一份 PROJECT_MEMORY.md 供项目会话里的 agent 读取。 */
export function memoryMarkdown(project) {
  const entries = memoryEntries(project)
  const lines = [
    `# 项目记忆 · ${project.name}`,
    '',
    `> 由 rms-flow-runner 维护；更新于 ${project.memory.updated_at || project.updated_at}`,
    '',
  ]
  if (!entries.length) lines.push('（暂无项目记忆）')
  for (const entry of entries) {
    lines.push(`## ${entry.id}`)
    lines.push(entry.text)
    if (entry.tags && entry.tags.length) lines.push(`标签：${entry.tags.join('、')}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function writeMemoryFile(project) {
  const dir = project.cwd
  if (!dir) return null
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'PROJECT_MEMORY.md')
    writeFileSync(file, memoryMarkdown(project), 'utf8')
    return file
  } catch {
    return null
  }
}
