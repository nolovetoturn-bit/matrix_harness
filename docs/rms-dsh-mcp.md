# matrix_harness 插件能力 · MCP 接入总纲

> 本文件是 matrix_harness 插件体系**对外（跨 Trae 会话）暴露 MCP 能力**的唯一权威说明。
> 插件自身的开发规约见 [`dsh-plugin-spec.md`](./dsh-plugin-spec.md)；本文件只回答「别的会话怎么把能力拉起来、怎么调、边界在哪」。

---

## 1. 一句话

本项目所有 dsh 插件的能力都集中在一个 stdio MCP server 里：

```powershell
# 在仓库根目录执行
node mcp/server.mjs
```

任何 Trae 会话（或任何 MCP 客户端）挂上它，即可拿到 `<插件id>__<工具名>` 形式的具名工具——**不需要知道插件怎么实现，也不需要启动 dsh**。

---

## 2. 两个平面（同一份能力，两条出口）

| 平面 | 出口 | 适用对象 | 登记载体 |
|---|---|---|---|
| **dsh 平面** | dsh 工具（`ctx.tools.register`） | **仅本项目**（cwd 在本项目根目录下的 dsh profile） | `dsh/cordis.yml` 项目级覆盖层 |
| **MCP 平面** | MCP 工具 `<id>__<tool>` | **任意 Trae 会话 / 任意 MCP 客户端** | `mcp/server.mjs` 聚合 server |

两者共用同一份 `plugin.mjs`（零依赖、唯一权威定义），不重复实现：

```
plugins/generic/<id>/plugin.mjs   ← 唯一权威清单（零依赖，两个平面共用）
        ├── dsh/host.mjs          → 注册进 dsh 的 ctx.tools
        └── (mcp/server.mjs 扫描) → 暴露为 MCP 工具 <id>__<tool>
```

分派规则：MCP 工具名 = `<plugin.id>__<tool.name>`（双下划线），插件名即命名空间。

---

## 3. 其它 Trae 会话怎么拉起（已配置好）

### 3.1 Trae 全局（推荐，已写入）

文件：`%APPDATA%\Trae CN\User\mcp.json`

```json
"rms-dsh": {
  "command": "node",
  "args": ["<仓库根目录>/mcp/server.mjs"],
  "env": {}
}
```

- `<仓库根目录>` 需替换为本机仓库的绝对路径（MCP 客户端不会以仓库目录为 cwd）。
- 对本机**所有** Trae 会话生效（本项目会话、其它项目会话都能看到 `rms-dsh__*` 工具）。
- 改完后需在 Trae 里**重载 MCP 服务**（或重启 Trae）才会出现新工具。
- 原文件备份：`~/.dsh/_legacy/mcp.json.original`。

### 3.2 其它 MCP 客户端 / 项目级配置

同一段 stdio 配置可直接粘进任何 MCP 客户端的 `mcpServers`（Cursor、Claude Desktop，或 Trae 的项目级 MCP 配置）。server 只依赖 `mcp/node_modules` 中已装好的 `@modelcontextprotocol/server@2.2.0`，**不需要 cwd、不需要额外环境变量**。

### 3.3 自检（不依赖 Trae）

在仓库根目录用 Node 直接与 server 握手（initialize + tools/list）：

```powershell
@'
const { spawn } = require("node:child_process");
const p = spawn(process.execPath, ["mcp/server.mjs"], { stdio: ["pipe","pipe","pipe"] });
let buf = "";
p.stdout.on("data", d => { buf += d;
  if (buf.includes('"id":2')) {
    console.log(buf.split("\n").filter(l => l.includes('"id":2')).join("\n"));
    p.kill();
  }
});
p.stderr.on("data", d => process.stderr.write(d));
const send = o => p.stdin.write(JSON.stringify(o) + "\n");
send({ jsonrpc:"2.0", id:1, method:"initialize", params:{ protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{ name:"probe", version:"1" } } });
send({ jsonrpc:"2.0", method:"notifications/initialized" });
send({ jsonrpc:"2.0", id:2, method:"tools/list" });
'@ | node -
```

期望：stdout 出现 `"id":2` 的回包，`result.tools` 含 §4 表中的全部工具名；stderr 出现 `[rms-dsh-mcp] <id> (<kind>) 已挂载 N 个工具`。

---

## 4. 工具清单（当前）

