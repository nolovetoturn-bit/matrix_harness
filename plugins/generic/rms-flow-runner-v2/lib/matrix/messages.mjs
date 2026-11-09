import { newMessageId } from './schema.mjs'

const MAX_MESSAGES = 400
const MAX_ARCHIVE = 1000
const MAX_MAILS = 200
const MAIL_KINDS = new Set(['context', 'question', 'bug_report', 'note', 'answer'])

const now = () => new Date().toISOString()
const clip = (value, limit) => String(value ?? '').trim().slice(0, limit)

/**
 * matrix 归档：记录所有事件、动作与数据，作为 dsh 会话之外的可审计事实源。
 * type: message（对话消息）/ event（系统事件）/ action（人工或 agent 动作）/ tool（工具调用）/ state（状态变化）
 */
export function archiveEntry(matrix, { type = 'event', source = 'matrix', text = '', data } = {}) {
  matrix.archive_seq = (matrix.archive_seq || 0) + 1
  const entry = {
    id: newMessageId(),
    seq: matrix.archive_seq,
    type,
    source,
    at: now(),
    ...(text ? { text: clip(text, 20000) } : {}),
    ...(data && typeof data === 'object' ? { data } : {}),
  }
  matrix.archive = [...(matrix.archive || []), entry].slice(-MAX_ARCHIVE)
  return entry
}

/**
 * 会话流消息：chat（用户沟通/agent 对话）与 agent（系统事件）按同一条时间线混排。
 * 每条消息同时写入 archive，面板与审计都从同一条时间线读取。
 */
export function appendMessage(matrix, { kind = 'agent', role = 'system', text, meta } = {}) {
  const body = clip(text, 20000)
  if (!body) return null
  matrix.message_seq = (matrix.message_seq || 0) + 1
  const message = {
    id: newMessageId(),
    seq: matrix.message_seq,
    kind: kind === 'chat' ? 'chat' : 'agent',
    role: ['user', 'assistant', 'system'].includes(role) ? role : 'system',
    text: body,
    at: now(),
    ...(meta ? { meta } : {}),
  }
  matrix.messages = [...(matrix.messages || []), message].slice(-MAX_MESSAGES)
  archiveEntry(matrix, {
    type: message.kind === 'chat' ? 'message' : 'event',
    source: (meta && meta.source) || 'matrix',
    text: body,
    data: { role: message.role, kind: message.kind, seq: message.seq, ...(meta || {}) },
  })
  return message
}

export const chatMessage = (matrix, role, text, meta) => appendMessage(matrix, { kind: 'chat', role, text, meta })
export const agentEvent = (matrix, text, meta) => appendMessage(matrix, { kind: 'agent', role: 'system', text, meta })

function matrixOf(matrices, id) {
  const matrix = matrices.get ? matrices.get(id) : matrices[id]
  if (!matrix) throw new Error(`matrix 不存在：${id}`)
  return matrix
}

/**
 * 跨 matrix 通信唯一通道：信箱。只允许同一项目（无项目时退回同一棵树）内投递。
 */
export function sendMail(matrices, { from, to, kind = 'note', subject, body, refs, requires_reply, reply_to } = {}) {
  const source = matrixOf(matrices, from)
  const target = matrixOf(matrices, to)
  const sameScope = source.project_id && target.project_id
    ? source.project_id === target.project_id
    : source.root_id === target.root_id
  if (!sameScope) throw new Error('只能在同一个项目内发信')
  const type = MAIL_KINDS.has(kind) ? kind : 'note'
  const text = clip(body, 20000)
  if (!text) throw new Error('信件正文不能为空')
  const mail = {
    id: newMessageId(),
    from: source.id,
    from_name: source.name,
    to: target.id,
    kind: type,
    subject: clip(subject, 200) || null,
    body: text,
    refs: refs && typeof refs === 'object' ? refs : null,
    requires_reply: requires_reply === undefined ? ['question', 'bug_report'].includes(type) : Boolean(requires_reply),
    reply_to: reply_to || null,
    resolved: false,
    unread: true,
    created_at: now(),
  }
  target.mailbox = target.mailbox || { mails: [], total: 0 }
  target.mailbox.mails = [...(target.mailbox.mails || []), mail].slice(-MAX_MAILS)
  target.mailbox.total = (target.mailbox.total || 0) + 1
  agentEvent(source, `已向 ${target.name}（${target.id}）发送 ${type} 信件：${mail.subject || mail.body.slice(0, 60)}`, { mail_id: mail.id, to: target.id })
  return mail
}

export function inbox(matrix, { markRead = true } = {}) {
  const mails = (matrix.mailbox && matrix.mailbox.mails) || []
  const unread = mails.filter(mail => mail.unread).length
  if (markRead) for (const mail of mails) mail.unread = false
  return {
    matrix_id: matrix.id,
    total: (matrix.mailbox && matrix.mailbox.total) || mails.length,
    unread,
    mails,
  }
}

export function replyMail(matrices, matrix, { mailId, body } = {}) {
  const mails = (matrix.mailbox && matrix.mailbox.mails) || []
  const mail = mails.find(item => item.id === mailId)
  if (!mail) throw new Error(`信件不存在：${mailId}`)
  if (mail.resolved) throw new Error('该信件已回复过')
  const answer = sendMail(matrices, {
    from: matrix.id,
    to: mail.from,
    kind: 'answer',
    subject: mail.subject ? `回复：${mail.subject}` : '回复',
    body,
    reply_to: mail.id,
  })
  mail.resolved = true
  mail.unread = false
  mail.replied_at = now()
  return { mail, answer }
}
