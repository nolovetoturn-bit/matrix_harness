﻿import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as core from '../plugin.mjs'
import { dispatchBridge } from '../lib/engine/bridge.mjs'
import { runMatrix } from '../lib/matrix/execute.mjs'
import { closeQuestion, listQuestions, newQuestionId, saveQuestion } from '../lib/matrix/questions.mjs'
import { deriveState, STATES } from '../lib/matrix/state.mjs'
import { loadAll, loadRun, resolveDataDir } from '../lib/matrix/store.mjs'
import { createPanelHandler } from '../lib/panel.mjs'

export const name = core.id
export const inject = ['tools', 'agents']

// 面板在 dsh Web 上的常驻路由；随 dsh 进程一起加载，不再需要每次 flow_ui 启动端口
const PANEL_PATH = '/flow-runner-v2'

const READ_ONLY_TOOLS = String(process.env.RMS_FLOW_AGENT_TOOLS || 'read,read_image,glob,grep')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)
const CODING_TOOLS = String(process.env.RMS_FLOW_CODING_AGENT_TOOLS || 'read,read_image,glob,grep,write,edit,bash,pwsh')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)
const TOOL_NODE_ALLOW = String(process.env.RMS_FLOW_TOOL_ALLOW || 'read,read_image,glob,grep')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)
// 节点编码会话的提示词很大，单次模型调用可能超过 3 分钟；默认给 10 分钟，可用环境变量收紧
const AGENT_TIMEOUT_MS = Number(process.env.RMS_FLOW_AGENT_TIMEOUT_MS || 600000)
const TOOL_TIMEOUT_MS = Number(process.env.RMS_FLOW_TOOL_TIMEOUT_MS || 120000)

/**
 * 构造 tool 节点的执行器：按允许清单调用宿主注册的工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @returns {(input: { name: string, args?: unknown }) => Promise<{ value: unknown }>} 工具执行器
 */
function createToolRunner(ctx) {
  return async ({ name, args }) => {
    const toolName = String(name || '')
    if (!TOOL_NODE_ALLOW.includes(toolName)) {
      throw new Error(`tool 节点不允许调用 ${toolName}；可在 RMS_FLOW_TOOL_ALLOW 中放行`)
    }
    const visible = new Set(ctx.tools.schemas().map(tool => tool.name))
    if (!visible.has(toolName)) throw new Error(`宿主没有注册工具 ${toolName}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS)
    let result
    try {
      result = await ctx.tools.execute({
        callId: `rms-flow-tool-${randomUUID()}`,
        name: toolName,
        arguments: args === undefined ? {} : args,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (result.isError) {
      const detail = result.error && typeof result.error === 'object'
        ? String(result.error.message || result.error.code || JSON.stringify(result.error))
        : String(result.error)
      throw new Error(`工具 ${toolName} 执行失败：${detail}`)
    }
    return { value: result.value }
  }
}

/**
 * tool 节点全放行：不校验 allowlist，但仍走 ctx.tools.execute，
 * 因此宿主 approval policy 照常生效。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @returns {(input: { name: string, args?: unknown }) => Promise<{ value: unknown }>} 工具执行器
 */
function createOpenToolRunner(ctx, ensureRunAgent) {
  return async ({ runId, dataDir, name, args }) => {
    const toolName = String(name || '')
    // 工具按 agent 作用域注册；tool 节点必须借用该 run 的 agent 才能看到并执行工具
    const agent = await ensureRunAgent(runId, dataDir)
    const visible = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
    if (!visible.has(toolName)) throw new Error(`宿主没有注册工具 ${toolName}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS)
    let result
    try {
      result = await ctx.tools.execute({
        agent,
        callId: `rms-flow-tool-${randomUUID()}`,
        name: toolName,
        arguments: args === undefined ? {} : args,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (result.isError) {
      const detail = result.error && typeof result.error === 'object'
        ? String(result.error.message || result.error.code || JSON.stringify(result.error))
        : String(result.error)
      throw new Error(`工具 ${toolName} 执行失败：${detail}`)
    }
    return { value: result.value }
  }
}

/**
 * 汇总一次 assistant 消息里的可见文本。
 * @param {unknown} content - Session 事件中的 content 块数组
 * @returns {string} 拼接后的文本
 */
function assistantText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
}

function createWorkspaceProvider(ctx) {
  return {
    async ensure({ path, title }) {
      await mkdir(path, { recursive: true })
      const registry = ctx.get('workspaceRegistry')
      if (!registry) return { path, workspace_id: null }
      const workspace = await registry.create(path, title)
      return { path: workspace.path, workspace_id: String(workspace.id) }
    },
    async attach({ sessionId, path, workspaceId }) {
      const registry = ctx.get('workspaceRegistry')
      if (!registry) return { path, workspace_id: null }
      const workspace = workspaceId ? registry.get(workspaceId) : await registry.resolveByPath(path)
      if (!workspace) throw new Error(`dsh Workspace 未注册：${workspaceId || path}`)
      await workspace.attachSession(sessionId)
      return { path: workspace.path, workspace_id: String(workspace.id) }
    },
  }
}

async function existingSessionHeader(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId)
  const session = agent ? agent.session : ctx.get('sessions')?.get(sessionId)
  if (session) return session.header
  const persistence = ctx.get('sessionPersistence')
  return persistence ? (await persistence.stat(sessionId))?.header : undefined
}

/** dsh 内存中的会话（agent 或 Web 侧挂载的 store 会话）；拿到它就绕开持久化写句柄竞争。 */
function liveSessionOf(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId)
  if (agent) return { session: agent.session, agent }
  const session = ctx.get('sessions')?.get(sessionId)
  return session ? { session, agent: null } : null
}

/**
 * 绑定语境：这个会话的 id 就是 matrix id，agent 在这里做意图识别并调用 matrix_* 工具。
 * 只写一次（建会话时），后续对话直接追加到同一会话。
 */
