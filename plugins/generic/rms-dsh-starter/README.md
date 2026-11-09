# rms-dsh-starter（通用插件 · 骨架示例）

用于验证插件骨架在 **dsh 平面**与 **MCP 平面**都已正确接通的最小插件。规约见
[`docs/dsh-plugin-spec.md`](../../../docs/dsh-plugin-spec.md)。

## 文件

| 文件 | 角色 |
|---|---|
| `plugin.mjs` | 可移植清单 + 零依赖实现：`id` / `kind` / `description` / `tools` |
| `dsh/host.mjs` | dsh 适配器：把 `tools` 循环注册到 `ctx.tools` |
| `dsh/service.mjs` | dsh 专有服务：`ctx.provide('starterService', …)`，供其它插件 `inject: ['starterService']` |

## 工具

| 工具名（dsh / MCP） | 说明 |
|---|---|
| `starter_echo` / `rms-dsh-starter__starter_echo` | 把传入的 `text` 原样回显 |

## 接入

dsh 侧不做目录内登记，统一由项目覆盖层 [`dsh/cordis.yml`](../../../dsh/cordis.yml) 承担。
在 harness 检出目录（`deepseek-harness/`）下执行：

```powershell
# 只打印组合后的 profile 树并退出
pnpm dsh --profile web --patch "C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml" --dump-config

# 冒烟：ACP profile 无需 Web 产物，stdin 关闭即退出
"" | pnpm dsh acp --patch "C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml"
```

启动日志应出现：

```text
[rms-dsh-starter] service starterService provided
[rms-dsh-starter] plugin loaded (1 tools)
```

MCP 侧由聚合 server 自动扫描，无需登记：

```powershell
node "C:/Users/admin/Documents/trae_projects/rms_dsh/mcp/server.mjs"
```

## 备注

- 函数式插件具名导出 `name` / `inject` / `apply`（可选 `Config`），**不能**再有 default 导出，否则 Loader 会丢弃函数插件的命名空间。
- 仓库外插件**不能**用 `@deepseek-ai/*` 裸导入：tsx 按「最近的 tsconfig」解析 `paths`，仓库外的文件拿不到 harness 的映射。故一律零依赖 `.mjs`。
- 所有注册（`ctx.on()` / `ctx.tools.register()` / `ctx.provide()`）都是 effect，插件卸载时自动撤销。
