/**
 * rms-dsh-starter — 可移植清单 + 零依赖实现。
 *
 * 本文件是插件的唯一权威定义，同时供两个平面使用：
 *   - dsh 平面：经 dsh/host.mjs 适配到 ctx.tools；
 *   - MCP 平面：经 mcp/server.mjs 聚合为 `<id>__<tool.name>` 工具。
 *
 * 约束（见 docs/dsh-plugin-spec.md §3）：零依赖，只允许 node: 内置导入与相对路径导入；
 * 不 import cordis、不出现 ctx，宿主绑定一律留在 dsh/ 侧。
 *
 * @module rms-dsh-starter
 */

/** 插件标识，kebab-case，与目录名一致。 */
export const id = 'rms-dsh-starter'

/** 插件类别：通用插件（不依赖本项目领域知识）。 */
export const kind = 'generic'

/** 一句话说明。 */
export const description = '示例插件：用于验证插件骨架在 dsh 与 MCP 两个平面上都已正确接通。'

/** 模型可见工具清单。 */
export const tools = [
  {
    name: 'starter_echo',
    description:
      '把调用方传入的文本原样回显，用于验证插件工具已经注册并可调用。' +
      '触发场景：rms-dsh MCP 连通性自检。' +
      'Keywords: echo, ping, connectivity probe.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要回显的文本' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    run(args) {
      return args.text
    },
  },
]