| MCP 工具名 | 必填参数 | 可选参数 | 说明 |
|---|---|---|---|
| `rms-dsh-starter__starter_echo` | `text` | — | 原样回显；连通性自检用 |
| `rms-dsh-devkit__classify_plugin` | `name`, `description` | `touches_project_state`, `reusable_outside_project` | 按规约 §1 判定 generic / project 并给出落位 |
| `rms-dsh-devkit__scaffold_plugin` | `tools[]`（每项 `name`/`description`） | `id`, `name`, `kind`, `description` | 生成插件骨架，并幂等登记进 `dsh/cordis.yml`；已存在文件不覆盖 |
| `rms-dsh-devkit__validate_plugin` | — | `id` | 校验插件：零依赖、导出与目录一致、工具契约、跨插件重名、覆盖层登记 |
| `rms-image-diff__diff_images` | `image_a`, `image_b` | `tolerance`, `min_region_area`, `max_regions`, `heatmap`, `heatmap_path` | 两图逐像素比对，返回差异统计 + 差异区域包围盒 + 差异热力图 |
| `rms-front-service__rms_front_start` | — | `project_root`, `frontend_dir`, `java_home`, `skip_frontend`, `skip_backend`, `force`, `wait_seconds` | 完整启动 rms-front 本地服务（Vite 5174 + Spring Boot 80）；启动前清理 80/5174 残留实例 |
| `rms-front-service__rms_front_status` | — | `tail` | 进程存活 / 端口监听（含持有者 PID）/ `/rms/ui/` HTTP 探活 / 日志尾部 |
| `rms-front-service__rms_front_stop` | — | — | 结束记录的进程树，并按端口兜底释放 80 / 5174 |
| `rms-front-service__rms_front_logs` | — | `target`, `lines`, `filter` | 读后端/前端日志尾部，支持子串过滤 |
| `rms-wechat-session__wechat_status` | — | `account`, `python_exe` | 微信采集链路体检：进程 / 账号 / SQLCipher 密钥 / 会话数 / 边车环境；**微信多开时列出「实例 ↔ 账号」对应表**（hwnd / pid / 账号目录 / 是否最小化） |
| `rms-wechat-session__wechat_sessions` | — | `limit`, `account`, `python_exe` | 列出本机微信会话（名称、未读数、最近摘要与时间） |
| `rms-wechat-session__wechat_new` | — | `exclude_service`, `min_unread`, `max`, `limit`, `account`, `python_exe` | **新消息检测**：列出有未读的会话（会话名 + 未读数 + 最后摘要与时间）并落盘存档；默认剔除公众号/服务号推送，纯只读、微信最小化也能用 |
| `rms-wechat-session__wechat_fetch` | — | `max_chats`, `limit_per_chat`, `chats[]`, `skip_chats[]`, `account`, `python_exe` | 增量采集会话内容，归一化 NDJSON 落盘（按游标去重） |
| `rms-wechat-session__wechat_backfill` | — | `chats[]`, `max_chats`, `download_media`, `force`, `skip_chats[]`, `account`, `python_exe` | 全量历史回溯：逐会话从最新翻到最老导出 NDJSON，可一并下载图片/语音/视频/文件；按会话幂等、可断点续跑 |
| `rms-wechat-session__wechat_send` | — | `text`, `to`, `image`, `file`, `reply`, `verify`, `quiet`, `account`, `python_exe` | 发送微信消息（文本 / 图片 / 文件）——**UI 自动化**，会占用鼠标键盘并置顶微信，需窗口可见且未锁屏；`quiet=true` 走静默路线（不移动鼠标、不点击、不置顶，微信可被覆盖，仅纯文本且窗口未最小化）；**微信多开时按 `account` 定位对应账号的窗口**（账号目录 ↔ 进程内存 wxId ↔ 窗口 pid），无法唯一匹配则报错不发 |
| `rms-wechat-session__wechat_sync` | — | `action`(`status`/`start`/`stop`/`once`), `account`, `python_exe` | **动态同步调度器（支持微信多开）**：按会话交互频次自适应同步间隔（别人来的 +1 / 自己发的 +3，半衰期衰减，基准 1h、范围 2min–2h、空轮 1.2x 退避）；自动跳过消息免打扰的群（`chat_room_notify=0`，游标不推进）；缺省自动发现并逐个同步本机全部账号（各自独立状态/游标/单例锁，新登录账号下一轮自动纳入），传 `account` 只作用于该账号 |
| `rms-wechat-session__wechat_config` | — | `set`, `account`, `python_exe` | 读写边车配置（账号 / 数据目录 / 回溯条数 / 白名单与跳过会话 / 动态同步参数等） |
| `rms-dingtalk-session__dingtalk_status` | — | `account`, `python_exe` | 钉钉采集链路体检：进程 / 当前账号 / AES 数据库密钥 / 会话数 / 消息分片 / 联系人档案 / 边车环境 |
| `rms-dingtalk-session__dingtalk_sessions` | — | `limit`, `account`, `python_exe` | 列出本机钉钉会话（名称、未读数、成员数、最近摘要与时间）；1:1 会话自动把 uid 解析成昵称 |
| `rms-dingtalk-session__dingtalk_fetch` | — | `max_chats`, `limit_per_chat`, `chats[]`, `skip_chats[]`, `account`, `python_exe` | 增量采集钉钉会话内容，归一化 NDJSON 落盘（按游标 mid 去重） |
| `rms-dingtalk-session__dingtalk_send` | `to`, `text` | `verify`, `wait_ms`, `account`, `python_exe` | 发送钉钉文本消息——**UI 自动化**（还原并置顶钉钉、搜索面板精确点选会话、剪贴板粘贴 + 回车），会占用鼠标键盘；仅支持纯文本；`verify=true` 回读数据库确认落库 |
| `rms-dingtalk-session__dingtalk_config` | — | `set`, `python_exe` | 读写钉钉边车配置（账号 / 数据目录 / 回溯条数 / 白名单与跳过会话等） |
| `rms-worklog__worklog_add` | `title`, `content` | `date`, `project`, `kind`, `tags[]`, `people[]`, `source`, `force` | 写入一篇工作日志（Markdown 条目 + SQLite 索引）；同日期 + 标题 + 正文自动去重；正文 `- [ ]` 会被提取为待办 |
| `rms-worklog__worklog_search` | — | `query`, `from`, `to`, `project`, `kind`, `tags[]`, `people[]`, `limit` | 检索工作日志：关键词（中文子串，多词 AND）+ 时间/项目/类型/标签/人员过滤 |
| `rms-worklog__worklog_get` | `id` | `neighbors` | 读一篇日志全文与元信息，可附带同一天前后条目 |
| `rms-worklog__worklog_recent` | — | `days`, `limit`, `project` | 最近 N 天工作日志，用于日报/周报素材 |
| `rms-worklog__worklog_stats` | — | `from`, `to`, `project`, `group_by` | 日志总数与按 `project`/`tag`/`kind`/`month` 分组计数 |
| `rms-worklog__worklog_todo` | — | `action`(list/done), `todo_id`, `days`, `limit`, `project` | 列出未完成待办；`done` 把源 Markdown 勾选并同步索引 |
| `rms-worklog__worklog_review` | — | `days`, `project` | 「现在该干嘛」：插件内部 LLM 读取待办与最近日志，返回优先级任务与需用户确认的问题；日志原文不回传。默认复用 dsh 的 DeepSeek 凭据（`deepseek-flash`） |
| `rms-worklog__worklog_ask` | `question` | `query`, `from`, `to`, `project` | 日志问答：插件内部检索 + LLM 作答，只返回结论与引用 id；默认复用 dsh 的 DeepSeek 凭据 |
| `rms-worklog__worklog_reindex` | — | — | 从 Markdown 全量重建索引（索引损坏 / 手工改文件 / 换机后） |
| `rms-worklog__worklog_config` | — | `set.data_dir`, `set.llm_base_url`, `set.llm_model`, `set.llm_api_key`, `set.llm_timeout_ms`, `set.llm_protocol` | 查看数据目录、索引路径、条目/待办数与 LLM 配置（含协议与配置来源）；修改存储或覆盖 LLM 后端 |
| `rms-flow-runner__flow_plan` | `task` | `session_id`/`parent_session_id`, `name`, `input`, `experience_query`, `fuel`, `data_dir` | 受理任务并开启会话：先判断信息是否足够，不足则追问（最多 3 轮），再检索经验生成 Workflow IR 草稿与待确认 start 动作；确认前不执行节点 |
| `rms-flow-runner__flow_answer` | `session_id`, `answer` | `data_dir` | 回答澄清问题；信息补足后自动进入规划并生成待确认草稿 |
| `rms-flow-runner__flow_revise` | `session_id` | `task`, `name`, `instruction`, `data_dir` | 启动前修订任务或规划方向并重新生成草稿；已启动会话须走验收 replan |
| `rms-flow-runner__flow_evaluate` | — | `session_id` 或 `run_id`, `data_dir` | 按验收标准评估已结束运行；通过则会话 accepted，不通过只生成待确认 replan 草稿 |
| `rms-flow-runner__flow_start` | `parent_session_id`, `definition` | `name`, `input`, `fuel`, `data_dir` | 从已有 Workflow IR 直接启动运行（手工入口，不经过 Planner），推进到完成、失败或人工挂起 |
| `rms-flow-runner__flow_resume` | `run_id` | `input`, `data_dir` | 人工挂起时注入 input 并继续；普通暂停可不传 input 恢复 |
| `rms-flow-runner__flow_supervise` | `run_id` | `instruction`, `data_dir` | 总会话只读分析运行，生成监督结论及待确认干预建议，不直接控制执行 |
| `rms-flow-runner__flow_confirm` | `run_id`, `action_id`, `approved` | `data_dir` | 批准或拒绝 start/pause/terminate/replan/insert_human；重规划与插入人工创建新版本并保留旧轨迹 |
| `rms-flow-runner__flow_get` | — | `session_id` 或 `run_id`, `data_dir` | 提供 session_id 返回会话视图（阶段、澄清、假设、验收标准、评估、动作）；提供 run_id 返回运行轨迹 |
| `rms-flow-runner__flow_list` | — | `parent_session_id`, `limit`, `data_dir` | 列出工作流会话（含未运行会话）、各版本状态与验收结果 |
| `rms-flow-runner__flow_ui` | — | `port`, `data_dir` | 启动会话驱动三栏面板，支持澄清回答、草稿确认、DAG 预览、验收与 Cin/Cout 查看 |