const bindingBrief = ({ sessionId, title, task }) => [
  `【Flow 矩阵会话】${title || sessionId}`,
  `matrix_id: ${sessionId}`,
  `任务：${task || '（未填写）'}`,
  '',
  `你是该 matrix 的常驻 agent。用户在此会话中的自然语言输入就是对 matrix ${sessionId} 的操作指令：`,
  '- 先调用 matrix_get / matrix_tree / matrix_nav 了解当前状态，再决定执行哪个动作；',
  '- 需求澄清、需求修订、DAG 生成/确认、预构建、运行、评估、监督、验收、终止、信箱都有对应的 matrix_* 工具；',
  '- 运行失败或节点产物有问题时：先用 matrix_runs 查看失败轨迹，再用 matrix_revise_node 修复单个节点（可直接传 code，或传修复说明让编码会话重写），然后用 matrix_run 重跑；不需要重新生成整张 DAG；',
  '- 需要大改 DAG 结构时：用 matrix_reopen_dag 退回 DAG 确认阶段（可附带 instruction 直接重生成骨架；旧预构建与验收结果会作废），确认后重新预构建；',
  '- 用户说“撤回/刚才不算/回到上一轮”时：用 matrix_rewind 列出已完成轮次，选定 at_seq 后从该轮分叉新会话继续；matrix 状态与运行记录不变；',
  '- 未显式提供 matrix_id 时，matrix_* 工具会自动绑定到本会话对应的 matrix；',
  '- 除 confirm_dag、accept、cancel 需要用户明确同意外，其余动作可以自行推进，完成后向用户报告结果。',
].join('\n')

/**
 * 挂载默认 preset，并把 matrix 绑定语境写进系统提示词。
 * 绑定信息不能预置成 user/message：dsh 要求 system/message 占据 surface 首位，
 * 先写用户消息会让会话在 resume 时被判为 corrupt。
 */
function mountMatrixPreset(ctx, agentCtx, brief, questionOptions = {}) {
  const presets = ctx.get('agentPresets')
  const ready = presets ? presets.mount(agentCtx, presets.defaultId) : Promise.resolve()
  return Promise.resolve(ready).then(() => {
    if (brief && agentCtx.systemPrompt) {
      agentCtx.systemPrompt.section({
        name: 'rms-flow:matrix-binding',
        order: agentCtx.systemPrompt.getSectionOrder('TEAM_POLICY'),
        text: brief,
      })
    }
    // 矩阵/项目绑定会话的 ask_user_question 由 flow-runner 面板作答，而不是依赖 dsh 会话窗口。
    const sessionId = String(questionOptions.sessionId || '')
    const bindId = String(questionOptions.bindId || sessionId)
    const matrixId = /^((?:mx|pj|dom)_[A-Za-z0-9]+)/.exec(bindId)?.[1]
    if (!matrixId || typeof questionOptions.askUserQuestion !== 'function') return
    // prepend：必须先于 dsh Web 客户端的通用提问卡片，否则矩阵会话会被远端客户端接管，
    // flow-runner 面板既看不到问题，也无法回传答案。
    agentCtx.on('user-questions/request', request => questionOptions.askUserQuestion({
      matrixId,
      sessionId,
      request,
    }), true)
  })
}

const systemMessageData = text => ({
  id: randomUUID(),
  role: 'system',
  content: [{ type: 'text', text }],
  source: { kind: 'system-prompt' },
})

function createSessionMirror(ctx, workspaceProvider, askUserQuestion) {
  return async ({ sessionId, matrixId, workspace, title, task, parentSessionId, brief }) => {
    if (!ctx.get('workspaceRegistry')) {
      return { session_id: null, path: workspace, workspace_id: null }
    }
    const text = brief || bindingBrief({ sessionId: matrixId || sessionId, title, task })
    const prepared = await workspaceProvider.ensure({ path: workspace, title })
    const existing = await existingSessionHeader(ctx, sessionId)
    if (existing) {
      await workspaceProvider.attach({ sessionId, path: prepared.path, workspaceId: prepared.workspace_id })
      return { session_id: sessionId, ...prepared }
    }
    let handle
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: prepared.path,
          // 子会话镜像记录父镜像：dsh 侧栏据此把会话渲染成树
          ...(parentSessionId ? { parentSession: parentSessionId } : {}),
        },
        setup: agentCtx => mountMatrixPreset(ctx, agentCtx, text, {
          sessionId, askUserQuestion, bindId: matrixId || sessionId,
        }),
      })
      // dsh 的 surface 规则：system/message 必须占据首位，且只能落在已开启的 turn + step 内。
      // 顺序固定为 turn/start → step/start → system/message → step/end → turn/end。
      // 首次 agent 轮次会把 head 替换成真实系统提示词，后续回灌的 assistant 消息才合法。
      handle.agent.session.append('turn/start', { turn: 1 })
      handle.agent.session.append('step/start', { turn: 1, step: 1 })
      handle.agent.session.append('system/message', {
        turn: 1, step: 1, message: systemMessageData(text),
      }, { surfaceOp: 'append' })
      handle.agent.session.append('step/end', { turn: 1, step: 1 })
      // dsh 侧栏把“空会话”（sessionListMetadata.blank=true）隐藏；只有 turn/start 会把 blank 置为 false。
      handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await workspaceProvider.attach({ sessionId, path: prepared.path, workspaceId: prepared.workspace_id })
      return { session_id: sessionId, ...prepared }
    } finally {
      if (handle) await handle.dispose()
    }
  }
}

const mirrorMessageData = text => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'rms-flow-runner', model: 'matrix-mirror' },
  id: randomUUID(),
})

/** 从格式错误里取出持久化日志路径，供换绑后清理坏会话。 */
const rawLogPath = detail => /raw log:\s*(.+?)\s*$/m.exec(String(detail || ''))?.[1]

const maxTurnOfEvents = events => {
  let turn = 0
  for (const event of events || []) {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') continue
    const value = Number(event.data && event.data.turn)
    if (Number.isInteger(value)) turn = Math.max(turn, value)
  }
  return turn
}

/**
 * matrix 侧事件/动作/状态 → dsh 会话（补齐 dsh 侧看不到的过程记录）。
 * 只在会话不活跃时写入：agent 正在跑时追加已完成的轮次会打乱它的 surface，
 * 这类增量留到下一轮（会话空闲后）再回灌。
 */
