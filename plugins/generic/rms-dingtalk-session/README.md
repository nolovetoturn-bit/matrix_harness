# rms-dingtalk-session（通用插件）

读写本机**钉钉（Windows PC 版）**：解密本地 AES 加密数据库列出会话、增量采集消息、按会话导出 NDJSON；也可经 UI 自动化发送文本消息。

**读库路线**（`dingtalk_status` / `dingtalk_sessions` / `dingtalk_fetch`）是**纯只读**——不驱动钉钉窗口、不改动客户端任何数据，唯一写入的是插件自己的采集产物（NDJSON / 游标）。

> `dingtalk_send` 是**例外**：它走 UI 自动化，会真实驱动钉钉窗口并占用鼠标键盘（见下文「发送」一节）。

规约见 [`docs/dsh-plugin-spec.md`](../../../docs/dsh-plugin-spec.md)。

## 原理与边界

钉钉把会话与消息存在 **AES-128-ECB 整文件加密**的 SQLite 库里：

```
%APPDATA%\DingTalk\<account>_v3\
├── DBFiles\dingtalk.db        会话/消息/联系人档案（整文件加密）
├── DBFiles\dingtalk.db-wal    预写日志（同样是密文帧）
└── user_config                base64(JSON)，含 salt / salt_md5
```

本机实测结论：

- 密钥（16 字节 ASCII）**不在磁盘**，常驻在 `DingTalk.exe` 进程内存的 salt 字符串附近；插件只读扫描进程内存取出，**不需要管理员权限、不需要关闭钉钉**。
- 加密是**整文件 ECB**（含首 16 字节），解密后首 16 字节即 `SQLite format 3\0`；同一份密钥对各表通用。
- 密钥会缓存到 `<data_dir>\<account>\key.json`，命中缓存后不再扫描内存。

> **WAL 关键坑**：WAL 帧的校验和是对**加密页**计算的。若把 `dingtalk.db` 与 `-wal` 分别解密后交给 SQLite，SQLite 会判定校验失败并丢弃整段 WAL —— 表现为「UI 已发送成功但库里查不到新消息」。插件改为按 WAL 帧头页号（`pno`）把解密页**手工覆盖**进主库解密结果，只写合并后的 `dingtalk.db`，不写 `-wal` / `-shm`。

因此本插件依赖一个 Python 边车完成解密读库（Node 侧保持零依赖规约）。

## 读哪个账号

`%APPDATA%\DingTalk` 下可能有多个 `<account>_v3` 目录。默认**自动选最近活跃的账号**（按 `DBFiles\dingtalk.db` 的 mtime 倒序）。