---

## 5. 调用示例

### 5.1 图片像素级比对

```
rms-image-diff__diff_images
{ "image_a": "C:/path/to/a.png",
  "image_b": "C:/path/to/b.png",
  "tolerance": 8,          // 每通道允许的最大绝对色差，超过才记差异（默认 0=严格相等）
  "min_region_area": 16,   // 丢弃像素数更小的连通域（滤噪）
  "max_regions": 200 }
```

返回两个内容块：

- `text` —— 差异报告（差异率、最大色差、差异区域包围盒表）；
- `image`（`image/png`）—— 差异热力图，蓝→青→绿→黄→红按色差强度着色。

> 输入支持文件路径或 `data:image/png;base64,...` 的 data URL。PNG 走本地零依赖解码；JPEG 走系统转换器（Windows `powershell`/`System.Drawing`、macOS `sips`、Linux ImageMagick）尽力支持。

**两平面图片块差异（重要）**：MCP 平面可直接内联 image 内容块；dsh 平面**只投影文本**（harness 的 `ImageBlock` 需 attachment 引用，仓库外拿不到），因此 dsh 侧会把热力图 PNG 落盘并在报告中给出路径。写插件时 `render` 只需按 MCP content blocks 返回，dsh 适配器自会过滤图片块（见 `plugins/generic/rms-image-diff/dsh/host.mjs`）。