function createSessionAppend(ctx) {
  return async ({ sessionId, entries = [] }) => {
    if (!sessionId || !entries.length) return { appended: false }
    const lines = entries.map(entry => `【${entry.type}】${entry.text}`).filter(line => line.trim() !== '【】')
    if (!lines.length) return { appended: false }
    const live = liveSessionOf(ctx, sessionId)
    if (live) {
      if (live.agent) {
        // dsh Web 常把会话保持在活跃状态；只有确认空闲时才补一轮，避免打乱正在跑的 turn
        const idle = await Promise.race([
          live.agent.whenIdle().then(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 30)),
        ])
        if (!idle) {
          console.log(`[${core.id}] session append deferred: ${sessionId} is busy`)
          return { appended: false }
        }
      }
      const turn = maxTurnOfEvents(live.session.snapshotEvents(0)) + 1
      live.session.append('turn/start', { turn })
      lines.forEach((text, index) => {
        const step = index + 1
        live.session.append('step/start', { turn, step })
        live.session.append('assistant/message', {
          turn, step, stream: [], message: mirrorMessageData(text),
        }, { surfaceOp: 'append' })
        live.session.append('step/end', { turn, step })
      })
      live.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return { appended: true }
    }
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) {
      console.error(`[${core.id}] session append skipped: no sessionPersistence`)
      return { appended: false }
    }
    let handle
    try {
      handle = await persistence.open(sessionId, 'write')
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      console.error(`[${core.id}] session append open failed for ${sessionId}: ${detail}`)
      return {
        appended: false,
        ...(/corrupt|SessionFormatError/.test(detail) ? { corrupt: true, path: rawLogPath(detail) } : {}),
      }
    }
    try {
      const { events = [] } = await handle.read()
      const turn = maxTurnOfEvents(events) + 1
      const time = Date.now()
      const batch = []
      const push = (type, data, extra = {}) => {
        batch.push({ type, seq: events.length + batch.length, time, ...extra, data })
      }
      push('turn/start', { turn })
      lines.forEach((text, index) => {
        const step = index + 1
        push('step/start', { turn, step })
        push('assistant/message', { turn, step, stream: [], message: mirrorMessageData(text) }, { surfaceOp: 'append' })
        push('step/end', { turn, step })
      })
      push('turn/end', { turn, reason: { kind: 'completed' } })
      await handle.append(batch)
      await handle.flush()
      return { appended: true }
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      if (/corrupt|SessionFormatError/.test(detail)) {
        console.error(`[${core.id}] session append hit corrupt log ${sessionId}: ${detail}`)
        return { appended: false, corrupt: true, path: rawLogPath(detail) }
      }
      throw error
    } finally {
      await handle.close()
    }
  }
}

/**
 * 绑定 agent 的实时状态：从会话尾部事件推断是否在跑、在等模型还是在调工具。
 * 尾部出现未闭合的 turn/start 即视为执行中；tool/call 未配对 tool/result 时显示工具名。
 */
function createAgentStatus(ctx) {
  const summarize = events => {
    let openTurn = null
    let openStep = null
    let startedAt = null
    let lastAt = null
    const calls = new Map()
    for (const event of events || []) {
      const data = event.data || {}
      if (Number.isInteger(event.time)) lastAt = event.time
      if (event.type === 'turn/start') {
        openTurn = data.turn
        openStep = null
        startedAt = Number.isInteger(event.time) ? event.time : null
        calls.clear()
      } else if (event.type === 'turn/end') {
        openTurn = null
        openStep = null
        startedAt = null
        calls.clear()
      } else if (event.type === 'step/start') {
        openStep = data.step
      } else if (event.type === 'step/end') {
        openStep = null
      } else if (event.type === 'tool/call') {
        calls.set(data.callId, { name: data.name, at: event.time })
      } else if (event.type === 'tool/result') {
        const callId = data.message && data.message.toolCallId
        if (callId) calls.delete(callId)
      }
    }
    if (openTurn === null) {
      return { running: false, phase: 'idle', last_event_at: lastAt }
    }
    const pending = [...calls.values()].pop()
    return {
      running: true,
      phase: pending ? (pending.name === 'ask_user_question' ? 'question' : 'tool') : 'model',
      tool: pending ? pending.name : null,
      turn: openTurn,
      step: openStep,
      started_at: startedAt,
      last_event_at: lastAt,
    }
  }
  return async ({ sessionId }) => {
    if (!sessionId) return { running: false, phase: 'idle' }
    // 没有活着的 agent 时，会话日志里可能残留未闭合的 turn（例如进程重启）；这不代表仍在执行
    if (!ctx.agents.get(sessionId)) return { running: false, phase: 'idle' }
    const live = liveSessionOf(ctx, sessionId)
    if (live) {
      const from = Math.max(0, live.session.seq - 120)
      return summarize(live.session.snapshotEvents(from))
    }
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) return { running: false, phase: 'idle' }
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch {
      return { running: false, phase: 'idle' }
    }
    try {
      const { events = [] } = await handle.read()
      return summarize(events.slice(-120))
    } finally {
      await handle.close()
    }
  }
}

/**
 * 读取绑定 dsh 会话的事件增量（dsh → matrix 归档用）。
 * 活跃会话直接读内存日志；冷会话从持久化文件读。
 * @returns {Promise<{ events: object[], cursor: number }>}
 */
function createSessionEvents(ctx) {
  return async ({ sessionId, sinceSeq = 0 }) => {
    if (!sessionId) return { events: [], cursor: sinceSeq }
    const live = liveSessionOf(ctx, sessionId)
    if (live) {
      const from = Math.max(0, Math.min(Number(sinceSeq) || 0, live.session.seq))
      return { events: [...live.session.snapshotEvents(from)], cursor: live.session.seq }
    }
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) return { events: [], cursor: sinceSeq }
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch {
      return { events: [], cursor: sinceSeq }
    }
    try {
      const { events = [] } = await handle.read()
      return { events: events.filter(event => Number(event.seq) >= (Number(sinceSeq) || 0)), cursor: events.length }
    } finally {
      await handle.close()
    }
  }
}

/**
 * 面板自然语言输入 → 绑定 dsh agent 会话。
 * 同一会话串行发送：活跃会话直接 followup；冷会话先 resume，跑完一轮后释放。
 * 返回时只保证消息已送达，不等待 agent 完成；输出由 sessionEvents 增量归档。
 */
