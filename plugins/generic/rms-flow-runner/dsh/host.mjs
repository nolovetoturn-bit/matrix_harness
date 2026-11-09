import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import * as core from '../plugin.mjs'
import { createPanelHandler } from '../lib/panel.mjs'

export const name = core.id
export const inject = ['tools', 'agents']

// 面板在 dsh Web 上的常驻路由；随 dsh 进程一起加载，不再需要每次 flow_ui 启动端口
const PANEL_PATH = '/flow-runner'

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
  const live = ctx.agents.get(sessionId)
  if (live) return live.session.header
  const persistence = ctx.get('sessionPersistence')
  return persistence ? (await persistence.stat(sessionId))?.header : undefined
}

function createSessionMirror(ctx, workspaceProvider) {
  return async ({ sessionId, workspace, title, task, parentSessionId }) => {
    if (!ctx.get('workspaceRegistry')) {
      return { session_id: null, path: workspace, workspace_id: null }
    }
    const prepared = await workspaceProvider.ensure({ path: workspace, title })
    const existing = await existingSessionHeader(ctx, sessionId)
    if (existing) {
      await workspaceProvider.attach({ sessionId, path: prepared.path, workspaceId: prepared.workspace_id })
      return { session_id: sessionId, ...prepared }
    }
    const agentPresets = ctx.get('agentPresets')
    let handle
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: prepared.path,
          // 子会话镜像记录父镜像：dsh 侧栏据此把会话渲染成树
          ...(parentSessionId ? { parentSession: parentSessionId } : {}),
        },
        setup: async agentCtx => {
          if (agentPresets) await agentPresets.mount(agentCtx, agentPresets.defaultId)
        },
      })
      handle.agent.session.append('user/message', {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `【Flow 会话镜像】${title || sessionId}\n${task || ''}`.trim() }],
        source: { kind: 'rms-flow-runner' },
      }, { surfaceOp: 'append' })
      await workspaceProvider.attach({ sessionId, path: prepared.path, workspaceId: prepared.workspace_id })
      return { session_id: sessionId, ...prepared }
    } finally {
      if (handle) await handle.dispose()
    }
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
    let handle
    try {
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
        setup: async (agentCtx, agent) => {
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
        },
      })
      if (prepared && !isolated) {
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
  const agentRunner = createAgentRunner(ctx, managedSessions, {
    mode: 'readonly', prefix: 'rms-flow-agent', workspaceProvider,
  })
  const codingAgentRunner = createAgentRunner(ctx, managedSessions, {
    mode: 'coding', prefix: 'rms-flow-code', workspaceProvider,
  })

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

  const dependencies = {
    agentRunner,
    codingAgentRunner,
    toolRunner: createToolRunner(ctx),
    workspaceProvider,
    sessionMirror: createSessionMirror(ctx, workspaceProvider),
    // flow_ui 在 dsh 内直接返回常驻路由，不再单独起端口
    panel_path: PANEL_PATH,
  }
  core.configure(dependencies)

  // 把工作流面板挂到 dsh Web 的常驻路由上：http(s)://<dsh>/flow-runner/
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], webCtx => {
      webCtx.effect(
        () => webCtx.webServer.register({
          kind: 'prefix',
          path: PANEL_PATH,
          handler: createPanelHandler({ dependencies, prefix: PANEL_PATH }),
        }),
        'rms-flow-runner: resident workflow panel route',
      )
    })
  }

  for (const tool of core.tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
      execute: args => tool.run(args),
    })
  }
  console.log(`[${core.id}] plugin loaded (${core.tools.length} tools, readonly=${READ_ONLY_TOOLS.join('/')}, coding=${CODING_TOOLS.join('/')})`)
}
