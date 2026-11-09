# rms-dsh-devkit（通用插件）

把 [`docs/dsh-plugin-spec.md`](../../../docs/dsh-plugin-spec.md) 的插件开发工作流做成可调用工具，
供其它 trae 会话在收到插件开发需求时直接调用。插件自身也按同一份规约实现，且同时接入 dsh 与 MCP 两个平面。

## 文件

| 文件 | 角色 |
|---|---|
| `plugin.mjs` | 可移植清单 + 零依赖实现：`classify_plugin` / `scaffold_plugin` / `validate_plugin` |
| `dsh/host.mjs` | dsh 适配器：把 `tools` 注册到 `ctx.tools` |

## 工具

| 工具名（dsh / MCP 全名） | 说明 |
|---|---|
| `classify_plugin` / `rms-dsh-devkit__classify_plugin` | 按规约 §1 三问判定 `generic` / `project`，给出落位与后续步骤 |
| `scaffold_plugin` / `rms-dsh-devkit__scaffold_plugin` | 按 §2/§3/§4 生成 `plugin.mjs` / `dsh/host.mjs` / `README.md`，并幂等登记进项目覆盖层 |
| `validate_plugin` / `rms-dsh-devkit__validate_plugin` | 按 §8/§9 校验零依赖、id/kind 一致性、工具契约、跨插件重名、覆盖层登记 |

## 典型调用

```jsonc
// 1) 判定
{ "name": "订单导出", "description": "把 rms 订单导出成 csv",
  "touches_project_state": true }

// 2) 生成骨架
{ "id": "rms-order-export", "kind": "project",
  "description": "把 rms 订单导出成 csv",
  "tools": [{ "name": "export_orders", "description": "按时间范围导出订单" }] }

// 3) 校验（省略 id 即校验全部插件）
{ "id": "rms-order-export" }
```

## 接入

dsh 侧由项目覆盖层 [`dsh/cordis.yml`](../../../dsh/cordis.yml) 登记；MCP 侧由 `mcp/server.mjs` 自动扫描。

```powershell
# dsh 冒烟（cwd 必须是 deepseek-harness/）
"" | pnpm dsh acp --patch "../dsh/cordis.yml"

# MCP 平面
node mcp/server.mjs   # 在仓库根目录执行
```

## 备注

- `scaffold_plugin` 只补齐缺失文件，**不覆盖**已存在文件；覆盖层登记按 `id` 幂等。
- 生成的工具 `run()` 是 TODO 桩，调用会抛错——必须先实现再 `validate_plugin`。
