/**
 * rms-worklog 存储核心：Markdown 条目为唯一真源，SQLite FTS5 为可重建索引。
 *
 * 设计约束（见 docs/dsh-plugin-spec.md §3）：
 *   - 零 npm 依赖：只用 node: 内置模块与相对路径导入；
 *   - 条目先原子落盘，再更新索引；索引损坏可用 reindex 从 Markdown 全量重建；
 *   - 中文检索用 FTS5 trigram（>=3 字），1-2 字回退 LIKE。
 *
 * @module rms-worklog/store
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const APP_NAME = 'rms-worklog'
const ENTRY_HEAD_RE = /^<!-- worklog (\{.*\}) -->$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HEADING_LINE_RE = /^(#{1,6})\s+(.*\S)\s*$/
const CHECKBOX_LINE_RE = /^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]\s+(\S.*)$/
const LIST_LINE_RE = /^(\s*)([-*+]|\d+\.)\s+(\S.*)$/
const TODO_SECTION_RE = /待办|下一步|todo|next steps?|action items?|未完成/i

/* ------------------------------------------------------------------ */
/* 配置与路径                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  data_dir: null,
  // 留空表示自动复用 dsh 的 DeepSeek 配置；显式填写则优先使用。
  llm_base_url: '',
  llm_model: '',
  llm_api_key: '',
  llm_timeout_ms: 60000,
  // auto 按 URL 判断：/anthropic 结尾走 Messages API，否则走 OpenAI 兼容。
  llm_protocol: 'auto',
}

const DSH_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'
const DSH_DEFAULT_MODEL = 'deepseek-flash'

export function appDir() {
  const base = process.env.LOCALAPPDATA || process.env.HOME || '.'
  const dir = join(base, APP_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function configPath() {
  return join(appDir(), 'config.json')
}

export function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'))
    if (raw && typeof raw === 'object') Object.assign(cfg, raw)
  } catch {
    /* 无配置或损坏时用默认值 */
  }
  return cfg
}

export function saveConfig(patch) {
  const cfg = { ...loadConfig() }
  if (patch && typeof patch === 'object') {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key in patch) cfg[key] = patch[key]
    }
  }
  mkdirSync(appDir(), { recursive: true })
  const tmp = `${configPath()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  renameSync(tmp, configPath())
  return cfg
}

function findGitRoot(start) {
  let dir = resolve(start || process.cwd())
  for (let i = 0; i < 24; i += 1) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/**
 * 数据目录解析顺序：环境变量 RMS_WORKLOG_DIR > config.data_dir > 当前 git 仓库的
 * docs/worklogs > %LOCALAPPDATA%\rms-worklog\data。
 * 环境变量优先级最高，方便测试与临时切换。
 */
export function resolveDataDir(cfg = loadConfig()) {
  const explicit = process.env.RMS_WORKLOG_DIR || cfg.data_dir
  if (explicit && String(explicit).trim()) return resolve(String(explicit).trim())
  const root = findGitRoot(process.cwd())
  if (root) return join(root, 'docs', 'worklogs')
  return join(appDir(), 'data')
}

export function indexDir(dataDir) {
  return join(dataDir, '.index')
}

/**
 * 读取 dsh 托管凭据（`$DSH_HOME/.credentials.yaml` 的 refs 段）。
 * 支持字面值、`env:NAME` 与 `file:path`；找不到时返回 null。
 */
function readDshCredential(name) {
  const dir = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(dir, '.credentials.yaml')
  if (!existsSync(file)) return null
  let inRefs = false
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(raw)) {
      inRefs = true
      continue
    }
    if (inRefs && /^\S/.test(raw)) break
    if (!inRefs) continue
    const match = raw.match(new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`))
    if (!match) continue
    const value = match[1].replace(/^["']|["']$/g, '')
    if (value.startsWith('env:')) return process.env[value.slice(4)] || null
    if (value.startsWith('file:')) {
      const path = value.slice(5)
      return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null
    }
    return value || null
  }
  return null
}

