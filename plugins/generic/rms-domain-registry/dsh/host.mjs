/**
 * rms-domain-registry — dsh 适配器。
 *
 * 注册只读检索工具；domain_discover 的最终契约复核使用一个受限子会话：
 * 只允许调用 domain_registry_list / domain_registry_get，其余工具全部拒绝。
 */
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import * as core from '../plugin.mjs'

export const name = core.id
export const inject = ['tools', 'agents']

const ALLOWED_TOOLS = ['domain_registry_list', 'domain_registry_get']
const TIMEOUT_MS = Number(process.env.RMS_DOMAIN_DISCOVER_TIMEOUT_MS || 120000)

function assistantText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
}

/**
 * 创建一个只读子会话，把候选契约交给它判断，返回模型原始文本。
 * 子会话不挂 workspace，cwd 使用临时目录；工具白名单 + pre-execute 双重限制。
 */
function createDiscoverReviewer(ctx) {
  return async ({ system, user, parentSessionId }) => {
    if (!ctx.agents || typeof ctx.agents.create !== 'function') {
      throw new Error('dsh agents 服务不可用')
    }
    const sessionId = `domain-discover-${randomUUID().slice(0, 8)}`
    const texts = []
    const dispose = ctx.on('session/event', (session, event) => {
      if (!session || String(session.id) !== sessionId) return
      if (event.type !== 'assistant/message') return
      const text = assistantText(event.data && event.data.message && event.data.message.content)
      if (text) texts.push(text)
    }, { global: true })

    const setup = (agentCtx, agent) => {
      try {
        const visible = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
        const allow = ALLOWED_TOOLS.filter(name => visible.has(name))
        if (allow.length) agentCtx.tools.restrict({ allow })
      } catch {}
      agentCtx.on('tools/pre-execute', (exec, next) => {
        if (ALLOWED_TOOLS.includes(exec.name)) return next()
        return Promise.resolve({
          kind: 'deny',
          reason: `检索子会话只读：不允许使用 ${exec.name}；请只阅读候选契约并输出 JSON`,
        })
      })
    }

    let handle
    let timer
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: tmpdir(),
          ...(parentSessionId ? { parentSession: String(parentSessionId) } : {}),
          origin: 'subagent',
        },
        setup,
      })
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `${system}\n\n【输入】\n${user}` }],
        source: { kind: 'rms-domain-registry' },
      })
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try {
            handle.agent.cancel({ kind: 'hook', reason: 'rms-domain-registry discover timeout' })
          } catch {}
          reject(new Error(`检索子会话超过 ${TIMEOUT_MS}ms 未完成`))
        }, TIMEOUT_MS)
      })
      try {
        await Promise.race([handle.agent.whenIdle(), timeout])
      } finally {
        clearTimeout(timer)
      }
      return texts.length ? texts[texts.length - 1] : ''
    } finally {
      clearTimeout(timer)
      dispose()
      if (handle) await handle.dispose()
    }
  }
}

export function apply(ctx) {
  const dependencies = { reviewWithAgent: createDiscoverReviewer(ctx) }
  for (const item of core.tools) {
    ctx.tools.register({
      name: item.name,
      description: item.description,
      parameters: item.parameters,
      output: item.output,
      execute: (args, exec) => item.run(args, dependencies, {
        sessionId: exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : null,
      }),
    })
  }
  console.log(`[${core.id}] plugin loaded (${core.tools.length} tools, readonly registry only)`)
}