### 5.2 开发一个新插件（用 devkit 走标准工作流）

```
rms-dsh-devkit__classify_plugin   { "name": "日志轮转", "description": "按大小切分本地日志文件" }
rms-dsh-devkit__scaffold_plugin   { "id": "rms-log-rotate", "kind": "generic",
                                    "description": "本地日志轮转",
                                    "tools": [{ "name": "rotate_log", "description": "按大小切分日志文件" }] }
rms-dsh-devkit__validate_plugin   { "id": "rms-log-rotate" }
```

---

## 6. 新增插件后的生效方式

- **MCP 平面：自动生效。** `mcp/server.mjs` 启动时扫描 `plugins/generic/*` 与 `plugins/project/*`，新插件目录出现即挂载；无需改 server、无需改 `mcp.json`。其它会话下一次拉起 server 就能看到新工具。
- **dsh 平面：需手动登记一行。** 在 `dsh/cordis.yml` 的 `insert` 里加该插件 `dsh/host.mjs` 的 `file:///` 绝对路径（用 `scaffold_plugin` 会自动加）。
- 交付前用 `rms-dsh-devkit__validate_plugin` 校验（零依赖、导出齐全、工具名全局唯一、登记在位）。

### 调用优先级约定（勿删）

Trae 侧 MCP 工具是**延迟加载**的：工具名进上下文，但能否被检索到、被模型选中，取决于 `description` 里的词。故：

- 每个工具的 `description` 末尾必须保留「触发场景」中文场景词 + `Keywords:` 英文别名，中英文 prompt 都要能命中；
- `mcp/server.mjs` 的 `SERVER_INSTRUCTIONS` 会随 `initialize` 回包下发，客户端通常注入系统提示 —— 新插件若需强调优先级，把话写进这段文字；
- 全局技能 `~/.trae-cn/skills/rms-dsh-capabilities/SKILL.md` 提供跨项目会话的入口说明（介绍 5 个工具的用法与触发场景）。

### 工具名与缓存（运维事实，排查"读了 SKILL 却调不到工具"）

