# matrix_harness

> 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 能力演化平台。

把「agent 的能力调整」从不可见的参数空间，搬到可见、可版本化、可复用的工程产物上：用 **matrix** 承载执行与验收，用 **domain** 承载问题边界与会话组，用 **model / stub / interact** 承载接口层契约，用**导出 / 导入**承载能力的遗传与组合。

完整的理论推导见 [docs/project-thesis.md](docs/project-thesis.md)。

## 核心理念

本项目的设计由一条主线贯穿，从计算模型出发，最终落到一套可运行的工程系统：

1. **概率图灵机视角**：单纯 LLM 不是图灵机，`harness + LLM` 组成的 agent 才是。后训练调整的是藏在参数里的隐式权重，harness 调整的是摆在工程产物上的显式权重。
2. **能力演化**：会话组是最小演化单元，领域是种群、会话是个体。能力通过「生成—运行—验收—沉淀」的闭环被选择并保留下来。
3. **组织是核心**：自动分组、领域边界、接口契约决定了一个 agent 能否稳定拆解、回收并复用问题——这归根到底是组织问题。
4. **接口层是入口**：用领域驱动设计把设计粒度从「汇编层」提升到「接口层」，先约定 `request/response`，再组织实现。

这些理念最终落地为下面这套组件，其中 `rms-flow-runner-v2` 是 `matrix` / `domain` / `model` / `stub` / `interact` / 导出的核心实现。

## 目录结构

```
matrix_harness/
├── deepseek-harness/        # DeepSeek 官方 agent harness（上游，MIT），作为宿主运行时
├── plugins/
│   ├── generic/             # 通用能力插件
│   └── project/             # 项目特定插件
├── mcp/                     # 聚合 MCP server，把全部插件工具暴露为 MCP
├── dsh/                     # 项目级 dsh 覆盖层（cordis.yml），登记插件 host 适配器
├── docs/                    # 设计文档与工作日志
└── README.md
```

## 组件

### deepseek-harness

本项目的宿主运行时是 DeepSeek 开源的 agent harness（`@deepseek-ai/dsh-*`），一个 all-plugin 的 Cordis agent 框架。它提供会话、模型、工具、子进程、SSH、浏览器/计算机使用、工作流等基础设施，本项目以插件形式在其上扩展。

### 通用插件（plugins/generic）

| 插件 | 职责 |
| --- | --- |
| `rms-flow-runner-v2` | 核心：matrix（执行/验收）、domain（问题边界/model/stub/interact 契约）、导出/导入 |
| `rms-flow-runner` | 早期流程运行器（已停止 dsh 常驻，被 v2 取代） |
| `rms-domain-registry` | 领域注册表：领域列表、获取、能力发现 |
| `rms-worklog` | 工作日志：记录、检索、统计、待办提取 |
| `rms-dsh-devkit` | 插件开发工具：分类、脚手架、校验 |
| `rms-dsh-starter` | 起步示例插件 |
| `rms-image-diff` | 像素级图片比对（截图 / UI 回归） |
| `rms-wechat-session` | 微信会话接入 |
| `rms-dingtalk-session` | 钉钉会话接入 |

### 项目插件（plugins/project）

| 插件 | 职责 |
| --- | --- |
| `rms-front-service` | 前端服务 |

### MCP 服务（mcp）

`mcp/server.mjs`（`rms-dsh-mcp`）是一个聚合 MCP server，把上述全部插件的工具按插件名分派，统一暴露为 MCP 工具，供外部 agent / IDE 调用。

## 快速开始

### 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.28.5`

### 安装与运行宿主

```sh
cd deepseek-harness
pnpm install
pnpm run build
```

以项目覆盖层加载本项目插件：

```sh
# cwd 必须是 deepseek-harness/
pnpm dsh --profile web --patch "../dsh/cordis.yml" --dump-config
"" | pnpm dsh acp --patch "../dsh/cordis.yml"
```

### 启动 MCP 服务

```sh
cd mcp
node server.mjs
```

## 文档

- [docs/project-thesis.md](docs/project-thesis.md) — 核心设计思想与推导
- [docs/dsh-plugin-spec.md](docs/dsh-plugin-spec.md) — 插件规范
- [docs/rms-dsh-mcp.md](docs/rms-dsh-mcp.md) — MCP 服务说明
- [docs/domain-capability-plan.md](docs/domain-capability-plan.md) — 领域能力规划
- [docs/llm-session-recursive-model.md](docs/llm-session-recursive-model.md) — 会话递归模型
- [docs/rms-flow-runner-v2-*.md](docs/) — flow-runner-v2 运行时与 fanout/merge 机制

## 许可证

本项目（`matrix_harness` 自身的插件、MCP 服务、文档与配置）采用 **MIT** 许可证，详见 [LICENSE](LICENSE)。

`deepseek-harness/` 目录为 DeepSeek 的上游项目，同样采用 MIT 许可证（见 [deepseek-harness/LICENSE](deepseek-harness/LICENSE)）。