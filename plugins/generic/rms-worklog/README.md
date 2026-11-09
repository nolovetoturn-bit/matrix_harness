# rms-worklog（通用插件）

把会话里的工作内容沉淀为**结构化工作日志**，并提供检索、统计、索引重建能力。供任意 Trae 会话中的 Agent 在用户说「记一下日志 / 查一下之前做过什么」时调用。

- **唯一真源**：每篇日志 = 一个 Markdown 文件（人可读、可 git 版本化）。
- **索引**：SQLite（Node 内置 `node:sqlite`）+ FTS5 `trigram`，可从 Markdown 全量重建。
- **待办提取**：正文里的 `- [ ]` 复选框与「待办 / 下一步 / TODO」小节列表项进入 `entry_todos`，可用 `worklog_todo` 查看与勾选。
- **日志管理员 LLM**：`worklog_review` / `worklog_ask` 在**插件进程内部**完成检索、拼上下文与推理，只把蒸馏结论返回给调用方会话，因此日志上下文与其它会话相互独立。
- **零外部依赖**：不引入向量库、不装 npm 包；LLM 只走 `fetch`（OpenAI 兼容 `/chat/completions` 或 DeepSeek Messages `/v1/messages`）。
- **默认复用 dsh 的 LLM**：自动读取 `$DSH_HOME/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`，使用 dsh 同款端点与 `deepseek-flash`，无需额外配置。

规约见 [`docs/dsh-plugin-spec.md`](../../../docs/dsh-plugin-spec.md)。

## 数据存放

解析优先级（第一个非空生效）：

1. 环境变量 `RMS_WORKLOG_DIR`（测试/临时切换用）
2. `worklog_config` 写入的 `config.data_dir`（配置文件在 `%LOCALAPPDATA%\rms-worklog\config.json`）
3. 当前工作目录所属 git 仓库的 `docs/worklogs`
4. `%LOCALAPPDATA%\rms-worklog\data`

目录结构：

```
<data_dir>/
├── 2026/10/2026-10-21/
│   └── 20261021T154012-a1b2.md     # 一篇日志一个文件
└── .index/
    └── worklog.db                  # 可删除、可重建的索引
```

日志文件格式（首行是元信息，正文为 Markdown）：

```markdown
<!-- worklog {"id":"20261021T154012-a1b2","date":"2026-10-21","created_at":"2026-10-21T15:40:12+08:00","title":"...","project":"rms_dsh","kind":"done","tags":["worklog"],"people":[],"source":"trae-session:xxx"} -->

正文……
```

写入采用「临时文件 + rename」原子落盘，先写文件再更新索引；索引损坏或换机后调 `worklog_reindex` 重建即可。

## 文件

| 文件 | 角色 |
|---|---|
| `plugin.mjs` | 工具契约与渲染（10 个工具），dsh / MCP 两平面共用 |
| `lib/store.mjs` | Markdown 读写、SQLite 索引、待办提取、检索、统计、重建 |
| `lib/llm.mjs` | 零依赖 LLM 传输层：OpenAI 兼容（`/models`、`/chat/completions`）与 DeepSeek Messages（`/v1/messages`） |
| `lib/logkeeper.mjs` | 日志管理员：内部检索 + 固定 prompt + JSON 输出契约 + 降级 |
| `dsh/host.mjs` | dsh 适配器：把 `tools` 注册到 `ctx.tools` |

## 工具

| 工具 | 必填 | 可选 | 说明 |
|---|---|---|---|
| `worklog_add` | `title`, `content` | `date`, `project`, `kind`, `tags[]`, `people[]`, `source`, `force` | 写入一篇日志；`date+title+content` 相同自动去重 |
| `worklog_search` | — | `query`, `from`, `to`, `project`, `kind`, `tags[]`, `people[]`, `limit` | 关键词 + 元数据过滤；多词空格分隔、全部命中 |
| `worklog_get` | `id` | `neighbors`（0-5） | 读全文；优先读磁盘文件，缺失时用索引副本 |
| `worklog_recent` | — | `days`, `limit`, `project` | 最近 N 天条目，用于日报/周报素材 |
| `worklog_stats` | — | `from`, `to`, `project`, `group_by` | 总数 + 按 `project`/`tag`/`kind`/`month` 分组计数 |
| `worklog_todo` | — | `action`（list/done）, `todo_id`, `days`, `limit`, `project` | 列出未完成待办；`done` 把源 Markdown 勾选并同步索引 |
| `worklog_review` | — | `days`, `project` | 「现在该干嘛」：插件内部 LLM 输出优先任务 + 待用户确认的问题 |
| `worklog_ask` | `question` | `query`, `from`, `to`, `project` | 日志问答：插件内部检索 + LLM 作答，只回结论与引用 |
| `worklog_reindex` | — | — | 从 Markdown 全量重建索引 |
| `worklog_config` | — | `set.data_dir`, `set.llm_base_url`, `set.llm_model`, `set.llm_api_key`, `set.llm_timeout_ms`, `set.llm_protocol` | 查看状态 / 修改数据目录与 LLM 配置 |

