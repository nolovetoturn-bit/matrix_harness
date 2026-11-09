/**
 * 日志管理员：在插件内部完成「检索 → 拼上下文 → 调 LLM → 蒸馏输出」。
 *
 * 关键约束：调用方会话只拿到结论（任务、问题、引用 id），不接触原始日志全文，
 * 因此日志管理员的上下文与其它会话彼此独立。prompt 与输出 JSON 结构固定，
 * 后续可对齐同一 contract 训练/替换小模型。
 *
 * @module rms-worklog/logkeeper
 */

import * as store from './store.mjs'
import { chat } from './llm.mjs'

const REVIEW_SYSTEM = [
  '你是本机工作日志管理员，只为当前用户服务。',
  '你只能依据给定的日志材料推理，禁止编造材料中不存在的任务、人物、日期或结论。',
  '输出必须是单个 JSON 对象：不要 Markdown 代码围栏，不要任何额外解释。',
].join('\n')

const ASK_SYSTEM = [
  '你是本机工作日志管理员，只为当前用户服务。',
  '只能依据给定的日志片段回答，材料没有的信息要明确说“日志里没有记录”，禁止编造。',
  '输出必须是单个 JSON 对象：不要 Markdown 代码围栏，不要任何额外解释。',
].join('\n')

function truncate(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function parseJsonBlock(text) {
  let s = String(text || '').trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

function normalizeTasks(raw, validIds) {
  if (!Array.isArray(raw)) return []
  const priorities = ['high', 'medium', 'low']
  return raw.slice(0, 5).map(item => {
    const title = String((item && item.title) || '').trim()
    const sourceIds = Array.isArray(item && item.source_ids)
      ? item.source_ids.map(String).filter(id => validIds.has(id))
      : []
    return {
      title,
      why: String((item && item.why) || '').trim(),
      priority: priorities.includes(item && item.priority) ? item.priority : 'medium',
      source_ids: sourceIds,
    }
  }).filter(item => item.title)
}

function normalizeCitations(raw, byId) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const value of raw) {
    const id = String(value || '')
    const item = byId.get(id)
    if (item && !out.some(x => x.id === id)) {
      out.push({ id, date: item.date, title: item.title })
    }
  }
  return out
}

/**
 * 「现在该干嘛」：插件内部拉取待办与最近日志，让 LLM 给出优先级与追问。
 * LLM 不可用时退回确定性待办列表，保证功能不中断。
 */
export async function review(input = {}) {
  const days = Math.min(Math.max(Number(input.days) || 14, 1), 365)
  const project = String(input.project || '').trim()
  const todos = store.listTodos({ days: 0, limit: 30, project })
  const recent = store.recentEntries({ days, limit: 20, project })

  const entries = []
  for (const item of recent.items) {
    const entry = store.getEntry(item.id, 0)
    if (!entry) continue
    entries.push({
      id: entry.id,
      date: entry.date,
      title: entry.title,
      project: entry.project,
      kind: entry.kind,
      tags: entry.tags,
      excerpt: truncate(entry.content, 500),
    })
  }

  const validIds = new Set([
    ...todos.items.map(t => t.id),
    ...todos.items.map(t => t.entry_id),
    ...entries.map(e => e.id),
  ])
  const material = {
    today: store.todayLocal(),
    open_todos: todos.items.map(t => ({
      id: t.id,
      entry_id: t.entry_id,
      text: t.text,
      date: t.date,
      age_days: t.age_days,
      entry_title: t.entry_title,
      project: t.project,
    })),
    recent_entries: entries,
  }
  const stats = { open_todos: todos.total, recent_entries: entries.length, days, project }
  const llm = store.resolveLlmConfig()

  try {
    const result = await chat({
      baseUrl: llm.base_url,
      apiKey: llm.api_key,
      model: llm.model,
      protocol: llm.protocol,
      timeoutMs: llm.timeout_ms,
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        {
          role: 'user',
          content: [
            '下面是工作日志材料（JSON）。',
            JSON.stringify(material),
            '',
            '请判断“现在最该推进什么”，并给出需要向用户确认的问题。',
            '只输出 JSON，结构如下：',
            '{"summary":"一句话概括当前状态",',
            ' "tasks":[{"title":"要推进的事","why":"依据材料的原因","priority":"high|medium|low","source_ids":["材料中的 id"]}],',
            ' "questions":["需要用户回答的问题"]}',
            '规则：tasks 最多 5 条，按优先级排序；source_ids 只能取自材料里的 id；',
            'questions 最多 3 条，用于让用户选择先做哪项或补充缺失信息；',
            '材料不足以判断时 tasks 可以为空，并在 summary 里说明。',
          ].join('\n'),
        },
      ],
    })
    const parsed = parseJsonBlock(result.content)
    if (!parsed) throw new Error('LLM 输出不是可解析的 JSON')
    const tasks = normalizeTasks(parsed.tasks, validIds)
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.map(q => String(q || '').trim()).filter(Boolean).slice(0, 3)
      : []
    return {
      llm_used: true,
      model: result.model,
      today: material.today,
      summary: String(parsed.summary || '').trim(),
      tasks,
      questions,
      stats,
    }
  } catch (err) {
    const tasks = todos.items.slice(0, 5).map(t => ({
      title: t.text,
      why: `来自 ${t.date} 的日志「${t.entry_title}」`,
      priority: 'medium',
      source_ids: [t.entry_id],
      todo_id: t.id,
    }))
    return {
      llm_used: false,
      model: llm.model,
      error: String(err && err.message ? err.message : err),
      today: material.today,
      summary: 'LLM 暂不可用，已退回结构化待办列表。',
      tasks,
      questions: todos.items.length
        ? ['接下来先推进哪一项？']
        : ['最近没有未完成待办，要先记一条新日志吗？'],
      stats,
      open_todos: todos.items,
      recent_entries: recent.items.map(item => ({
        id: item.id,
        date: item.date,
        title: item.title,
        project: item.project,
        kind: item.kind,
      })),
    }
  }
}