- 任意工具都接受 `account` 参数临时覆盖；`dingtalk_config` 的 `set` 里写 `account` 可持久化默认值。
- 账号名 = `<account>_v3` 目录名（不含 `_v3`）；用 `dingtalk_status` 可确认当前账号与可用账号目录。
- **产物按账号隔离**：所有落盘文件都写到 `<data_dir>\<account>\`（增量 NDJSON、`cursor.json`、`key.json`、调试截图），避免多账号互相串库。

## 文件

| 文件 | 角色 |
|---|---|
| `plugin.mjs` | 可移植清单 + 零依赖实现（参数校验 / 调边车 / 渲染） |
| `dsh/host.mjs` | dsh 适配器：把 `tools` 注册到 `ctx.tools` |
| `scripts/dingtalk_sidecar.py` | Python 边车：取密钥 + 解密读库（含 WAL 合并）+ UI 自动化发送（跑在专用 venv 内） |

两平面共用同一份 `plugin.mjs`；边车以 **JSON 经 stdin/stdout** 与 Node 通信，故不存在 Windows 命令行引号问题。

## 前置：专用 venv

边车依赖 `cryptography`、`psutil`、`uiautomation`（截图调试还用到 `pillow`），装在仓库外的专用 venv 里：

```powershell
python -m venv "$env:USERPROFILE\.wechat-session-venv"
"$env:USERPROFILE\.wechat-session-venv\Scripts\python.exe" -m pip install cryptography psutil uiautomation pillow
```

默认解释器路径写死在 `plugin.mjs` 的 `DEFAULT_PYTHON`；可用每个工具的 `python_exe` 参数覆盖。

## 工具

| MCP 全名 | 说明 |
|---|---|
| `rms-dingtalk-session__dingtalk_status` | 体检：钉钉进程 / 当前账号 / 数据库密钥 / 会话总数 / 消息分片 / 联系人档案 / 边车环境 |
| `rms-dingtalk-session__dingtalk_sessions` | 列出会话（名称、未读数、成员数、最近摘要与时间） |
| `rms-dingtalk-session__dingtalk_fetch` | 增量采集，归一化 NDJSON 落盘 |
| `rms-dingtalk-session__dingtalk_send` | 发送文本（**UI 自动化**，会占用鼠标键盘） |
| `rms-dingtalk-session__dingtalk_config` | 读写边车配置 |

### `dingtalk_fetch` 参数（均可省略）

| 参数 | 默认 | 说明 |
|---|---|---|
| `max_chats` | `0`（全部会话） | 最多采集多少个会话 |
| `limit_per_chat` | `200` | **首次**采集每个会话最多回溯多少条 |
| `chats` | `[]`（全部） | 只采集这些会话（会话名 / 联系人昵称 / cid） |
| `skip_chats` | `[]` | 跳过这些会话（会话名 / 联系人昵称 / cid） |
| `account` | 自动 | 钉钉账号数据目录名 |
| `python_exe` | 专用 venv | 边车解释器路径 |

**增量语义**：每会话维护一个游标（`mid`）。首次采集取最近 `limit_per_chat` 条并把游标推到最新；之后只取 `mid` 之后的新消息。**重复调用不会产生重复数据**，也不会回填首次之前的历史。

### `dingtalk_send` 参数与前提

| 参数 | 默认 | 说明 |
|---|---|---|
| `text` | — | 要发送的文本内容（必填） |
| `to` | — | 目标会话名称（联系人或群名，也可填 cid；必填） |
| `verify` | `false` | 发送后回读数据库确认已落库（建议开启） |
| `wait_ms` | `8000` | 等待搜索面板出结果的最长时间（毫秒） |
| `account` | 自动 | 回读校验用的账号数据目录名 |
| `python_exe` | 专用 venv | 边车解释器路径 |

**UI 自动化流程**：

1. 定位钉钉主窗口（`Qt51511QWindowIcon` / 标题「钉钉」），还原并置顶；
2. 点击顶部搜索框，剪贴板粘贴目标名称；
3. 搜索面板是**独立 CEF 顶层窗口**（class `Qt51511QWindowToolSaveBits`），插件在这棵 `Chrome_RenderWidgetHostHWND` 树里按文本精确匹配目标并点击其中心（不依赖回车导航）；
4. 点击消息输入框，剪贴板 `Ctrl+V` 粘贴正文，`Enter` 发送；
5. `verify=true` 时回读消息分片最后若干条确认落库。

**发送限制**：

- **仅支持纯文本**，不支持图片 / 文件 / 回复。
- 会**真实占用鼠标键盘并置顶钉钉**，发送期间请勿同时操作电脑；要求窗口可见且未锁屏。
- 强依赖窗口布局 / DPI / 钉钉版本，大版本升级可能失效；`RMS_DD_DEBUG=1` 可把每步截图落到 `<account>\debug\` 便于排查。
- 仅适合**手动、低频**调用；高频 / 群发有风控风险。

### `dingtalk_config` 的 `set` 可写键

`account`、`data_dir`、`limit_per_chat`、`max_chats`、`chats`、`skip_chats`、`content_max_chars`。

## 落盘产物

全部产物按账号分目录：`<data_dir>\<account>\`（`<data_dir>` 默认 `%LOCALAPPDATA%\rms-dingtalk-session\data`）。

```
%LOCALAPPDATA%\rms-dingtalk-session\data\<account>\
├── rms-dingtalk-YYYYMMDD.ndjson   增量模式产物（每行一条消息，按天分文件）
├── cursor.json                    增量游标（每会话一个 mid）
├── key.json                       数据库密钥缓存
└── debug\                         RMS_DD_DEBUG=1 时的 UI 自动化截图
```

增量单条记录字段：`account` / `cid` / `chat_name` / `chat_type` / `mid` / `local_id` / `sender_id` / `sender_name` /
`type` / `content_type` / `created_at` / `datetime` / `text`（人类可读正文，非文本类型记为 `[图片]` 等）/
`content_truncated` / `recall_status` / `raw`（原始 content JSON，截断至 `content_max_chars`）。

配置（不分账号，全局一份）：`%LOCALAPPDATA%\rms-dingtalk-session\config.json`。

> **数据目录在仓库之外**（`%LOCALAPPDATA%`），因此聊天记录**不会**进入本仓库、也不会被推送到远端。
> 若用 `dingtalk_config` 把它改到仓库内，请自行加入 `.gitignore`。

## 已实测结论（本机）

- `dingtalk_status`：`ok=true`，本机账号「梅朗幸」/ uid `251244118`，134 个会话、128 个消息分片、739 条联系人档案，数据库密钥可用。
- `dingtalk_sessions`：可见自聊会话「我自己」与群「钉钉发送消息测试」的最新消息。
- `dingtalk_fetch`：增量写入 NDJSON，重复调用不重复落盘。
- `dingtalk_send to=梅朗幸 verify=true`：`ok=true`、`verified=true`，回读库内最后几条含测试文本。

## 接入与验证

dsh 侧由项目覆盖层 [`dsh/cordis.yml`](../../../dsh/cordis.yml) 登记；MCP 侧由 `mcp/server.mjs` 自动扫描。

```powershell
# 边车自检（在仓库根目录执行，不依赖 Trae）
'{"cmd":"doctor"}' | & "$env:USERPROFILE\.wechat-session-venv\Scripts\python.exe" `
  "plugins/generic/rms-dingtalk-session/scripts/dingtalk_sidecar.py"

# dsh 冒烟（cwd 必须是 deepseek-harness/）
"" | pnpm dsh acp --patch "../dsh/cordis.yml"

# MCP 平面（仓库根目录）
node mcp/server.mjs
```

## 已知限制

- **钉钉必须处于登录运行态**；关掉钉钉后取不到密钥，`dingtalk_status` 会报 `db_key_ok=false`。
- 钉钉大版本升级可能改变库结构 / 内存布局 / 窗口控件树，届时需重新适配。
- 读库前会把主库与 WAL 解密到临时目录（系统临时目录），读完即删；明文**不落业务目录**。
- 图片 / 语音 / 文件消息只记录元信息与文本占位（`[图片]` 等），不下载媒体。
- `dingtalk_send` 有副作用且不可后台化：会抢占鼠标键盘并置顶钉钉；不适合定时 / 无人值守场景。
