/**
 * rms-dsh-starter — dsh 专有服务。
 *
 * 其它插件声明 `inject: ['starterService']` 后即可经 `ctx.starterService`
 * 取用。仓库外插件拿不到 Cordis 的 Service 基类，故直接用 `ctx.provide(name, value)`
 * 注册服务值；返回值是 disposer，插件卸载时自动撤销。
 *
 * @module rms-dsh-starter/dsh-service
 */

/** 独立插件行标识（与 host 行分开登记，便于单独启用/禁用）。 */
export const name = 'rms-dsh-starter-service'

/**
 * 注册 `starterService` 服务值。
 * @param {object} ctx Cordis 上下文。
 */
export function apply(ctx) {
  ctx.provide('starterService', {
    /**
     * 生成问候语。
     * @param {string} who 被问候的名字。
     * @returns {string} 问候语文本。
     */
    greet: who => `Hello, ${who}!`,
  })
  console.log('[rms-dsh-starter] service starterService provided')
}