function resolveProtocol(baseUrl, value) {
  const explicit = String(value || 'auto').toLowerCase()
  if (explicit === 'anthropic' || explicit === 'openai') return explicit
  return /\/anthropic(\/|$)/i.test(baseUrl) ? 'anthropic' : 'openai'
}

/**
 * 解析 LLM 配置，优先级：环境变量 > worklog config > dsh 托管配置 > 本机 Ollama。
 *
 * dsh 复用规则：只要能从 `$DSH_HOME/.credentials.yaml` 读到 DEEPSEEK_API_KEY，
 * 且没有显式指向其它厂商的 base_url，就沿用 dsh 的 Messages 端点与默认模型。
 */
export function resolveLlmConfig(cfg = loadConfig()) {
  const env = process.env
  const explicitBase = String(env.RMS_WORKLOG_LLM_BASE_URL || cfg.llm_base_url || '')
    .trim().replace(/\/+$/, '')
  const dshKey = readDshCredential('DEEPSEEK_API_KEY')
  const isDeepseek = /^https:\/\/api\.deepseek\.com(\/|$)/i.test(explicitBase)
  const reuseDsh = Boolean(dshKey) && (!explicitBase || isDeepseek)
  const baseUrl = explicitBase || (reuseDsh ? DSH_DEFAULT_BASE_URL : 'http://127.0.0.1:11434/v1')
  const deepseekHost = /^https:\/\/api\.deepseek\.com(\/|$)/i.test(baseUrl)
  const model = String(
    env.RMS_WORKLOG_LLM_MODEL || cfg.llm_model || (deepseekHost ? DSH_DEFAULT_MODEL : ''),
  ).trim()
  const apiKey = String(
    env.RMS_WORKLOG_LLM_API_KEY || cfg.llm_api_key || (reuseDsh ? dshKey : ''),
  ).trim()
  const timeoutMs = Math.min(
    Math.max(Number(env.RMS_WORKLOG_LLM_TIMEOUT_MS || cfg.llm_timeout_ms) || 60000, 5000),
    600000,
  )
  return {
    base_url: baseUrl,
    model,
    api_key: apiKey,
    timeout_ms: timeoutMs,
    protocol: resolveProtocol(baseUrl, env.RMS_WORKLOG_LLM_PROTOCOL || cfg.llm_protocol),
    source: reuseDsh ? 'dsh' : (explicitBase ? 'config' : 'default'),
  }
}

function llmView(llm) {
  return {
    base_url: llm.base_url,
    model: llm.model || '(自动选择)',
    protocol: llm.protocol,
    source: llm.source,
    timeout_ms: llm.timeout_ms,
    api_key_set: Boolean(llm.api_key),
  }
}

export function indexPath(dataDir) {
  return join(indexDir(dataDir), 'worklog.db')
}

/* ------------------------------------------------------------------ */
/* 日期与文本工具                                                      */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0')
}

export function todayLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + delta)
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

