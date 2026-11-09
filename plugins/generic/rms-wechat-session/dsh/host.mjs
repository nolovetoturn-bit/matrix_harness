/**
 * dsh 适配器：把 plugin.mjs 的 tools 注册到 ctx.tools。
 * 只做宿主绑定，业务逻辑留在 plugin.mjs（见 docs/dsh-plugin-spec.md §4）。
 *
 * @module dsh-host
 */

import * as core from '../plugin.mjs'

/** 插件标识，供 Loader 行与日志识别。 */
export const name = core.id

/** 依赖的服务：工具注册表就绪后再调用 apply。 */
export const inject = ['tools']

/**
 * 注册本插件的全部工具。
 * @param {object} ctx Cordis 上下文；`ctx.tools` 已由 inject 保证就绪。
 */
export function apply(ctx) {
  for (const tool of core.tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
      execute: args => tool.run(args),
    })
  }

  // 动态同步调度器：随插件加载启动，随 ctx 销毁停止（见 lib/scheduler.mjs）。
  // 与 MCP 平面同时加载时由单例锁保证只有一个真正运行。
  let scheduler = null
  try {
    scheduler = core.startSyncScheduler({ owner: 'dsh' })
    if (scheduler && scheduler.running) {
      console.log(`[${core.id}] 动态同步调度器已启动（${(scheduler.accounts || []).join(', ') || scheduler.account}）`)
    } else {
      console.log(`[${core.id}] 动态同步调度器未启动：${(scheduler && scheduler.reason) || '未知原因'}`)
    }
  } catch (err) {
    console.error(`[${core.id}] 动态同步调度器启动失败：${err && err.message ? err.message : err}`)
  }
  ctx.effect(() => () => {
    if (scheduler && typeof scheduler.stop === 'function') {
      try {
        scheduler.stop()
      } catch {
        /* noop */
      }
    }
  })

  console.log(`[${core.id}] plugin loaded (${core.tools.length} tools)`)
}
