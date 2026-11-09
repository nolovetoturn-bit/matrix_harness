/**
 * rms_dsh 聚合 MCP server（stdio）。
 *
 * 单进程，按插件名分派：启动时扫描 plugins/generic/* 与 plugins/project/*，
 * 动态 import 各插件的 plugin.mjs，把每个工具注册为 `<plugin.id>__<tool.name>`。
 *
 * 分派与桥接规则见 docs/dsh-plugin-spec.md §6：
 *   - 工具名 = `<plugin.id>__<tool.name>`，插件名即命名空间；
 *   - plugin.mjs 的原始 JSON Schema 经 SDK 的 fromJsonSchema() 包装（插件侧保持零依赖、无 zod）；
 *   - 结果 = tool.output.render(args, await tool.run(args))，即 MCP content blocks。
 *
 * 启动：node mcp/server.mjs（由 MCP 客户端以 stdio 拉起）。
 *
 * @module rms-dsh-mcp/server
 */

import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ROOTS = ['plugins/generic', 'plugins/project']

/**
 * 扫描插件目录，动态加载各插件的可移植清单。
 * @returns {Promise<Array<{id: string, kind: string, description: string, tools: object[]}>>}
 */
async function loadPlugins() {
  const plugins = []
  for (const rel of PLUGIN_ROOTS) {
    const root = join(projectRoot, rel)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = join(root, entry.name, 'plugin.mjs')
      if (!existsSync(manifest)) continue
      try {
        const mod = await import(pathToFileURL(manifest).href)
        if (typeof mod.id !== 'string' || !Array.isArray(mod.tools)) {
          throw new Error('plugin.mjs 必须导出 id: string 与 tools: Tool[]')
        }
        plugins.push({ ...mod, dir: rel, manifest })
      } catch (error) {
        console.error(`[rms-dsh-mcp] 跳过 ${rel}/${entry.name}：${error.message}`)
      }
    }
  }
  return plugins
}

/**
 * 注册全部插件工具，并在插件名冲突/工具名重复时保持确定性。
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {Awaited<ReturnType<typeof loadPlugins>>} plugins
 * @returns {string[]} 已注册的 MCP 工具全名
 */
function registerPlugins(server, plugins) {
  const registered = []
  for (const plugin of plugins) {
    for (const tool of plugin.tools) {
      const fullName = `${plugin.id}__${tool.name}`
      if (registered.includes(fullName)) {
        console.error(`[rms-dsh-mcp] 工具名重复，已跳过：${fullName}`)
        continue
      }
      server.registerTool(
        fullName,
        {
          title: `${plugin.id} · ${tool.name}`,
          description: `[${plugin.id}] ${tool.description}`,
          inputSchema: fromJsonSchema(tool.parameters),
        },
        async args => ({
          content: tool.output.render(args, await tool.run(args)),
        }),
      )
      registered.push(fullName)
    }
    console.error(`[rms-dsh-mcp] ${plugin.id} (${plugin.kind}) 已挂载 ${plugin.tools.length} 个工具`)
  }
  return registered
}

// serveStdio 的工厂必须同步返回 server，而插件加载是异步的：
// 故先在模块顶层完成加载，再交给 serveStdio。加载结果按连接复用。
const plugins = await loadPlugins()

// 插件若导出 startSyncScheduler，就在 MCP 进程内启动其常驻同步调度器。
// 单例锁（<account>\sync.lock）保证 dsh 与 MCP 两个平面同时加载时只有一个真正运行。
for (const plugin of plugins) {
  if (typeof plugin.startSyncScheduler !== 'function') continue
  try {
    const r = plugin.startSyncScheduler({ owner: 'mcp' })
    console.error(
      `[rms-dsh-mcp] ${plugin.id} 同步调度器${r && r.running ? `已启动（${(r.accounts || []).join(', ') || r.account}）` : `未启动（${(r && r.reason) || '未知'}）`}`,
    )
  } catch (error) {
    console.error(`[rms-dsh-mcp] ${plugin.id} 同步调度器启动失败：${error.message}`)
  }
}

/**
 * 服务级说明，随 initialize 回包下发；客户端通常注入到系统提示，用于提高调用优先级。
 * @type {string}
 */
const SERVER_INSTRUCTIONS = [
  'rms_dsh 项目的 dsh 插件能力集，工具名形如 `<插件id>__<工具名>`。调用优先级约定：',
  '① 任务涉及「两张图片的像素级比对 / 找不同 / 截图对比 / UI 截图回归比对 / 两个版本渲染结果对比」时，',
  '   优先调用 rms-image-diff__diff_images，不要仅凭肉眼描述差异；',
  '② 任务涉及「新建、生成或校验 dsh 插件」时，优先调用 rms-dsh-devkit__classify_plugin、',
  '   rms-dsh-devkit__scaffold_plugin、rms-dsh-devkit__validate_plugin，并遵循 docs/dsh-plugin-spec.md。',
].join('\n')

serveStdio(() => {
  const server = new McpServer(
    { name: 'rms-dsh-mcp', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  )
  registerPlugins(server, plugins)
  return server
})