function createMatrixChat(ctx, askUserQuestion) {
  const queues = new Map()
  const userMessage = text => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'rms-flow-panel' },
  })
  const modelOptions = () => {
    const defaultModel = ctx.get('agentDefaultModel')
    const selection = defaultModel && typeof defaultModel.currentSelection === 'function'
      ? defaultModel.currentSelection()
      : null
    return selection && selection.provider && selection.model
      ? { agentOptions: { provider: selection.provider, model: selection.model } }
      : {}
  }
  /**
   * 旧版本预置了 user/message，dsh resume 会判定“system/message 不是 surface 首位”而报 corrupt。
   * 无兼容包袱：删掉坏掉的日志文件，用同一 sessionId 重建会话，再发本轮输入。
   */
  const recreateCorruptSession = async ({ sessionId, cwd, brief, bindId, error }) => {
    // resume 的报错里带持久化文件路径；删掉坏日志后用同一 sessionId 重建
    const detail = String(error && error.message ? error.message : error)
    const rawPath = /raw log:\s*(.+?)\s*$/m.exec(detail)?.[1]
    // 整个会话目录一起删：只删日志文件时持久化仍认为该 session 存在
    if (rawPath) await rm(dirname(rawPath), { recursive: true, force: true }).catch(() => {})
    return ctx.agents.create({
      sessionId,
      meta: { cwd },
      ...modelOptions(),
      setup: agentCtx => mountMatrixPreset(ctx, agentCtx, brief, { sessionId, askUserQuestion, bindId }),
    })
  }
  const waitIdle = async agent => {
    const limit = AGENT_TIMEOUT_MS
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          agent.cancel({ kind: 'hook', reason: 'matrix chat timeout' })
        } catch {}
        reject(new Error(`绑定 agent 会话超过 ${limit}ms 未完成`))
      }, limit)
    })
    try {
      await Promise.race([agent.whenIdle(), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
  return async ({ sessionId, matrixId, text, cwd, title, task, brief }) => {
    if (!sessionId) throw new Error('matrixChat 需要 sessionId')
    if (!String(text || '').trim()) throw new Error('matrixChat 需要 text')
    const binding = brief || bindingBrief({ sessionId, title, task })
    const bindId = matrixId || sessionId
    let startedResolve
    let startedReject
    const started = new Promise((resolve, reject) => {
      startedResolve = resolve
      startedReject = reject
    })
    const previous = queues.get(sessionId) || Promise.resolve()
    const job = previous.catch(() => {}).then(async () => {
      try {
        const live = ctx.agents.get(sessionId)
        if (live) {
          live.followup(userMessage(text))
          startedResolve({ recreated: false })
          return
        }
        let handle
        let recreated = false
        try {
          handle = await ctx.agents.resume({
            resumeSessionId: sessionId,
            setup: agentCtx => mountMatrixPreset(ctx, agentCtx, binding, { sessionId, askUserQuestion, bindId }),
            ...modelOptions(),
          })
        } catch (error) {
          const detail = String(error && error.message ? error.message : error)
          const missing = /not found|SESSION_QUERY_SESSION_NOT_FOUND|不存在/i.test(detail)
          const corrupt = /corrupt|SessionFormatError/.test(detail)
          if (!missing && (!String(cwd || '').trim() || !corrupt)) throw error
          // 会话日志丢失（例如分叉后立刻重启）时用同一 sessionId 重建空会话；
          // matrix 归档保留，但新会话语境从当前消息开始，agent 可通过 matrix_get 恢复事实
          handle = await recreateCorruptSession({ sessionId, cwd, brief: binding, bindId, error })
          recreated = true
        }
        try {
          handle.agent.followup(userMessage(text))
          startedResolve({ recreated })
          await waitIdle(handle.agent)
        } finally {
          await handle.dispose()
        }
      } catch (error) {
        // 会话恢复/发送失败要让调用方拿到错误，而不是一直等 started
        startedReject(error)
        throw error
      }
    })
    queues.set(sessionId, job)
    job.catch(() => {}).finally(() => {
      if (queues.get(sessionId) === job) queues.delete(sessionId)
    })
    const info = await started
    return { accepted: true, session_id: sessionId, recreated: Boolean(info && info.recreated) }
  }
}

/**
 * 构造一次受控的 dsh agent 会话：挂载 preset、按只读/编码模式限制工具并收集 assistant 输出。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @param {Map<string, { mode: string, workspace: string }>} managedSessions - 由本插件创建、需要审批兜底的会话
 * @returns {(input: { system?: string, prompt: string, input?: unknown, timeoutMs?: number, workspace?: string, sessionId?: string, parentSessionId?: string }) => Promise<{ text: string, messages: number, session_id: string, parent_session_id: string | null, workspace: string, workspace_id: string | null, mode: string }>}
 */
function createAgentRunner(ctx, managedSessions, options = {}) {
  const mode = options.mode || 'readonly'
  const workspaceProvider = options.workspaceProvider
  return async ({ system, prompt, input, timeoutMs, workspace, cwd: requestedCwd, sessionId: requestedSessionId, parentSessionId }) => {
    const agentPresets = ctx.get('agentPresets')
    const defaultModel = ctx.get('agentDefaultModel')
    const selection = defaultModel && typeof defaultModel.currentSelection === 'function'
      ? defaultModel.currentSelection()
      : null
    const sessionId = requestedSessionId || `${options.prefix || 'rms-flow-agent'}-${randomUUID()}`
    const configuredWorkspace = String(workspace || '').trim()
    const cwdOverride = String(requestedCwd || '').trim()
    const prepared = configuredWorkspace && workspaceProvider
      ? await workspaceProvider.ensure({ path: configuredWorkspace, title: sessionId })
      : null
    if (cwdOverride) await mkdir(cwdOverride, { recursive: true })
    const cwd = cwdOverride || prepared?.path || configuredWorkspace || process.cwd()
    // 节点会话的 cwd 是 .flow-nodes/<节点> 隔离目录，而 dsh Workspace 只接纳 cwd 恰好等于
    // 自身路径的会话；这类会话不挂 Workspace（挂载会被拒绝并让节点构建失败），
    // 并以 subagent 来源登记，避免它们在侧栏「未分组」里散落。
    const isolated = Boolean(cwdOverride) && prepared !== null && cwd !== prepared.path
    const texts = []
    const disposeEvents = ctx.on('session/event', (session, event) => {
      if (!session || String(session.id) !== sessionId) return
      if (event.type !== 'assistant/message') return
      const text = assistantText(event.data && event.data.message && event.data.message.content)
      if (text) texts.push(text)
    }, { global: true })

    managedSessions.set(sessionId, { mode, workspace: cwd })
    const setup = async (agentCtx, agent) => {
      if (agentPresets) await agentPresets.mount(agentCtx, agentPresets.defaultId)
      try {
        const allowed = mode === 'coding' ? CODING_TOOLS : READ_ONLY_TOOLS
        const visible = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
        const allow = allowed.filter(toolName => visible.has(toolName))
        if (allow.length) agentCtx.tools.restrict({ allow })
        agentCtx.on('tools/pre-execute', (exec, next) => {
          if (allowed.includes(exec.name)) return next()
          return Promise.resolve({
            kind: 'deny',
            reason: `当前 Flow ${mode} 会话不允许使用 ${exec.name}；请直接完成当前任务，不要委派或等待后台任务。`,
          })
        })
      } catch (error) {
        console.error(`[${core.id}] agent 工具限制失败：${error && error.message ? error.message : error}`)
      }
    }
    let handle
    try {
      // 固定 sessionId（如每 run 一个 <runId>-llm）时复用活跃会话或恢复持久化会话，避免重复 create 冲突。
      const liveAgent = requestedSessionId ? ctx.agents.get(sessionId) : null
      const resumable = Boolean(requestedSessionId && !liveAgent && await existingSessionHeader(ctx, sessionId))
      if (liveAgent) {
        handle = { agent: liveAgent, dispose: async () => {} }
      } else if (resumable) {
        handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          ...(selection && selection.provider && selection.model
            ? { agentOptions: { provider: selection.provider, model: selection.model } }
            : {}),
          setup,
        })
      } else {
        handle = await ctx.agents.create({
          sessionId,
          meta: {
            cwd,
            ...(parentSessionId ? { parentSession: parentSessionId } : {}),
            ...(isolated ? { origin: 'subagent' } : {}),
          },
          ...(selection && selection.provider && selection.model
            ? { agentOptions: { provider: selection.provider, model: selection.model } }
            : {}),
          setup,
        })
      }
      if (prepared && !isolated && !liveAgent) {
        await workspaceProvider.attach({ sessionId, path: prepared.path, workspaceId: prepared.workspace_id })
      }

      const sections = []
      if (system) sections.push(`【角色与约束】\n${system}`)
      if (configuredWorkspace) {
        sections.push(`【工作目录】\n${cwd}\n${mode === 'coding'
          ? '只允许在该目录内读写文件和执行命令；写文件、edit 和 bash/pwsh 的 workdir 都必须位于此目录。'
          : '只允许读取该目录内的文件；目录外路径一律视为不可用，不要尝试用绝对路径或 .. 越界。'}`)
      }
      sections.push(`【任务】\n${prompt}`)
      if (input !== undefined) sections.push(`【输入】\n${JSON.stringify(input, null, 2)}`)
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: sections.join('\n\n') }],
        source: { kind: 'rms-flow-runner' },
      })

      const limit = Number(timeoutMs || AGENT_TIMEOUT_MS)
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try {
            handle.agent.cancel({ kind: 'hook', reason: 'rms-flow-runner agent timeout' })
          } catch {}
          reject(new Error(`agent 会话超过 ${limit}ms 未完成`))
        }, limit)
      })
      try {
        await Promise.race([handle.agent.whenIdle(), timeout])
      } finally {
        clearTimeout(timer)
      }
    } finally {
      managedSessions.delete(sessionId)
      if (handle) await handle.dispose()
      disposeEvents()
    }

    return {
      text: texts.length ? texts[texts.length - 1] : '',
      messages: texts.length,
      session_id: sessionId,
      parent_session_id: parentSessionId || null,
      workspace: cwd,
      workspace_id: prepared?.workspace_id || null,
      mode,
    }
  }
}

