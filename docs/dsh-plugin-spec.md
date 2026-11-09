# dsh 插件开发规约（matrix_harness）

本规约规范本项目内所有 dsh 插件的分类、目录结构、代码契约、双平面暴露方式与验收标准。
任何来自其它会话的插件开发需求，都必须先按本规约分类，再按本规约落地。

---

## 0. 前置事实（不可绕过）

- 本项目把 `deepseek-harness` 作为子项目（`deepseek-harness/`）。**全新检出后必须先 `pnpm run build:artifacts`**，否则任何 profile 启动都会报 `typert-loader` / `ERR_MODULE_NOT_FOUND`。
- **仓库外插件不能裸导入 `@deepseek-ai/*`**：`tsx` 按「文件最近的 tsconfig」解析 paths，仓库外的文件拿不到 harness 的 paths 映射，实测报 `Cannot find module '@deepseek-ai/dsh-tools'`。因此插件一律**零依赖 `.mjs`**，只允许 `node:` 内置导入与相对路径导入。
- harness 只自带 MCP **客户端**（`packages/mcp/mcp-client`），没有 MCP **服务端宿主**；对外暴露 MCP 由本项目的聚合 server 自行承担。
- 所有 dsh 侧注册（`ctx.tools.register` / `ctx.on` / `ctx.provide`）都是 effect，插件卸载时自动撤销。

---

## 1. 插件分类判定

对每个需求，按顺序回答三个问题：

| # | 判据 | 结论 |
|---|---|---|
| 1 | 是否依赖本项目特有的领域知识、数据、路径或业务流程（rms 业务实体、项目目录约定、专有配置）？ | 是 → **project** |
| 2 | 是否跨项目/跨仓库可原样复用，只依赖通用能力（文本、文件、HTTP、通用算法）？ | 是 → **generic** |
| 3 | 边界不清时 | 默认 **generic**；只有当「脱离项目上下文就会给出错误结果」时才降级为 **project** |

落位：

```
plugins/generic/<id>/      # 通用插件
plugins/project/<id>/      # 面向项目的特定插件
```

- `<id>` 为 kebab-case，且必须与 `plugin.mjs` 导出的 `id` 完全一致、与目录名一致。
- 所有 id 以 `rms-` 起头，避免与 dsh 内置插件行冲突。
- MCP 工具名全局唯一：`<tool.name>`（snake_case），跨插件不得重名。

---

## 2. 目录与文件契约

每个插件目录：

| 文件 | 必需 | 作用 |
|---|---|---|
| `plugin.mjs` | 是 | **可移植清单 + 零依赖实现**。唯一权威定义，两平面共用 |
| `dsh/host.mjs` | 是 | dsh 适配器：把 `plugin.mjs` 的 tools 注册到 `ctx.tools` |
| `README.md` | 是 | 用途、工具清单、两平面接入方式、验证命令 |
| `dsh/service.mjs` | 否 | dsh 专有服务（`ctx.provide`），仅供其它 dsh 插件 `inject` 使用 |

**不设** `cordis.yml`：dsh 侧登记统一由项目级覆盖层 `dsh/cordis.yml` 承担（见 §5），插件目录内不放覆盖层，避免同一插件出现两份登记源。

---

## 3. `plugin.mjs` 契约（硬性）

纯 ESM，**零依赖**：只允许 `node:` 前缀的内置导入，**禁止任何裸包导入**、禁止 `@deepseek-ai/*`、禁止访问 `ctx`。

必须导出：

```js
export const id = 'rms-example'            // kebab-case，= 目录名
export const kind = 'generic'               // 'generic' | 'project'
export const description = '一句话说明'      // 供聚合 server 与文档使用
export const tools = [ /* Tool[] */ ]
```

`Tool` 形状（两平面共用的唯一契约）：

```js
{
  name: 'example_echo',                     // snake_case，全局唯一
  description: '模型可读的用途说明',
  parameters: {                             // JSON Schema 根对象，type 必须为 'object'
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
  output: {
    schema: { type: 'string' },             // run() 返回值的 JSON Schema（dsh 侧使用）
    render: (args, value) => [{ type: 'text', text: String(value) }],  // 投影为内容块
  },
  run(args) {                               // 纯函数式，无宿主依赖
    return args.text
  },
}
```

要点：

- `run` **不接收 `ctx`**。需要 dsh 服务或会话状态的逻辑属于 dsh 专有实现，放 `dsh/` 侧，不要污染可移植清单。
- `render` 的返回即 **MCP content blocks**，dsh 侧 `output.render` 期望同样的形状，故两平面共用一份 `render`。
- `description` 末尾补「触发场景 + `Keywords:`」中英文触发词：MCP 工具是关键词检索 + 描述驱动选择，词缺了就不会被调用（约定见 `rms-dsh-mcp.md` §6）。

---

## 4. `dsh/host.mjs` 契约

固定模板，只做适配，不写业务逻辑：

```js
import * as core from '../plugin.mjs'

export const name = core.id
export const inject = ['tools']

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
  console.log(`[${core.id}] plugin loaded (${core.tools.length} tools)`)
}
```

已实测可用的 dsh 服务端 API：