function localIso() {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function normalizeList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，;；]/)
  const out = []
  for (const item of raw) {
    const text = String(item || '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

function cleanTitle(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function hashEntry(date, title, content) {
  return createHash('sha256').update(`${date}\n${title}\n${content}`, 'utf8').digest('hex')
}

function makeId() {
  const d = new Date()
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

export function entryPath(dataDir, date, id) {
  return join(dataDir, date.slice(0, 4), date.slice(5, 7), date, `${id}.md`)
}

function snippet(content, terms, max = 140) {
  const flat = String(content || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  for (const term of terms) {
    const i = flat.toLowerCase().indexOf(term.toLowerCase())
    if (i >= 0) {
      const start = Math.max(0, i - 40)
      const end = Math.min(flat.length, i + term.length + 80)
      return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
    }
  }
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, ch => `\\${ch}`)
}

function daysSince(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y || !m || !d) return 0
  const then = new Date(y, m - 1, d)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.max(0, Math.round((today - then) / 86400000))
}

/* ------------------------------------------------------------------ */
/* 待办提取                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从正文提取待办：
 *   - 任何位置的 Markdown 复选框 `- [ ]` / `- [x]`；
 *   - 「待办 / 下一步 / TODO / Next」小节下的普通列表项（无复选框，视为未完成）。
 * seq 从 1 开始，勾选条目也计数，保证文件未被编辑时 id 稳定。
 */
export function parseTodos(content) {
  const lines = String(content || '').split('\n')
  const todos = []
  let sectionLevel = 0
  let seq = 0
  lines.forEach((raw, i) => {
    const heading = raw.match(HEADING_LINE_RE)
    if (heading) {
      const level = heading[1].length
      if (TODO_SECTION_RE.test(heading[2])) sectionLevel = level
      else if (sectionLevel && level <= sectionLevel) sectionLevel = 0
      return
    }
    const box = raw.match(CHECKBOX_LINE_RE)
    if (box) {
      seq += 1
      todos.push({
        seq,
        text: box[4].trim(),
        done: box[3].toLowerCase() === 'x',
        line: i + 1,
        implicit: false,
      })
      return
    }
    if (sectionLevel) {
      const item = raw.match(LIST_LINE_RE)
      if (item) {
        seq += 1
        todos.push({ seq, text: item[3].trim(), done: false, line: i + 1, implicit: true })
      }
    }
  })
  return todos
}

/** 把第 seq 条待办改成已完成，返回新正文；找不到时返回 null。 */
function markTodoDone(content, seq) {
  const lines = String(content || '').split('\n')
  let sectionLevel = 0
  let cur = 0
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const heading = raw.match(HEADING_LINE_RE)
    if (heading) {
      const level = heading[1].length
      if (TODO_SECTION_RE.test(heading[2])) sectionLevel = level
      else if (sectionLevel && level <= sectionLevel) sectionLevel = 0
      continue
    }
    const box = raw.match(CHECKBOX_LINE_RE)
    if (box) {
      cur += 1
      if (cur === seq) {
        if (box[3].toLowerCase() === 'x') return { content, already: true, text: box[4].trim() }
        lines[i] = `${box[1]}${box[2]} [x] ${box[4]}`
        return { content: lines.join('\n'), already: false, text: box[4].trim() }
      }
      continue
    }
    if (sectionLevel) {
      const item = raw.match(LIST_LINE_RE)
      if (item) {
        cur += 1
        if (cur === seq) {
          lines[i] = `${item[1]}${item[2]} [x] ${item[3]}`
          return { content: lines.join('\n'), already: false, text: item[3].trim() }
        }
      }
    }
  }
  return null
}

function replaceTodos(db, entryId, content) {
  db.prepare('DELETE FROM entry_todos WHERE entry_id = ?').run(entryId)
  const insert = db.prepare(
    'INSERT INTO entry_todos (entry_id, seq, text, done, line, implicit) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const todo of parseTodos(content)) {
    insert.run(entryId, todo.seq, todo.text, todo.done ? 1 : 0, todo.line, todo.implicit ? 1 : 0)
  }
}

/* ------------------------------------------------------------------ */
/* 条目文件                                                            */
/* ------------------------------------------------------------------ */

function serializeEntry(meta, content) {
  // < 转义成 \u003c，避免正文/标题里的 "-->" 提前闭合 HTML 注释。
  const json = JSON.stringify(meta).replace(/</g, '\\u003c')
  return `<!-- worklog ${json} -->\n\n${content.trim()}\n`
}

export function parseEntryFile(path) {
  const raw = readFileSync(path, 'utf8')
  const nl = raw.indexOf('\n')
  const first = nl >= 0 ? raw.slice(0, nl) : raw
  const match = first.match(ENTRY_HEAD_RE)
  if (!match) return null
  const meta = JSON.parse(match[1])
  let content = nl >= 0 ? raw.slice(nl + 1) : ''
  content = content.replace(/^\s*\n/, '').trim()
  return { meta, content, path }
}

function writeEntryFile(path, meta, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, serializeEntry(meta, content), 'utf8')
  renameSync(tmp, path)
}

function walkMarkdown(root, out = []) {
  let items = []
  try {
    items = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    if (item.name.startsWith('.')) continue
    const full = join(root, item.name)
    if (item.isDirectory()) walkMarkdown(full, out)
    else if (item.isFile() && item.name.endsWith('.md')) out.push(full)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 数据库                                                              */
/* ------------------------------------------------------------------ */

function openDb(dataDir) {
  mkdirSync(indexDir(dataDir), { recursive: true })
  const db = new DatabaseSync(indexPath(dataDir))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT,
      title TEXT NOT NULL,
      project TEXT,
      kind TEXT,
      tags_json TEXT,
      people_json TEXT,
      source TEXT,
      hash TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project)')
  db.exec('CREATE TABLE IF NOT EXISTS entry_tags (entry_id TEXT NOT NULL, tag TEXT NOT NULL)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag)')
  db.exec('CREATE TABLE IF NOT EXISTS entry_people (entry_id TEXT NOT NULL, person TEXT NOT NULL)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_entry_people_person ON entry_people(person)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS entry_todos (
      entry_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL,
      line INTEGER NOT NULL,
      implicit INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (entry_id, seq)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_entry_todos_done ON entry_todos(done)')
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      id UNINDEXED, title, content, tags_text, tokenize='trigram'
    )
  `)
  return db
}

function insertRow(db, row) {
  db.prepare(
    `INSERT INTO entries
       (id, path, date, created_at, title, project, kind, tags_json, people_json, source, hash, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.path, row.date, row.created_at, row.title, row.project, row.kind,
    JSON.stringify(row.tags), JSON.stringify(row.people), row.source, row.hash, row.content,
  )
  db.prepare('DELETE FROM entry_tags WHERE entry_id = ?').run(row.id)
  db.prepare('DELETE FROM entry_people WHERE entry_id = ?').run(row.id)
  db.prepare('DELETE FROM entries_fts WHERE id = ?').run(row.id)
  const tagStmt = db.prepare('INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)')
  for (const tag of row.tags) tagStmt.run(row.id, tag)
  const personStmt = db.prepare('INSERT INTO entry_people (entry_id, person) VALUES (?, ?)')
  for (const person of row.people) personStmt.run(row.id, person)
  replaceTodos(db, row.id, row.content)
  db.prepare(
    'INSERT INTO entries_fts (id, title, content, tags_text) VALUES (?, ?, ?, ?)',
  ).run(row.id, row.title, row.content, row.tags.join(' '))
}

function rowToEntry(row) {
  return {
    id: row.id,
    path: row.path,
    date: row.date,
    created_at: row.created_at,
    title: row.title,
    project: row.project || '',
    kind: row.kind || '',
    tags: JSON.parse(row.tags_json || '[]'),
    people: JSON.parse(row.people_json || '[]'),
    source: row.source || '',
    content: row.content,
  }
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

export function addEntry(input = {}) {
  const dataDir = resolveDataDir()
  const title = cleanTitle(input.title)
  const content = String(input.content || '').trim()
  if (!title) throw new Error('缺少 title（日志标题）')
  if (!content) throw new Error('缺少 content（日志正文）')

  const date = DATE_RE.test(String(input.date || '').trim())
    ? String(input.date).trim()
    : todayLocal()
  const tags = normalizeList(input.tags)
  const people = normalizeList(input.people)
  const project = String(input.project || '').trim()
  const kind = String(input.kind || 'note').trim() || 'note'
  const source = String(input.source || '').trim()
  const hash = hashEntry(date, title, content)

  const db = openDb(dataDir)
  try {
    const existing = db.prepare('SELECT * FROM entries WHERE hash = ?').get(hash)
    if (existing && input.force !== true) {
      return { ...rowToEntry(existing), duplicate: true, indexed: true }
    }

    let id = makeId()
    let path = entryPath(dataDir, date, id)
    for (let i = 0; i < 5 && existsSync(path); i += 1) {
      id = makeId()
      path = entryPath(dataDir, date, id)
    }
    const meta = {
      id,
      date,
      created_at: localIso(),
      title,
      project,
      kind,
      tags,
      people,
      source,
    }

    writeEntryFile(path, meta, content)

    const row = {
      ...meta,
      path,
      hash,
      content,
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      insertRow(db, row)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (String(err && err.message).includes('UNIQUE')) {
        const again = db.prepare('SELECT * FROM entries WHERE hash = ?').get(hash)
        if (again) return { ...rowToEntry(again), duplicate: true, indexed: true }
      }
      throw err
    }
    return { ...rowToEntry(row), duplicate: false, indexed: true }
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ */
/* 检索                                                                */
/* ------------------------------------------------------------------ */

function splitTerms(query) {
  return String(query || '')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
}

function runSearch(db, { terms, from, to, tags, people, project, kind, limit }) {
  const longTerms = terms.filter(t => [...t].length >= 3)
  const shortTerms = terms.filter(t => [...t].length < 3)

  const where = []
  const params = []
  if (from) { where.push('e.date >= ?'); params.push(from) }
  if (to) { where.push('e.date <= ?'); params.push(to) }
  if (project) { where.push('e.project = ?'); params.push(project) }
  if (kind) { where.push('e.kind = ?'); params.push(kind) }
  for (const tag of tags) {
    where.push('EXISTS (SELECT 1 FROM entry_tags t WHERE t.entry_id = e.id AND t.tag = ?)')
    params.push(tag)
  }
  for (const person of people) {
    where.push('EXISTS (SELECT 1 FROM entry_people p WHERE p.entry_id = e.id AND p.person = ?)')
    params.push(person)
  }
  for (const term of shortTerms) {
    where.push("(e.title LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\')")
    const like = `%${escapeLike(term)}%`
    params.push(like, like)
  }

  const filterSql = where.length ? ` AND ${where.join(' AND ')}` : ''

  if (longTerms.length) {
    const fts = longTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ')
    const sql = `
      SELECT e.*, bm25(entries_fts, 0, 6.0, 1.0, 2.0) AS rank
      FROM entries_fts
      JOIN entries e ON e.id = entries_fts.id
      WHERE entries_fts MATCH ?${filterSql}
      ORDER BY rank, e.date DESC, e.created_at DESC
      LIMIT ?
    `
    const rows = db.prepare(sql).all(fts, ...params, limit)
    if (rows.length) return rows
    // FTS 无命中时退回 LIKE，覆盖分词/短词/特殊符号导致的漏检。
    return runLikeSearch(db, { terms, where, params, limit })
  }
  return runLikeSearch(db, { terms, where, params, limit })
}

function runLikeSearch(db, { terms, where, params, limit }) {
  const clauses = [...where]
  const values = [...params]
  for (const term of terms) {
    clauses.push("(e.title LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\')")
    const like = `%${escapeLike(term)}%`
    values.push(like, like)
  }
  const filter = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return db.prepare(
    `SELECT e.*, 0 AS rank FROM entries e ${filter}
     ORDER BY e.date DESC, e.created_at DESC LIMIT ?`,
  ).all(...values, limit)
}

export function searchEntries(input = {}) {
  const dataDir = resolveDataDir()
  const db = openDb(dataDir)
  try {
    const terms = splitTerms(input.query)
    const tags = normalizeList(input.tags)
    const people = normalizeList(input.people)
    const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50)
    const rows = runSearch(db, {
      terms,
      from: DATE_RE.test(String(input.from || '')) ? String(input.from) : '',
      to: DATE_RE.test(String(input.to || '')) ? String(input.to) : '',
      tags,
      people,
      project: String(input.project || '').trim(),
      kind: String(input.kind || '').trim(),
      limit,
    })
    return {
      total: rows.length,
      query: String(input.query || '').trim(),
      terms,
      items: rows.map(row => {
        const entry = rowToEntry(row)
        return {
          id: entry.id,
          date: entry.date,
          title: entry.title,
          project: entry.project,
          kind: entry.kind,
          tags: entry.tags,
          people: entry.people,
          path: entry.path,
          snippet: snippet(entry.content, terms),
        }
      }),
    }
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ */
/* 读取、最近、统计                                                    */
/* ------------------------------------------------------------------ */

export function getEntry(id, neighbors = 0) {
  const dataDir = resolveDataDir()
  const db = openDb(dataDir)
  try {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(String(id || ''))
    if (!row) return null
    const entry = rowToEntry(row)
    let content = entry.content
    let fromDisk = false
    try {
      const parsed = parseEntryFile(entry.path)
      if (parsed) {
        content = parsed.content
        fromDisk = true
      }
    } catch {
      /* 文件缺失时退回索引里的副本 */
    }
    let around = []
    const n = Math.min(Math.max(Number(neighbors) || 0, 0), 5)
    if (n > 0) {
      const rows = db.prepare(
        'SELECT id, date, title, created_at FROM entries WHERE date = ? ORDER BY created_at ASC',
      ).all(entry.date)
      const idx = rows.findIndex(r => r.id === entry.id)
      const from = Math.max(0, idx - n)
      const to = Math.min(rows.length, idx + n + 1)
      around = rows.slice(from, to).map(r => ({ id: r.id, date: r.date, title: r.title, current: r.id === entry.id }))
    }
    return { ...entry, content, from_disk: fromDisk, neighbors: around }
  } finally {
    db.close()
  }
}

export function recentEntries(input = {}) {
  const dataDir = resolveDataDir()
  const db = openDb(dataDir)
  try {
    const days = Math.min(Math.max(Number(input.days) || 7, 1), 365)
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100)
    const from = addDays(todayLocal(), -(days - 1))
    const project = String(input.project || '').trim()
    const sql = `SELECT id, date, title, project, kind, tags_json, created_at FROM entries
      WHERE date >= ?${project ? ' AND project = ?' : ''}
      ORDER BY date DESC, created_at DESC LIMIT ?`
    const rows = project
      ? db.prepare(sql).all(from, project, limit)
      : db.prepare(sql).all(from, limit)
    return {
      days,
      from,
      total: rows.length,
      items: rows.map(r => ({
        id: r.id,
        date: r.date,
        title: r.title,
        project: r.project || '',
        kind: r.kind || '',
        tags: JSON.parse(r.tags_json || '[]'),
      })),
    }
  } finally {
    db.close()
  }
}

/**
 * 列出未完成待办（跨条目），按「最早写入的在前」排序，让积压项先暴露。
 * days=0 表示不限日期；project 为空表示全部项目。
 */
export function listTodos(input = {}) {
  const dataDir = resolveDataDir()
  const db = openDb(dataDir)
  try {
    const days = Number(input.days) > 0 ? Math.min(Number(input.days), 3650) : 0
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100)
    const project = String(input.project || '').trim()
    const where = ['t.done = 0']
    const params = []
    if (days) {
      where.push('e.date >= ?')
      params.push(addDays(todayLocal(), -(days - 1)))
    }
    if (project) {
      where.push('e.project = ?')
      params.push(project)
    }
    const whereSql = where.join(' AND ')
    const total = db.prepare(
      `SELECT COUNT(*) AS c FROM entry_todos t JOIN entries e ON e.id = t.entry_id WHERE ${whereSql}`,
    ).get(...params).c
    const rows = db.prepare(
      `SELECT t.entry_id, t.seq, t.text, t.implicit, e.date, e.title, e.project, e.kind
       FROM entry_todos t JOIN entries e ON e.id = t.entry_id
       WHERE ${whereSql}
       ORDER BY e.date ASC, e.created_at ASC, t.seq ASC
       LIMIT ?`,
    ).all(...params, limit)
    const items = rows.map(row => ({
      id: `${row.entry_id}#${row.seq}`,
      entry_id: row.entry_id,
      seq: row.seq,
      text: row.text,
      implicit: Boolean(row.implicit),
      date: row.date,
      age_days: daysSince(row.date),
      entry_title: row.title,
      project: row.project || '',
      kind: row.kind || '',
    }))
    return { total, days, project, items }
  } finally {
    db.close()
  }
}

/**
 * 勾选一条待办：回写源 Markdown（`- [ ]` → `- [x]`，普通列表项补成复选框），
 * 再同步索引内容、hash、全文索引与待办表。Markdown 缺失时直接报错，避免真源分叉。
 */
export function completeTodo(todoId) {
  const value = String(todoId || '').trim()
  const at = value.lastIndexOf('#')
  if (at <= 0) throw new Error('todo_id 形如 <entryId>#<seq>，例如 20261021T154012-a1b2#2')
  const entryId = value.slice(0, at)
  const seq = Number(value.slice(at + 1))
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`非法待办序号：${value}`)

  const dataDir = resolveDataDir()
  const db = openDb(dataDir)
  try {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId)
    if (!row) throw new Error(`未找到日志条目：${entryId}`)
    if (!existsSync(row.path)) throw new Error(`日志文件缺失：${row.path}（请先恢复文件或重建索引）`)

    const parsed = parseEntryFile(row.path)
    const content = parsed ? parsed.content : row.content
    const marked = markTodoDone(content, seq)
    if (!marked) throw new Error(`未找到待办 ${value}（文件可能被手工改过，请先执行 worklog_reindex）`)

    const result = {
      todo_id: value,
      entry_id: entryId,
      text: marked.text,
      already_done: marked.already,
      path: row.path,
      entry_title: row.title,
      date: row.date,
    }
    if (marked.already) return result

    const meta = {
      id: row.id,
      date: row.date,
      created_at: row.created_at,
      title: row.title,
      project: row.project,
      kind: row.kind,
      tags: JSON.parse(row.tags_json || '[]'),
      people: JSON.parse(row.people_json || '[]'),
      source: row.source,
    }
    const hash = hashEntry(row.date, row.title, marked.content)
    writeEntryFile(row.path, meta, marked.content)

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE entries SET content = ?, hash = ? WHERE id = ?').run(marked.content, hash, row.id)
      db.prepare('DELETE FROM entries_fts WHERE id = ?').run(row.id)
      db.prepare(
        'INSERT INTO entries_fts (id, title, content, tags_text) VALUES (?, ?, ?, ?)',
      ).run(row.id, row.title, marked.content, meta.tags.join(' '))
      replaceTodos(db, row.id, marked.content)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (String(err && err.message).includes('UNIQUE')) {
        throw new Error('回写后与另一篇日志内容完全相同（hash 冲突），已回滚')
      }
      throw err
    }
    return result
  } finally {
    db.close()
  }
}

export function stats(input = {}) {
  const dataDir = resolveDataDir()
  const db = openDb(dataDir)
  try {
    const from = DATE_RE.test(String(input.from || '')) ? String(input.from) : ''
    const to = DATE_RE.test(String(input.to || '')) ? String(input.to) : ''
    const project = String(input.project || '').trim()
    const groupBy = ['project', 'tag', 'kind', 'month'].includes(String(input.group_by))
      ? String(input.group_by)
      : 'project'

    const where = []
    const params = []
    if (from) { where.push('e.date >= ?'); params.push(from) }
    if (to) { where.push('e.date <= ?'); params.push(to) }
    if (project) { where.push('e.project = ?'); params.push(project) }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const total = db.prepare(`SELECT COUNT(*) AS c FROM entries e ${filter}`).get(...params).c

    let groups = []
    if (groupBy === 'tag') {
      groups = db.prepare(
        `SELECT t.tag AS name, COUNT(*) AS count
         FROM entry_tags t JOIN entries e ON e.id = t.entry_id ${filter}
         GROUP BY t.tag ORDER BY count DESC, name ASC LIMIT 30`,
      ).all(...params)
    } else {
      const expr = groupBy === 'month' ? "substr(e.date, 1, 7)" : `COALESCE(e.${groupBy}, '')`
      groups = db.prepare(
        `SELECT ${expr} AS name, COUNT(*) AS count FROM entries e ${filter}
         GROUP BY name ORDER BY count DESC, name ASC LIMIT 30`,
      ).all(...params)
    }
    return { total, group_by: groupBy, groups }
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ */
/* 重建索引                                                            */
/* ------------------------------------------------------------------ */

export function reindexEntries() {
  const dataDir = resolveDataDir()
  const files = walkMarkdown(dataDir)
  const errors = []
  const parsed = []
  for (const file of files) {
    try {
      const item = parseEntryFile(file)
      if (!item) {
        errors.push({ file, error: '缺少 worklog 元信息行' })
        continue
      }
      const meta = item.meta
      const title = cleanTitle(meta.title)
      const content = item.content
      if (!meta.id || !meta.date || !title) {
        errors.push({ file, error: '元信息缺少 id/date/title' })
        continue
      }
      parsed.push({
        ...meta,
        title,
        project: meta.project || '',
        kind: meta.kind || 'note',
        tags: normalizeList(meta.tags),
        people: normalizeList(meta.people),
        source: meta.source || '',
        path: file,
        hash: hashEntry(meta.date, title, content),
        content,
      })
    } catch (err) {
      errors.push({ file, error: `${err.name || 'Error'}: ${err.message}` })
    }
  }

  const seenHash = new Set()
  const deduped = []
  for (const row of parsed) {
    if (seenHash.has(row.hash)) {
      errors.push({ file: row.path, error: '与其他文件内容完全相同（date+title+content），已跳过' })
      continue
    }
    seenHash.add(row.hash)
    deduped.push(row)
  }

  const db = openDb(dataDir)
  let todoCount = 0
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM entries_fts')
      db.exec('DELETE FROM entry_tags')
      db.exec('DELETE FROM entry_people')
      db.exec('DELETE FROM entry_todos')
      db.exec('DELETE FROM entries')
      for (const row of deduped) insertRow(db, row)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    todoCount = db.prepare('SELECT COUNT(*) AS c FROM entry_todos WHERE done = 0').get().c
  } finally {
    db.close()
  }

  return {
    data_dir: dataDir,
    index_path: indexPath(dataDir),
    files: files.length,
    indexed: deduped.length,
    open_todos: todoCount,
    errors,
  }
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

export function status() {
  const cfg = loadConfig()
  const dataDir = resolveDataDir(cfg)
  const llm = resolveLlmConfig(cfg)
  const db = openDb(dataDir)
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get().c
    const openTodos = db.prepare('SELECT COUNT(*) AS c FROM entry_todos WHERE done = 0').get().c
    return {
      data_dir: dataDir,
      index_path: indexPath(dataDir),
      config_path: configPath(),
      config: {
        data_dir: cfg.data_dir,
        llm_base_url: cfg.llm_base_url,
        llm_model: cfg.llm_model,
        llm_timeout_ms: cfg.llm_timeout_ms,
        llm_protocol: cfg.llm_protocol,
      },
      llm: llmView(llm),
      entry_count: count,
      open_todos: openTodos,
      config_exists: existsSync(configPath()),
      data_dir_exists: existsSync(dataDir),
    }
  } finally {
    db.close()
  }
}

export function updateConfig(patch) {
  saveConfig(patch)
  return status()
}