/**
 * 日志问答：插件内部检索候选条目并让 LLM 作答，只返回答案与引用。
 * query 缺省时用 question 检索；检索为空则退回最近日志。
 */
export async function ask(input = {}) {
  const question = String(input.question || '').trim()
  if (!question) throw new Error('缺少 question（要问日志的问题）')
  const project = String(input.project || '').trim()
  const query = String(input.query || question).trim()

  const matched = store.searchEntries({
    query,
    from: input.from,
    to: input.to,
    project,
    limit: 8,
  })
  let candidates = matched.items
  let retrieval = 'search'
  if (!candidates.length) {
    candidates = store.recentEntries({ days: 30, limit: 8, project }).items
    retrieval = 'recent'
  }

  const entries = []
  for (const item of candidates) {
    const entry = store.getEntry(item.id, 0)
    if (!entry) continue
    entries.push({
      id: entry.id,
      date: entry.date,
      title: entry.title,
      project: entry.project,
      kind: entry.kind,
      excerpt: truncate(entry.content, 1200),
    })
  }
  if (!entries.length) {
    return {
      llm_used: false,
      answer: '日志库里没有可用的相关记录。',
      confidence: 'low',
      citations: [],
      retrieval,
    }
  }

  const byId = new Map(entries.map(e => [e.id, e]))
  const llm = store.resolveLlmConfig()
  try {
    const result = await chat({
      baseUrl: llm.base_url,
      apiKey: llm.api_key,
      model: llm.model,
      protocol: llm.protocol,
      timeoutMs: llm.timeout_ms,
      temperature: 0.1,
      maxTokens: 1000,
      messages: [
        { role: 'system', content: ASK_SYSTEM },
        {
          role: 'user',
          content: [
            `今天是 ${store.todayLocal()}。`,
            `用户的问题：${question}`,
            '日志片段（JSON）：',
            JSON.stringify(entries),
            '',
            '只输出 JSON：{"answer":"结论","citations":["材料中的 id"],"confidence":"high|medium|low"}',
            'citations 只能取自材料里的 id；没有依据时 confidence 用 low，并说明日志里没有记录。',
          ].join('\n'),
        },
      ],
    })
    const parsed = parseJsonBlock(result.content)
    if (!parsed) throw new Error('LLM 输出不是可解析的 JSON')
    const confidence = ['high', 'medium', 'low'].includes(parsed.confidence)
      ? parsed.confidence
      : 'medium'
    return {
      llm_used: true,
      model: result.model,
      answer: String(parsed.answer || '').trim(),
      confidence,
      citations: normalizeCitations(parsed.citations, byId),
      retrieval,
      matched: matched.total,
    }
  } catch (err) {
    return {
      llm_used: false,
      model: llm.model,
      error: String(err && err.message ? err.message : err),
      answer: 'LLM 暂不可用，无法在插件内独立作答。下面是命中的日志标题与 id，可改用 worklog_get 查看。',
      confidence: 'low',
      citations: entries.map(e => ({ id: e.id, date: e.date, title: e.title })),
      retrieval,
      matched: matched.total,
    }
  }
}