/** 归一化 dsh ask_user_question 的问题结构，供面板渲染。 */
function normalizeQuestionItems(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const source = item && typeof item === 'object' ? item : {}
    const options = Array.isArray(source.options)
      ? source.options.map(option => ({
        label: String(option && option.label !== undefined ? option.label : ''),
        ...(option && option.description ? { description: String(option.description) } : {}),
      }))
      : null
    return {
      id: String(source.id !== undefined ? source.id : `q${index + 1}`),
      question: String(source.question !== undefined ? source.question : ''),
      ...(source.header ? { header: String(source.header) } : {}),
      ...(source.detail ? { detail: String(source.detail) } : {}),
      ...(options ? { options } : {}),
      ...(source.multiSelect ? { multiSelect: true } : {}),
    }
  })
}

/** 校验面板答案：每个问题恰好一项，且必须选中选项或填写自定义回答。 */
function normalizeAnswerBatch(questions, answers) {
  const byId = new Map((Array.isArray(answers) ? answers : []).map(item => [String(item && item.id), item]))
  return questions.map(question => {
    const item = byId.get(question.id)
    if (!item) throw new Error(`缺少问题 ${question.id} 的答案`)
    const selected = Array.isArray(item.selected) ? item.selected.map(value => String(value)) : []
    const custom = typeof item.custom === 'string' && item.custom.trim() ? item.custom : undefined
    if (!selected.length && !custom) throw new Error(`问题 ${question.id} 需要选择选项或填写回答`)
    return { id: question.id, selected, ...(custom ? { custom } : {}) }
  })
}