- **工具名实际形态**：Trae 顶层会话与多数子代理暴露为 `mcp_rms-dsh_<插件id>__<工具名>`（如 `mcp_rms-dsh_rms-image-diff__diff_images`）；`~/.trae-cn/mcps/.../tools/<tool>.json` 里登记的 `name` 是短名 `<插件id>__<工具名>`。写文档/技能时**以工具清单里实际出现的名字为准**。
- **工具清单是 per-workspace × per-agent 的持久缓存**，路径 `~/.trae-cn/mcps/s_<workspace>/<agent>/mcp_rms-dsh/`，配 `SERVER_METADATA.json` 与 `tools/*.json`。它**不会**随插件源码或 `mcp.json` 的改动自动刷新 —— 改完 `description` / 改完 `mcp.json` 后**必须重载窗口或重启 Trae**。
- **读到 SKILL.md ≠ 工具已加载**：SKILL.md 只是提示注入。若该 workspace 的该 agent 缓存里没有 `mcp_rms-dsh`，或缓存里的 `description` 是旧版（缺「触发场景 / Keywords」），模型就既看不到工具、也检索不中。排查时先看该 agent 的 `tools/` 目录是否存在且描述为最新版。

---

## 7. 旧产物边界（隔离区）

旧体系（`~/IdeaProjects/dsh_trae_bridge` 时代的 command-hub / capability-mining / dsh-session-panel / dsh-im）已**整体物理隔离**到：

```
~/.dsh/_legacy/
├── README.txt                     隔离清单（英文）
├── cordis.patch.yml.original      旧 home patch 原件（4 段 insert）
├── mcp.json.original              Trae mcp.json 原件（备份）
├── skills\                        4 个指向旧仓库的 skill 链接
├── sessions\                      旧会话日志（dsh_trae_bridge、dsh_plugins）
├── dsh-session-panel\             旧 host 插件（/panel HTTP + WS 桥）
├── dsh-panel-host\                旧面板宿主日志
├── im\                            旧 dsh-im 实例 A 数据
├── dsh-im-b-home\                 旧 dsh-im 实例 B 的整个 $DSH_HOME
└── trae-memory-dsh-trae-bridge\   旧 Trae 记忆目录（10 个日期目录）
```

隔离后的状态：

- `~/.dsh/cordis.patch.yml` 已重写为 `[]` —— 本机所有 dsh profile 不再加载旧体系任何插件；
- `~/.dsh/skills/` 只保留 `dsh-plugin-dev`（新体系的规约 skill）；
- 旧项目的 Trae 记忆目录、dsh 会话日志已移出活动目录，不再被检索；
- `_legacy` 不在任何 profile / MCP 配置的加载路径上，对本机 dsh 与 MCP **均不生效**。

**恢复方式**：把 `_legacy\` 下条目移回原路径即可，例如
`_legacy\cordis.patch.yml.original` → 覆盖回 `~/.dsh/cordis.patch.yml`。

**未搬动**：旧源码仓库 `~/IdeaProjects/dsh_trae_bridge` 原地保留 —— 它只与旧体系相关，不参与本体系加载；如需一并搬走请明确指示。

---

## 8. 验收命令

```powershell
# ① Trae 全局配置：合法 JSON 且条目在位
(Get-Content "%APPDATA%\Trae CN\User\mcp.json" -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties.Name

# ② MCP 平面：stdio 握手 + tools/list（见 §3.3 探针）

# ③ dsh 平面（cwd 必须是 deepseek-harness\）：日志应出现 [<id>] plugin loaded
"" | pnpm dsh acp --patch "../dsh/cordis.yml"

# ④ 插件契约全量校验（走 MCP 或 dsh 均可）
rms-dsh-devkit__validate_plugin  {}   # 省略 id 即校验全部插件
```

---

## 9. 约束速查（给写插件的会话）

- 插件一律**零依赖 `.mjs`**：只允许 `node:` 内置导入与相对路径导入；禁止裸包导入、禁止 `@deepseek-ai/*`、禁止出现 `ctx`（详见规约 §3）。
- 工具契约：`{ name, description, parameters(JSON Schema 根对象), output: { schema, render }, run(args) }`；`run` 不接收 `ctx`。
- MCP 工具名全局唯一（`<id>__<tool>`），工具内名 `snake_case`。
- 新增 dsh 侧登记只写项目级 `dsh/cordis.yml` 一处，插件目录内不放 `cordis.yml`，避免两份登记源。
- 全新检出 `deepseek-harness` 后必须先 `pnpm run build:artifacts`，否则 profile 启动报模块找不到。
