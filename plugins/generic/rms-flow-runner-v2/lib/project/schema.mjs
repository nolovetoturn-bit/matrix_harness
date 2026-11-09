import { randomBytes } from 'node:crypto'

export const PROJECT_STATES = Object.freeze({ ACTIVE: 'active', ARCHIVED: 'archived' })

export const newProjectId = () => `pj_${randomBytes(6).toString('hex')}`

export function assertProjectId(id) {
  if (!/^pj_[A-Za-z0-9_-]{4,40}$/.test(String(id || ''))) throw new Error(`project_id 格式不正确：${id}`)
  return id
}

const trim = (value, limit) => String(value ?? '').trim().slice(0, limit)

/**
 * 项目是顶层容器：一个项目可以有多个根 matrix，有自己的 dsh 会话、工作区与记忆。
 * 项目不设门禁，state 只有 active / archived。
 */
export function createProjectRecord({ name, brief = '', cwd = null, id = newProjectId() }) {
  const title = trim(name, 120)
  if (!title) throw new Error('项目名称不能为空')
  const now = new Date().toISOString()
  return {
    version: 1,
    id,
    name: title,
    brief: trim(brief, 4000),
    state: PROJECT_STATES.ACTIVE,
    cwd: cwd || null,
    dsh_session_id: null,
    // 已归档到项目的 dsh 会话事件游标
    dsh_event_seq: 0,
    memory: { entries: [], updated_at: now },
    root_matrix_ids: [],
    // 限界上下文（领域）清单；领域文件独立存放
    domain_ids: [],
    messages: [],
    message_seq: 0,
    archive: [],
    archive_seq: 0,
    // 项目操作日志：跨 matrix 的移动/归档/运行/验收等，便于追踪
    oplog: [],
    oplog_seq: 0,
    // 最近一次在面板打开项目的时间（项目列表按此倒序）
    last_opened_at: null,
    created_at: now,
    updated_at: now,
  }
}
