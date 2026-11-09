import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const now = () => new Date().toISOString()
const QUESTION_ID = /^uq_[A-Za-z0-9_-]+$/

function questionsDir(dataDir) {
  return join(dataDir, 'questions')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function atomicWrite(file, value) {
  ensureDir(join(file, '..'))
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

export function newQuestionId() {
  return `uq_${randomBytes(6).toString('hex')}`
}

export function isQuestionId(value) {
  return QUESTION_ID.test(String(value || ''))
}

/** 持久化一条待回答的 dsh agent 提问；面板通过 detail 轮询读取。 */
export function saveQuestion(dataDir, question) {
  atomicWrite(join(questionsDir(dataDir), `${question.id}.json`), question)
  return question
}

/** 列出某个 matrix 仍待回答的问题；旧的 answered/cancelled 记录不再展示。 */
export function listQuestions(dataDir, matrixId) {
  const dir = questionsDir(dataDir)
  if (!existsSync(dir)) return []
  const rows = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    try {
      const question = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
      if (!question || question.status !== 'open') continue
      if (matrixId && question.matrix_id !== matrixId) continue
      rows.push(question)
    } catch {}
  }
  return rows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
}

/** 关闭问题；保留记录用于审计。 */
export function closeQuestion(dataDir, questionId, status = 'answered', answers = null) {
  const file = join(questionsDir(dataDir), `${questionId}.json`)
  if (!existsSync(file)) return null
  try {
    const question = JSON.parse(readFileSync(file, 'utf8'))
    question.status = status
    question.answers = answers === undefined ? null : answers
    question.closed_at = now()
    atomicWrite(file, question)
    return question
  } catch {
    return null
  }
}
