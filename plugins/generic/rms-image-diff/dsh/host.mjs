/**
 * dsh 适配器：把 plugin.mjs 的 tools 注册到 ctx.tools。
 *
 * 与 MCP 平面的差异：harness 的 ImageBlock 需要 attachment 服务持有的引用
 * （见 packages/llm/llm/src/types.ts 的 ImageBlock），且生产适配器声明文本输出，
 * 因此 dsh 工具结果只承载文本块。这里把 render 产出的图片块投影掉，
 * 热力图仍会落盘，其路径已写在文本报告里。
 *
 * @module rms-image-diff/dsh-host
 */

import * as core from '../plugin.mjs'

/** 插件标识，供 Loader 行与日志识别。 */
export const name = core.id

/** 依赖的服务：工具注册表就绪后再调用 apply。 */
export const inject = ['tools']

/**
 * 把内容块投影为 dsh 可承载的形状（仅保留文本块）。
 * @param {object[]} blocks MCP 形状的内容块
 * @returns {object[]}
 */
function toDshBlocks(blocks) {
  return blocks.filter(block => block?.type === 'text')
}

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
      output: {
        schema: tool.output.schema,
        render: (args, value) => toDshBlocks(tool.output.render(args, value)),
      },
      execute: args => tool.run(args),
    })
  }
  console.log(`[${core.id}] plugin loaded (${core.tools.length} tools)`)
}