## 日志管理员（LLM 在插件内部）

`worklog_review` 与 `worklog_ask` 不把日志原文交给调用方会话，而是在插件进程里完成：

```
Markdown/索引 → 插件内部检索 → 截断后的材料 → LLM → JSON 契约 → 蒸馏结论
```

- **上下文隔离**：调用方只收到 `summary` / `tasks` / `questions` 或 `answer` / `citations`，不接触原始日志全文。
- **默认后端（复用 dsh）**：`llm_base_url` / `llm_model` / `llm_api_key` 全留空时，自动读 `$DSH_HOME/.credentials.yaml`（`DSH_HOME` 缺省为 `~/.dsh`）的 `DEEPSEEK_API_KEY`，端点 `https://api.deepseek.com/anthropic`，模型 `deepseek-flash`，协议自动识别为 `anthropic`（Messages）。dsh 里换 key 或换模型时，插件下次调用即跟随。
- **自定义后端**：仍支持任何 OpenAI 兼容接口与自建模型，填 `llm_base_url`（如 Ollama `http://127.0.0.1:11434/v1`）即可；`llm_protocol` 默认 `auto`，按 URL 是否以 `/anthropic` 结尾切换，也可强制 `anthropic` / `openai`。OpenAI 协议下 `llm_model` 留空会自动取 `/models` 的第一个。
- **配置优先级**：环境变量 `RMS_WORKLOG_LLM_BASE_URL` / `RMS_WORKLOG_LLM_MODEL` / `RMS_WORKLOG_LLM_API_KEY` / `RMS_WORKLOG_LLM_PROTOCOL` / `RMS_WORKLOG_LLM_TIMEOUT_MS` > `worklog_config` 的 `set` > dsh 托管凭据与默认端点 > 本机 Ollama。
- **降级**：连接失败、超时或输出不是合法 JSON 时，`worklog_review` 返回确定性待办列表，`worklog_ask` 返回命中标题与 id，功能不中断。
- **可训练接口**：两个工具的 prompt 与输出 JSON 结构固定（`review`: `summary/tasks/questions`；`ask`: `answer/citations/confidence`），后续自训小模型只需对齐同一 contract，直接替换 `llm_model` 即可。

## 待办提取规则

- 任意位置的 `- [ ] 文本` / `* [ ] 文本` / `1. [ ] 文本`；`[x]` 视为已完成。
- 「待办 / 下一步 / TODO / Next / Action Items / 未完成」标题下的普通列表项，视为未完成（无复选框，勾选时自动补成 `- [x]`）。
- 其他小节里的普通列表项不提取，避免把正文要点误判为任务。
- 勾选用 `worklog_todo action=done todo_id=<entryId>#<seq>`；`seq` 是该条目内待办的出现顺序（含已完成项）。

## 检索语义

- **长词（≥3 字）**：走 FTS5 `MATCH`，每个词加引号短语并用 `AND` 连接，按 `bm25`（标题权重 6、标签 2、正文 1）排序。
- **短词（1-2 字）**：`unicode61` 与 `trigram` 都无法可靠切分，改用 `LIKE` 子串匹配。
- **回退**：FTS 命中为空时整体退回 `LIKE`，避免分词边界导致漏检。
- **元数据过滤**：日期区间（含端点）、`project` / `kind` 精确匹配，`tags` / `people` 为 AND 语义。

## 与其他会话协作

跨会话写日志由全局 skill `rms-dsh-capabilities` 规定：Agent 先提炼 `title` / `content` / `project` / `kind` / `tags` 再调用 `worklog_add`，不要在用户未要求时批量补写历史。检索优先 `worklog_search`，需要全文再 `worklog_get`。

用户问「现在该干嘛 / 接下来做什么」时，Agent **只调用 `worklog_review` 并把 tasks/questions 转述给用户选择**，不要自行读取全部日志再在本会话里推理——这样日志上下文留在插件侧。用户选定后用 `worklog_add` 记一条 `kind=decision`，完成后用 `worklog_todo action=done` 勾选。

## 限制

- 不做语义/向量检索（关键词 + 元数据，加 LLM 综合）；日志量很大时后续可加 embedding。
- LLM 能力取决于所配后端；小模型对长材料与 JSON contract 的遵循度可能不足，届时需按 contract 微调。
- 索引与 Markdown 不强一致：手工编辑 `.md` 后需 `worklog_reindex`。
- `node:sqlite` 在 Node 24 仍为实验特性，首次打开会打印 `ExperimentalWarning`，不影响功能。
- 单进程写入为主；并发写靠 `busy_timeout` 与 `BEGIN IMMEDIATE` 串行化，不保证跨机同步。