function pathWithin(workspace, candidate) {
  if (!candidate) return true
  const base = resolve(workspace)
  const target = resolve(base, String(candidate))
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function apply(ctx) {
  const managedSessions = new Map()
  const workspaceProvider = createWorkspaceProvider(ctx)
  // tool 节点借用 run 的 agent 作用域；每个 run 一个常驻 agent，供 bridge 工具调用复用
  const runAgents = new Map()
  const ensureRunAgent = async (runId, dataDir) => {
    const sessionId = `${runId}-tool`
    const live = ctx.agents.get(sessionId)
    if (live) return live
    const runDir = join(resolveDataDir(dataDir), 'runs', runId)
    const workspace = join(runDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const prepared = await workspaceProvider.ensure({ path: workspace, title: sessionId })
    const agentPresets = ctx.get('agentPresets')
    const selection = ctx.get('agentDefaultModel')
    const current = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : null
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: prepared.path, origin: 'subagent' },
      ...(current && current.provider && current.model
        ? { agentOptions: { provider: current.provider, model: current.model } }
        : {}),
      setup: async agentCtx => {
        if (agentPresets) await agentPresets.mount(agentCtx, agentPresets.defaultId)
      },
    })
    runAgents.set(sessionId, handle)
    await workspaceProvider.attach({ sessionId, path: prepared.path, workspaceId: prepared.workspace_id })
    return handle.agent
  }
  const openToolRunner = createOpenToolRunner(ctx, ensureRunAgent)
  // 运行进入终态后释放该 run 的常驻 tool agent，避免 dsh 会话与作用域泄漏
  const disposeRunAgents = async runId => {
    if (!runId) return
    for (const [sessionId, handle] of [...runAgents]) {
      if (!sessionId.startsWith(`${runId}-`)) continue
      runAgents.delete(sessionId)
      try {
        await handle.dispose()
      } catch (error) {
        console.error(`[${core.id}] dispose run agent ${sessionId} failed: ${error && error.message ? error.message : error}`)
      }
    }
  }
  // dsh ask_user_question 的矩阵会话由面板回答：问题落盘，面板提交答案后唤醒等待中的 agent
  const matrixDataDir = resolveDataDir()
  const pendingQuestions = new Map()
  // 撤回分叉创建的会话句柄必须保持到会话真正落盘；立即 dispose 会让新会话日志丢失
  const forkedAgents = new Map()
  // 上一个进程遗留的 open 问题已没有等待中的 agent，启动时关闭避免面板显示死卡片
  for (const stale of listQuestions(matrixDataDir)) closeQuestion(matrixDataDir, stale.id, 'cancelled')
  const askUserQuestion = async ({ matrixId, sessionId, request }) => {
    const record = {
      version: 1,
      id: newQuestionId(),
      matrix_id: matrixId,
      session_id: sessionId,
      call_id: request.wait && request.wait.callId ? String(request.wait.callId) : null,
      questions: normalizeQuestionItems(request.questions),
      status: 'open',
      created_at: new Date().toISOString(),
    }
    saveQuestion(matrixDataDir, record)
    return await new Promise((resolve, reject) => {
      let settled = false
      const settle = (kind, value) => {
        if (settled) return
        settled = true
        pendingQuestions.delete(record.id)
        if (request.signal) request.signal.removeEventListener('abort', onAbort)
        if (kind === 'answer') {
          closeQuestion(matrixDataDir, record.id, 'answered', value.answers)
          resolve(value)
        } else {
          closeQuestion(matrixDataDir, record.id, 'cancelled')
          reject(value)
        }
      }
      const onAbort = () => settle('error', new Error('ask_user_question was aborted before the user answered'))
      if (request.signal) {
        if (request.signal.aborted) {
          onAbort()
          return
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
      }
      pendingQuestions.set(record.id, {
        record,
        answer: value => settle('answer', value),
        cancel: error => settle('error', error),
      })
    })
  }
  const answerUserQuestion = async ({ matrix_id, question_id, answers }) => {
    const entry = pendingQuestions.get(String(question_id || ''))
    if (!entry) throw new Error(`问题 ${question_id} 已结束或不存在`)
    if (entry.record.matrix_id !== matrix_id) throw new Error('问题不属于该 matrix')
    entry.answer({ answers: normalizeAnswerBatch(entry.record.questions, answers) })
    return { question_id, answers }
  }
  const cancelUserQuestion = ({ matrix_id, question_id, reason }) => {
    const entry = pendingQuestions.get(String(question_id || ''))
    if (!entry) throw new Error(`问题 ${question_id} 已结束或不存在`)
    if (entry.record.matrix_id !== matrix_id) throw new Error('问题不属于该 matrix')
    entry.cancel(new Error(reason || '用户已取消该问题'))
    return { question_id, cancelled: true }
  }
  /** 面板执行确定性操作后，关闭该 matrix 下所有等待回答的问题，避免 agent 永久卡住。 */
  const cancelUserQuestions = ({ matrix_id, reason }) => {
    let cancelled = 0
    for (const entry of [...pendingQuestions.values()]) {
      if (entry.record.matrix_id !== matrix_id) continue
      entry.cancel(new Error(reason || '用户已通过面板完成该操作，问题已失效'))
      cancelled += 1
    }
    return { matrix_id, cancelled }
  }

  const readSessionEvents = async sessionId => {
    const live = liveSessionOf(ctx, sessionId)
    if (live) return [...live.session.snapshotEvents(0)]
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) throw new Error('宿主缺少 sessionPersistence，无法读取会话')
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch (error) {
      throw new Error(`读取会话 ${sessionId} 失败：${error && error.message ? error.message : error}`)
    }
    try {
      const snapshot = await handle.read()
      return snapshot.events || []
    } finally {
      await handle.close()
    }
  }

  const eventText = content => Array.isArray(content)
    ? content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('').trim()
    : ''

  const hasOpenTurn = events => {
    let open = false
    for (const event of events || []) {
      if (event.type === 'turn/start') open = true
      else if (event.type === 'turn/end') open = false
    }
    return open
  }

  /** 列出可撤回的对话轮次（仅已完成 turn，boundary 取 turn/end 的 seq）。 */
  const rewindPoints = async ({ sessionId }) => {
    const events = await readSessionEvents(sessionId)
    const points = []
    let pending = null
    for (const event of events) {
      const data = event.data || {}
      if (event.type === 'turn/start') {
        pending = { turn: data.turn, user: [], assistant: [], started_at: event.time }
      } else if (pending && event.type === 'user/message') {
        const text = eventText(data.content)
        if (text) pending.user.push(text)
      } else if (pending && event.type === 'assistant/message') {
        const text = eventText(data.message && data.message.content)
        if (text) pending.assistant.push(text)
      } else if (pending && event.type === 'turn/end') {
        points.push({
          at_seq: event.seq,
          turn: pending.turn,
          at: new Date(event.time).toISOString(),
          user_text: pending.user.join(' ').slice(0, 300),
          assistant_text: (pending.assistant[pending.assistant.length - 1] || '').slice(0, 300),
        })
        pending = null
      }
    }
    // 只有仍有活 agent 时，未闭合的 turn 才代表“正在执行”；重启后的残留 open turn 不算
    return { session_id: sessionId, points, running: Boolean(ctx.agents.get(sessionId)) && hasOpenTurn(events) }
  }

  /** 从已完成的一轮对话分叉出新会话，并把矩阵绑定切到新分支。 */
  const forkMatrixSession = async ({ matrixId, sessionId, atSeq, title, task }) => {
    const events = await readSessionEvents(sessionId)
    if (ctx.agents.get(sessionId) && hasOpenTurn(events)) throw new Error('当前会话仍在执行，请等待本轮回复结束后再撤回')
    const boundary = events.find(event => event.seq === atSeq && event.type === 'turn/end')
    if (!boundary) throw new Error('只能从已完成的一轮对话撤回')
    const prefix = events.filter(event => Number(event.seq) <= Number(atSeq))
    if (!prefix.length) throw new Error('撤回位置没有可继承的会话事件')
    const header = await existingSessionHeader(ctx, sessionId)
    const selection = ctx.get('agentDefaultModel')
    const current = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : null
    const childSessionId = `${matrixId}-r${Date.now().toString(36)}`
    const seed = [
      ...prefix,
      { type: 'session/end-seed', seq: Number(atSeq) + 1, time: boundary.time, data: { inherited: true } },
    ]
    const handle = await ctx.agents.create({
      sessionId: childSessionId,
      seed,
      inheritedEventCount: Number(atSeq) + 1,
      meta: {
        ...(header && header.cwd ? { cwd: header.cwd } : {}),
        parentSession: sessionId,
        isSeeded: true,
      },
      ...(current && current.provider && current.model
        ? { agentOptions: { provider: current.provider, model: current.model } }
        : {}),
      setup: agentCtx => mountMatrixPreset(ctx, agentCtx, bindingBrief({ sessionId: matrixId, title, task }), {
        sessionId: childSessionId, askUserQuestion,
      }),
    })
    const previous = forkedAgents.get(matrixId)
    if (previous && previous !== handle) {
      try { await previous.dispose() } catch {}
    }
    forkedAgents.set(matrixId, handle)
    return {
      session_id: childSessionId,
      at_seq: Number(atSeq),
      at: new Date(boundary.time).toISOString(),
    }
  }
  const agentRunner = createAgentRunner(ctx, managedSessions, {
    mode: 'readonly', prefix: 'rms-flow-agent', workspaceProvider,
  })
  const codingAgentRunner = createAgentRunner(ctx, managedSessions, {
    mode: 'coding', prefix: 'rms-flow-code', workspaceProvider,
  })

  /**
   * 从 checkpoint 快照事件重建一个 dsh 会话（新 id），供项目恢复使用。
   * 旧会话保留在侧栏，项目/matrix 记录改绑到新会话。
   */
  const seedSessionFromSnapshot = async ({ sessionId, events, cwd, title, task, brief, matrixId, parentSessionId }) => {
    const sourceId = String(sessionId || '').trim()
    const list = Array.isArray(events) ? events : []
    if (!sourceId) throw new Error('sessionSeed 需要 sessionId')
    if (!list.length) throw new Error('快照没有可重建的会话事件')
    const newId = `${sourceId}-ck${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    const lastSeq = list.reduce((max, event) => Math.max(max, Number(event && event.seq) || 0), 0)
    const seed = [...list, { type: 'session/end-seed', seq: lastSeq + 1, time: Date.now(), data: { inherited: true } }]
    const selection = ctx.get('agentDefaultModel')
    const current = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : null
    const text = brief || bindingBrief({ sessionId: matrixId || sourceId, title, task })
    const handle = await ctx.agents.create({
      sessionId: newId,
      seed,
      inheritedEventCount: lastSeq + 1,
      meta: {
        ...(String(cwd || '').trim() ? { cwd } : {}),
        ...(parentSessionId ? { parentSession: parentSessionId } : {}),
        isSeeded: true,
      },
      ...(current && current.provider && current.model
        ? { agentOptions: { provider: current.provider, model: current.model } }
        : {}),
      setup: agentCtx => mountMatrixPreset(ctx, agentCtx, text, {
        sessionId: newId, askUserQuestion, bindId: matrixId || sourceId,
      }),
    })
    forkedAgents.set(newId, handle)
    return { session_id: newId }
  }

  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    const sessionId = request && request.agent && request.agent.session
      ? String(request.agent.session.id)
      : ''
    const managed = managedSessions.get(sessionId)
    if (!managed) return next()
    const toolName = String(request.toolName || '')
    const allowed = managed.mode === 'coding' ? CODING_TOOLS : READ_ONLY_TOOLS
    if (!allowed.includes(toolName)) return Promise.resolve('rejected')
    const args = request.arguments || request.args || {}
    const candidate = args.file_path || args.workdir
    if (managed.mode === 'coding' && !pathWithin(managed.workspace, candidate)) {
      return Promise.resolve('rejected')
    }
    return Promise.resolve('allowed-once')
  }), 'rms-flow-runner approval policy')

  // Node pipeline 在本机回调 bridge：默认必须指向 dsh 实际监听的地址。
  // 绑定 LAN IP 时 127.0.0.1 并未监听，写死 loopback 会让 llm/agent/tool 全部 fetch failed。
  const bridgeBaseUrl = () => {
    const explicit = String(process.env.RMS_BRIDGE_URL || '').trim()
    if (explicit) return explicit.replace(/\/+$/, '')
    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.port === 'number' && typeof webServer.getOrigin === 'function') {
      try { return `${webServer.getOrigin()}${PANEL_PATH}` } catch {}
    }
    const webApp = ctx.get('webApp')
    if (webApp && typeof webApp.getAdvertisedUrl === 'function') {
      try {
        const url = String(webApp.getAdvertisedUrl() || '').trim()
        if (url) return `${url.replace(/\/+$/, '')}${PANEL_PATH}`
      } catch {}
    }
    return `http://127.0.0.1:3080${PANEL_PATH}`
  }

  const dependencies = {
    agentRunner,
    codingAgentRunner,
    toolRunner: createToolRunner(ctx),
    workspaceProvider,
    sessionMirror: createSessionMirror(ctx, workspaceProvider, askUserQuestion),
    // dsh → matrix：读取绑定会话的事件增量用于归档
    sessionEvents: createSessionEvents(ctx),
    // matrix → dsh：把系统事件/动作/状态回灌会话，保证 dsh 侧看到完整过程
    sessionAppend: createSessionAppend(ctx),
    // 绑定 agent 的实时执行状态（面板转圈/工具提示）
    agentStatus: createAgentStatus(ctx),
    // 面板自然语言输入 → 绑定 agent 会话
    matrixChat: createMatrixChat(ctx, askUserQuestion),
    // 面板回答 / 取消 dsh ask_user_question
    answerUserQuestion,
    cancelUserQuestion,
    cancelUserQuestions,
    // 会话撤回：列出可回退轮次，并从该轮分叉新会话
    rewindPoints,
    forkMatrixSession,
    // 项目 Git checkpoint 恢复：用快照事件重建 dsh 会话
    sessionSeed: seedSessionFromSnapshot,
    // run 终态后释放 ${runId}-llm / ${runId}-tool 会话
    disposeRunAgents,
    // flow_ui 在 dsh 内直接返回常驻路由，不再单独起端口
    panel_path: PANEL_PATH,
    // Node pipeline 回调的 bridge 地址；优先显式环境变量，否则取 dsh 实际监听地址
    bridgeBaseUrl,
  }

  const bridgeHandlers = {
    async llm(body, context) {
      const response = await agentRunner({
        system: body.system || '你是工作流中的 LLM 节点。根据指令和输入生成结果；需要 JSON 时只输出合法 JSON。',
        prompt: body.prompt || '请根据系统约束和输入完成本步骤。',
        input: body.input,
        workspace: join(context.runDir, 'workspace'),
        sessionId: `${context.runId}-llm`,
      })
      return {
        text: String(response && response.text !== undefined ? response.text : ''),
        session_id: (response && response.session_id) || `${context.runId}-llm`,
      }
    },
    async agent(body, context) {
      const response = await codingAgentRunner({
        system: body.system || '你是工作流中的 agent 节点。可以在工作目录内读写文件并调用工具，完成后输出结果。',
        prompt: body.prompt || '请根据系统约束和输入完成本步骤。',
        input: body.input,
        workspace: join(context.runDir, 'workspace'),
        sessionId: `${context.runId}-llm`,
      })
      return {
        text: String(response && response.text !== undefined ? response.text : ''),
        session_id: (response && response.session_id) || `${context.runId}-llm`,
      }
    },
    async tool(body, context) {
      const args = body.args === undefined ? body.input : body.args
      const result = await openToolRunner({ runId: context.runId, dataDir: context.dataDir, name: body.tool, args })
      return { value: result && typeof result === 'object' && 'value' in result ? result.value : result }
    },
    async subflow(body, context) {
      const dataDir = context.dataDir
      if (!body.matrix_id) {
        if (body.definition) {
          throw new Error('subflow inline definition 暂不支持；请使用 matrix_id 引用已完成预构建的子 matrix')
        }
        throw new Error('subflow 节点缺少 matrix_id')
      }
      const matrices = loadAll(dataDir)
      const target = matrices.get(body.matrix_id)
      if (!target) throw new Error(`matrix 不存在：${body.matrix_id}`)
      const state = deriveState(target, matrices)
      // stub 节点要求目标能力已验收；普通子流程沿用 runnable / accepted
      const allowed = body.node_type === 'stub' ? [STATES.ACCEPTED] : [STATES.RUNNABLE, STATES.ACCEPTED]
      if (!allowed.includes(state)) {
        throw new Error(`子 matrix ${target.name}（${target.id}）当前为 ${state}，不可运行`)
      }
      if (body.node_type === 'stub' && body.stub_id && target.domain_binding
        && target.domain_binding.element_type === 'stub'
        && target.domain_binding.element_id !== body.stub_id) {
        throw new Error(`stub 节点契约不匹配：节点引用 ${body.stub_id}，目标 matrix 绑定 ${target.domain_binding.element_id}`)
      }
      const parentRun = body.parent_run_id ? loadRun(dataDir, body.parent_run_id) : null
      const depth = parentRun ? (parentRun.depth || 0) + 1 : 0
      const maxDepth = Math.min(Math.max(Number(process.env.RMS_MATRIX_RUN_MAX_DEPTH) || 8, 1), 32)
      if (depth > maxDepth) {
        throw new Error(`matrix 运行嵌套深度 ${depth} 超过上限 ${maxDepth}（RMS_MATRIX_RUN_MAX_DEPTH）`)
      }
      return runMatrix(dataDir, target.id, {
        input: body.input,
        dependencies,
        parentRun,
        parentNode: parentRun ? { id: body.node_id } : null,
        parentPath: body.path || null,
      })
    },
  }

  dependencies.runBridge = async ({ data_dir, run_id, kind, token, body }) => dispatchBridge({
    dataDir: resolveDataDir(data_dir),
    runId: run_id,
    kind,
    token,
    body,
    handlers: bridgeHandlers,
  })

  core.configure(dependencies)

  // 把工作流面板挂到 dsh Web 的常驻路由上：http(s)://<dsh>/flow-runner-v2/
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], webCtx => {
      webCtx.effect(
        () => webCtx.webServer.register({
          kind: 'prefix',
          path: PANEL_PATH,
          handler: createPanelHandler({ dependencies, prefix: PANEL_PATH }),
        }),
        'rms-flow-runner-v2: resident matrix panel route',
      )
    })
  }

  for (const tool of core.tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
      // exec.agent 是调用方 agent；它的会话 id 就是矩阵 id，用于自动绑定 matrix_id
      execute: (args, exec) => tool.run(args, dependencies, {
        sessionId: exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : null,
      }),
    })
  }
  console.log(`[${core.id}] plugin loaded (${core.tools.length} tools, readonly=${READ_ONLY_TOOLS.join('/')}, coding=${CODING_TOOLS.join('/')})`)
}