- `ctx.tools.register({ name, description, parameters, output: { schema, render(args, value) -> [{type:'text',text}] }, execute(args) })`，`parameters` 为标准 JSON Schema 根对象，原样透传给模型。
- `ctx.on('tools/pre-execute', async (exec, next) => next())`：waterfall，**必须调用 `next()`** 才是放行。
- `ctx.on('session/event', (_session, event) => …)`：只读持久事件，用 `event.type === 'assistant/message'` 判别。
- `ctx.provide(name, value)`：注册服务值（仓库外拿不到 Cordis 的 `Service` 基类），返回 disposer。

---

## 5. 接入当前项目的 dsh

项目级覆盖层 `dsh/cordis.yml` 登记 dsh 适配器（`rms-flow-runner-v2` 例外：登记在 web profile 的 `cordis.patch.yml`，启动 dsh 即自动加载并常驻 `/flow-runner-v2/`；旧版 `rms-flow-runner` 已停止 dsh 常驻；同一插件不得在两处重复登记）：

```yaml
# 叠加在已启动的 dsh profile 之上；name 必须是绝对 file:/// 路径
- insert:
    - id: rms-dsh-starter
      name: 'file:///C:/Users/admin/Documents/trae_projects/rms_dsh/plugins/generic/rms-dsh-starter/dsh/host.mjs'
```

启动与验证（cwd 必须是 `deepseek-harness`）：

```powershell
# 查看合成后的 profile，确认行被插入
pnpm dsh --profile web --patch "C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml" --dump-config
# ACP 冒烟
"" | pnpm dsh acp --patch "C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml"
```

> harness 自带的 `cordis-plugin-development` skill 走的是 `plugin_manager install_bundle`（bundle + profile 目录写入）路径；本项目一律走 `--patch` + 项目内覆盖层，skill 仅作 API 参考。

---

## 6. MCP 平面：单个聚合 server

`mcp/server.mjs`：**单进程 stdio server**，启动时扫描 `plugins/generic/*` 与 `plugins/project/*`，动态 `import` 各 `plugin.mjs`，把 tools 注册为 MCP 工具。

- **分派规则**：MCP 工具名 = `<plugin.id>__<tool.name>`（双下划线分隔），插件名即命名空间。
- **schema 桥接**：`plugin.mjs` 的原始 JSON Schema 经 SDK 的 `fromJsonSchema()` 包装后传给 `registerTool`，因此插件侧仍然零依赖、无 zod。
- **结果映射**：`async args => ({ content: tool.output.render(args, await tool.run(args)) })`。
- 依赖（仅 `mcp/` 目录）：`@modelcontextprotocol/server@2.2.0`。stdio 无需 `@modelcontextprotocol/node`。

```powershell
node "C:/Users/admin/Documents/trae_projects/rms_dsh/mcp/server.mjs"   # 由 MCP 客户端通过 stdio 拉起
```

接入方式（任选其一）：

- 在会话的 MCP 客户端配置里以 stdio 方式挂载该脚本；
- 或经 harness 的 `dsh-mcp-client` 把本 server 的工具再注册回某个 dsh profile。

---

## 7. 标准工作流

| 步 | 动作 | 产出 |
|---|---|---|
| 1 | 收需求，明确要暴露的能力与调用方 | 需求摘要 |
| 2 | 按 §1 三问判定 `generic` / `project` | 结论 + 理由 |
| 3 | 在 `plugins/<kind>/<id>/` 落地 `plugin.mjs` + `dsh/host.mjs` + `README.md` | 插件骨架 |
| 4 | 在 `plugin.mjs` 实现 `tools`（`run` / `render` / `parameters`） | 实现 |
| 5 | 在 `dsh/cordis.yml` `insert` 登记 `dsh/host.mjs` | 登记完成 |
| 6 | 跑 §8 的两条验证命令 | 验证证据 |
| 7 | 补 `README.md`（用途 / 工具 / 两平面接入 / 验证命令） | 交付 |

`rms-dsh-devkit` 插件把第 2、3、6 步做成了工具（`classify_plugin` / `scaffold_plugin` / `validate_plugin`），可通过 MCP 或 dsh 直接调用。

---

## 8. 验收标准（DoD）

一个插件算完成，当且仅当：

1. `plugin.mjs` 通过 `validate_plugin`：零依赖、导出齐全、工具名唯一、`parameters` 根为 `object`、`output.render` 存在。
2. **dsh 平面**：`--dump-config` 能看到插入行；ACP 冒烟日志出现 `[<id>] plugin loaded`；至少一个工具经 `ctx.tools.register` 成功注册且可被模型调用。
3. **MCP 平面**：`mcp/server.mjs` 以 stdio 握手成功，`tools/list` 列出 `<id>__<tool>`，至少一次 `tools/call` 返回非错误内容块。
4. `README.md` 写明用途、工具清单、两平面接入方式与验证命令。

---

## 9. 不变量清单（自查用）

- [ ] 没有 `@deepseek-ai/*` 或任何裸包导入出现在 `plugins/**/*.mjs`
- [ ] `plugin.mjs` 不含宿主绑定（不 import cordis、不出现 `ctx`）
- [ ] `id` == 目录名，且以 `rms-` 起头
- [ ] `dsh/cordis.yml` 中该插件只有一行，指向 `dsh/host.mjs` 的绝对 `file:///` 路径
- [ ] 工具名在全部插件范围内唯一
