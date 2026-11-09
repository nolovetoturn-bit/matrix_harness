# rms-wechat-session（通用插件）

读写本机**微信 4.x（Windows PC 版）**：解密本地 SQLCipher 4 数据库列出会话、增量采集消息、把全部历史消息（含媒体）全量回溯导出；也可经 UI 自动化发送文本 / 图片 / 文件。

**读库路线**（`wechat_status` / `wechat_sessions` / `wechat_new` / `wechat_fetch` / `wechat_backfill`）是**纯只读**——不驱动微信窗口、不改动客户端任何数据，唯一写入的是插件自己的采集产物（NDJSON）。

> `wechat_send` 是**例外**：它走 UI 自动化，会真实驱动微信窗口（见下文「发送」一节）；
> 传 `quiet=true` 时可切换为不占鼠标、不置顶的静默路线。

规约见 [`docs/dsh-plugin-spec.md`](../../../docs/dsh-plugin-spec.md)。

## 原理与边界

微信 4.x 把会话与消息存在 SQLCipher 4 加密的本地库里：

```
%USERPROFILE%\Documents\xwechat_files\<wxid>\db_storage\
├── session\session.db        会话列表
├── message\message_0.db      消息（可能分片为 message_1.db …）
├── contact\contact.db        联系人
└── message\message_fts.db    全文索引
```

**每库一份的密钥常驻在 `Weixin.exe` 进程内存中**，可只读扫描取出。本机实测结论：

- 取密钥**不需要管理员权限**（同进程完整性级别即可 `OpenProcess` + `PROCESS_VM_READ`）；
- **不需要关闭微信**，明文库不落盘，不影响客户端；
- 但微信必须处于**已登录运行**态——密钥只在进程内存里，关掉微信就取不到。

因此本插件依赖一个 Python 边车来完成解密读库（Node 侧保持零依赖规约）。

## 读哪个账号（多账号机器必读）

本机若有**多个微信账号**（`<xwechat_files>` 下多个目录），必须显式指定读哪个：库自带的
「按库文件时间自动挑账号」会漂移，可能读到**不是当前收发消息的那个账号**。

- 默认锁定 `BurstM_792c`（昵称「槑佬」）。
- 任意工具都接受 `account` 参数临时覆盖；`wechat_config` 的 `set` 里写 `account` 可持久化默认值。
- 账号名 = `<xwechat_files>\<目录名>`；用 `wechat_status` 可确认当前锁定账号的昵称与 username。

**产物按账号隔离**：所有落盘文件都写到 `<data_dir>\<account>\` 下（增量 NDJSON、`backfill\`、游标
`cursor.json`），两个账号**互不干扰**——不会因同名会话「已存在即跳过」被错跳，游标也不会对错库。

## 微信多开（同时登录多个账号）

多开时**每个账号是独立的 `Weixin.exe` 进程、各持自己的主密钥**，插件对两条路线都按账号隔离：

**读库**（`wechat_*` 的读库类工具）：密钥提取会遍历**全部** `Weixin.exe` 进程，再用页 1 HMAC
对各账号目录做密码学校验 —— 因此传对 `account` 就一定能读到对应账号的库，互不串库。
实测 `BurstM_792c`（槑佬，484 会话）与 `wxid_5i4rko38kvyn22_d096`（大力，261 会话）可同时独立读取。

**发送**（`wechat_send`）：多开时两个主窗口的类名（`Qt51514QWindowIcon`）与标题（都是「微信」）
**完全相同**，`FindWindow` 只会拿到第一个 —— 直接用会把消息发给错误的账号。插件改为按
「账号目录 ↔ 进程内存里的 wxId ↔ 窗口 pid」三者对应来定位窗口：

| 账号目录 | 进程内存 wxId | 选中窗口 |
|---|---|---|
| `BurstM_792c` | `BurstM` | 该 pid 的主窗口 |
| `wxid_5i4rko38kvyn22_d096` | `wxid_5i4rko38kvyn22` | 该 pid 的主窗口 |

- 匹配规则：目录名等于 wxId，或以 `<wxid>_` 起头。
- **无法唯一匹配时直接报错**（列出全部实例与账号），绝不猜一个窗口发出去。
- 只有一个实例时照旧回退到它，单开机器行为不变。
- 用 `wechat_status` 可以查看「实例 ↔ 账号」对应表；`wechat_send` 的结果里也会回显
  `发送账号` 与 `实例窗口 hwnd/pid`。

## 文件

| 文件 | 角色 |
|---|---|
| `plugin.mjs` | 可移植清单 + 零依赖实现（参数校验 / 调边车 / 渲染） |
| `lib/sidecar.mjs` | 边车调用封装（`runSidecar` / 解释器默认路径），由 plugin 与调度器共用 |
| `lib/scheduler.mjs` | **动态同步调度器**：按会话活跃度自适应间隔、免打扰跳过、单例锁、状态落盘 |
| `dsh/host.mjs` | dsh 适配器：把 `tools` 注册到 `ctx.tools`，并随插件启动动态同步 |
| `scripts/wechat_sidecar.py` | Python 边车：解密读库 + 归一化 + 落盘 + `sync_scan`（跑在专用 venv 内） |
| `scripts/sync_daemon.mjs` | 独立常驻进程入口：不重启 Trae 也能让调度器跑起来（`--stop` 停止） |

两平面共用同一份 `plugin.mjs`；边车以 **JSON 经 stdin/stdout** 与 Node 通信，故不存在 Windows 命令行引号问题。

## 前置：专用 venv

边车依赖 [`wechatauto-replica`](https://pypi.org/project/wechatauto-replica/)（微信 4.1.12+，纯本地读库，无 Web API）。
它**不装在全局 Python**，而是装在仓库外的专用 venv 里（便于整体删除、不影响其它环境）：

```powershell
C:\Python314\python.exe -m venv C:\Users\admin\.wechat-session-venv
C:\Users\admin\.wechat-session-venv\Scripts\python.exe -m pip install wechatauto-replica
```

默认解释器路径写死在 `plugin.mjs` 的 `DEFAULT_PYTHON`；可用每个工具的 `python_exe` 参数覆盖。

## 工具

| MCP 全名 | 说明 |
|---|---|
| `rms-wechat-session__wechat_status` | 体检：微信进程 / 登录账号 / 数据库密钥 / 会话总数 / 边车环境 |
| `rms-wechat-session__wechat_sessions` | 列出会话（名称、未读数、最近摘要与时间） |
| `rms-wechat-session__wechat_new` | **新消息检测**：列出有未读的会话并落盘存档（默认剔除公众号推送） |
| `rms-wechat-session__wechat_fetch` | 增量采集，归一化 NDJSON 落盘 |
| `rms-wechat-session__wechat_backfill` | **全量历史回溯**：逐会话从最新翻到最老导出，可选下载媒体 |
| `rms-wechat-session__wechat_send` | 发送文本 / 图片 / 文件（**UI 自动化**，会占用鼠标键盘；`quiet=true` 可走静默路线） |
| `rms-wechat-session__wechat_sync` | **动态同步**：查看调度状态 / 启动 / 停止 / 立即跑一轮 |
| `rms-wechat-session__wechat_config` | 读写边车配置 |

> **增量 vs 回溯**：`wechat_fetch` 走游标，只取「新」消息，**永远补不回首次采集之前的历史**；
> 要补历史必须用 `wechat_backfill`（不受游标限制）。二者互补，可并存。

### `wechat_new` 参数（均可省略）

| 参数 | 默认 | 说明 |
|---|---|---|
| `exclude_service` | `true` | 剔除公众号 / 服务号 / 系统通知推送（`gh_*`、`*@app`、`*@openim` 等），只留真人会话与群聊 |
| `min_unread` | `1` | 未读数达到多少才算「有新消息」 |
| `max` | `50` | 本次最多返回多少个会话明细 |
| `limit` | `0`（全部） | 最多扫描多少个会话 |
| `account` | `BurstM_792c` | 读库账号（`xwechat_files` 下的目录名） |
| `python_exe` | 专用 venv | 边车解释器路径 |

**检测语义与边界**：

- 数据源是 `session.db` 的 `SessionTable.unread_count` —— 纯只读、零网络请求，微信**最小化**时同样可用。
- 它回答的是「**哪些会话有未读**」，不是「新到的那条消息正文」；要拿正文用 `wechat_fetch`。
- 未读数在**手机端读了消息**时也会清零（多端同步），所以这是「本机未读」而非「全网未读」。
- 落盘：只把**本次新出现、或未读数 / 最后消息时间较上次快照有变化**的会话追加到
  `<account>\new-YYYYMMDD.ndjson`，重复调用不会重复落盘；未读清零的会话会移出
  `<account>\new_state.json` 快照，下次来信可重新触发。

> 默认 `exclude_service=true`：实测本机 484 个会话里 215 个有未读，其中 187 个是公众号 /
> 服务号推送 —— 不剔除的话提醒会被营销推送淹没。要看全部传 `exclude_service=false`。

### `wechat_fetch` 参数（均可省略）

| 参数 | 默认 | 说明 |
|---|---|---|
| `max_chats` | `0`（全部会话） | 最多采集多少个会话 |
| `limit_per_chat` | `200` | **首次**采集每个会话最多回溯多少条 |
| `chats` | `[]`（全部） | 只采集这些会话（会话名 / 昵称 / 备注 / username） |
| `skip_chats` | `[]` | 跳过这些会话（会话名 / 昵称 / 备注 / username） |
| `account` | `BurstM_792c` | 读库账号（`xwechat_files` 下的目录名） |
| `python_exe` | 专用 venv | 边车解释器路径 |

**增量语义**：每会话维护一个游标（`sort_seq`）。首次采集取最近 `limit_per_chat` 条并把游标推到最新；
之后每次只用 `get_new_messages` 取游标之后的新消息。**重复调用不会产生重复数据**，也不会回填首次之前的历史。

### 动态同步（`wechat_sync` 与 `lib/scheduler.mjs`）

插件加载后会自己起一个**常驻调度器**，按「每个会话自己的交互频次」决定下次同步时间，而不是
所有会话统一定时全量拉一遍。dsh 侧（`dsh/host.mjs`）与 MCP 侧（`mcp/server.mjs` 扫描到
`startSyncScheduler` 导出）都会尝试启动，靠 `<data_dir>\<account>\sync.lock` 的 PID 锁保证
**同一账号只有一个真正在跑**。

**多账号（微信多开）**：一个调度器会同时跟踪本机多个微信账号 —— 账号来源优先级为
`wechat_sync` 的 `account` 参数 > 配置 `sync_accounts` > **自动发现**
（`Documents\xwechat_files\*\db_storage`，优先取已有密钥缓存的目录）。
每个账号有**独立的状态文件、游标、产物目录与单例锁**，tick 内逐个账号串行同步
（避免多个边车同时抢读同一个微信库）；新登录的账号会在下一轮 tick 自动纳入，账号目录消失则自动移出。
账号之间互不影响：某个账号取不到密钥只会让它自己退避，不会打断其他账号。

**活跃度模型**（每会话独立）：

- 每轮同步后，把该会话的分数按半衰期衰减：`score *= 0.5^(空闲秒数 / sync_half_life)`；
- 再累加本轮新增：**别人发来的消息 +1，自己发出的消息 +3**（自己动手 = 更强的交互信号）；
- 目标间隔 `interval = sync_base_interval / (1 + score)`，夹在 `[sync_min_interval, sync_max_interval]`；
- 本轮**没有新消息**则额外乘 `1.2` 做空闲退避，逐步收敛到上限；
- 只有最近 `sync_activity_window` 秒内产生的消息才计入活跃度 —— 首次采集回溯的几百条历史
  不会把会话误钉在最短间隔（这是初版实测踩到的坑：`score` 曾被历史消息推到 300+，全部会话 2 分钟一轮）。

**免打扰（只判群聊）**：读 `contact.db` 的 `contact.chat_room_notify` —— 群聊 `0` = 消息免打扰、
`1` = 正常；**单聊该字段恒为 0，不能据此判断**，故只对 `*@chatroom` 生效。被判定为免打扰的群
**不纳入调度**、游标不推进（解禁后从旧游标续补，不丢消息）。单聊不免打扰，靠活跃度自然拉长间隔。
`wechat_config` 的 `muted_chats` 可再手动追加排除项。

| `wechat_sync` 的 `action` | 行为 |
|---|---|
| `status`（默认） | 查看是否运行、各账号配置/到期/活跃会话/免打扰清单；**不会启动调度器** |
| `start` | 启动（幂等；缺省启动全部账号） |
| `stop` | 停掉并落盘状态、释放锁（传 `account` 只停该账号） |
| `once` | 立刻跑一轮（手动触发会跳到期判断，按最久未同步优先拉一批；缺省全部账号） |

**后台常驻（不必等 Trae 重启）**：直接以独立进程拉起同一套调度器：

```powershell
node plugins/generic/rms-wechat-session/scripts/sync_daemon.mjs          # 启动
node plugins/generic/rms-wechat-session/scripts/sync_daemon.mjs --stop   # 停止
```

日志与 pid 在 `%LOCALAPPDATA%\rms-wechat-session\`（`sync-daemon.log` / `sync-daemon.err.log` / `sync-daemon.pid`）。
它与 dsh / MCP 平面自动启动的实例靠各账号的 `sync.lock` 互斥，谁先拿到锁谁跑，不会重复同步；
Trae 重载后插件会看到锁已存在而跳过启动，守护进程继续工作。

同步参数（`wechat_config` 的 `set` 可改）：

| 键 | 默认 | 说明 |
|---|---|---|
| `sync_enabled` | `true` | 随插件启动自动同步；`false` 时定时触发会自行停止 |
| `sync_accounts` | `[]` | 要同步的账号目录列表；**空 = 自动发现本机全部账号**（多开时逐个同步） |
| `sync_tick_seconds` | `60` | 调度器多久检查一次谁到期 |
| `sync_scan_seconds` | `300` | 多久重扫会话全集 / 免打扰状态 |
| `sync_base_interval` | `3600` | 无交互时的基准间隔（秒） |
| `sync_min_interval` | `120` | 最活跃会话的下限间隔 |
| `sync_max_interval` | `7200` | 长期无新消息的上限间隔 |
| `sync_half_life` | `10800` | 活跃度半衰期（秒） |
| `sync_activity_window` | `3600` | 只有最近这么久的消息计入活跃度 |
| `sync_max_per_tick` | `20` | 单轮最多同步多少个会话（控制耗时） |
| `sync_skip_muted` | `true` | 跳过消息免打扰的群 |
| `sync_include_service` | `false` | 是否把公众号 / 服务号也纳入同步 |
| `muted_chats` | `[]` | 手动追加排除的会话（username / 名称） |

新一轮纳入调度的会话会在 `sync_max_per_tick` 之外把 `next_due` **打散在 10 分钟内**，避免
首次启动一次性把 100+ 会话全拉一遍。发送成功的会话会被 `noteActivity` 额外加权（+5），
自己刚聊过的会话下一轮会更快轮到。

### `wechat_backfill` 参数（均可省略）

| 参数 | 默认 | 说明 |
|---|---|---|
| `chats` | `[]`（全部会话） | 只回溯这些会话（会话名 / 昵称 / 备注 / username） |
| `max_chats` | `0`（全部） | 本次最多处理多少个会话（分片跑用） |
| `download_media` | `true` | 是否一并下载图片 / 语音 / 视频 / 文件 |
| `force` | `false` | 对已完成的会话强制重做（默认断点续跑） |
| `skip_chats` | `[]` | 跳过这些会话（会话名 / 昵称 / 备注 / username） |
| `account` | `BurstM_792c` | 读库账号（`xwechat_files` 下的目录名） |
| `python_exe` | 专用 venv | 边车解释器路径 |

**回溯语义**：

- 用库自带的 `export_history(limit_per_chat=None)` 导出**单个会话的全历史**（库内部已处理跨分片合并、
  发送者名解析、时间升序），比自己按 offset 翻页可靠。
- 逐会话落一份 `<data_dir>\<account>\backfill\<safe-username>.ndjson`，**已存在即跳过** → 中断 / 超时后重跑只补未完成的会话，
  不会重复落盘（`force=true` 强制重做）。
- 媒体按消息类型（图片 / 语音 / 视频 / 文件）调 `MediaDownloader.download_media` 下载到
  `<account>\backfill\media\<safe-username>\`，并把路径写回记录字段 `media_path`（未拿到时为 `null`）。
- 偶发返回 0 条时会重试一次；仍为空的会话**不落文件**（保持幂等语义，留待下次重跑补采）。

### `wechat_send` 参数与前提

| 参数 | 默认 | 说明 |
|---|---|---|
| `text` | — | 要发送的文本内容 |
| `to` | 当前打开的会话 | 目标会话名（昵称 / 备注 / 群名）；不填则发到当前已打开的会话 |
| `image` | — | 要发送的本地图片路径 |
| `file` | — | 要发送的本地文件路径 |
| `reply` | `false` | 以「回复最近一条消息」的方式发送文本 |
| `verify` | `false` | 发送后回读数据库确认已落库（不重复发送） |
| `quiet` | `false` | **静默发送**：不移动鼠标、不点击、不置顶（详见下文） |
| `account` | `BurstM_792c` | 回读校验用的账号（`xwechat_files` 下的目录名） |
| `python_exe` | 专用 venv | 边车解释器路径 |

`text` / `image` / `file` 可同时给，按 **文本 → 图片 → 文件** 顺序逐条发送；至少给一个。

**关于 `verify`**：库自带的回读校验只按通讯录（`search_contact`）解析目标会话，像「文件传输助手」
这种不在通讯录里的会话会解析失败 → 误报「消息已操作发送，但数据库未确认」。插件在其后追加了
两层兜底：① 按「发送前水位」自己回读数据库（文本比正文、媒体比类型）；② 若仍对不上、但库本身
已确认「消息已操作发送」，则判为已发送并如实标注「数据库回读未确认」。

> 多账号机器上还需注意：读库时选中的账号可能不是当前发消息的那个账号（自动选择按库文件时间
> 推断），此时回读一定对不上 —— 这属于账号选择问题，不是发送失败。

#### 静默模式（`quiet=true`）

默认路线会把遮挡窗口最小化、置顶微信、真实驱动鼠标键盘，发送期间电脑无法正常使用。`quiet=true`
改走一条**低干扰路线**，逐项实测结论如下：

| 步骤 | 静默做法 | 是否碰鼠标 | 是否需要微信在前台 |
|---|---|---|---|
| 切换目标会话 | UIA 取焦点 → 投递 `WM_CHAR` 逐字输入 → 向搜索下拉弹窗（`Qt51514QWindowTool*`）**投递**左键消息点结果行 | 否 | 否 |
| 写入正文 | UIA `ValuePattern.SetValue` | 否 | 否（后台可写） |
| 按下发送 | `PostMessage(WM_KEYDOWN/WM_KEYUP, VK_RETURN)` 投给主窗口 HWND | 否 | 否（后台可发） |

因此：

- **全程不移动鼠标、不点击真实光标、不置顶**，微信可以被别的窗口盖住（**只要没被最小化**）。
- 若目标会话**已经是当前会话**（`to` 省略或与当前一致），整段流程微信都在后台；
  需要切换会话时会短暂占用前台约 1–2 秒，随后立即把前台还给调用前的窗口。
- 切换会话不能靠回车：实测微信 4.x 的搜索结果行既没有 UIA `Invoke`/`Select` 模式，往主窗口
  投递回车也不会打开会话（两个实例都复现）。插件改为把左键消息投递给搜索下拉那个独立的
  Qt 弹窗，坐标换算成它的客户区，真实光标不动。仅在定位不到该弹窗时，才退回一次真实鼠标
  点击，并在结果说明里标注「切换会话时退回了真实鼠标点击」。
- 底层库在创建 UIA 引擎 / `SetValue` / `SetFocus` 时会 `BringWindowToTop + SetForegroundWindow`
  抢一次前台，插件每步之后都会立即归还。
- **只支持纯文本**，且不支持 `reply`（图片 / 文件要真实拖拽或 `Ctrl+V`，回复要右键点最近一条
  消息 —— 都必然动鼠标）；给了这些组合会直接报错，不会静默降级。
- 静默模式不经过库自带校验，**一律用自研回读判定**（`quiet` 会自动打开数据库回读，无需再传 `verify`）。

#### 普通模式与读库路线的本质区别（务必知悉）

- 走的是 **UI 自动化**（Win32 真实鼠标键盘 + UIA，必要时用 Windows 自带 OCR 兜底定位），**不是协议级发送**。
- 要求微信窗口**可见且未锁屏**；发送前库会**自动最小化遮挡窗口并把微信置顶**，发送期间电脑无法正常使用。
- 强依赖窗口布局 / DPI / 版本，微信大版本升级可能失效。
- 仅适合**手动、低频**调用；高频 / 群发有触发微信风控甚至封号的风险（微信条款禁止自动化）。
- 无法在无桌面会话（后台 / headless）环境运行 —— 静默模式同样需要微信已登录、窗口存在且未最小化。

### `wechat_config` 的 `set` 可写键

`account`、`data_dir`、`limit_per_chat`、`max_chats`、`chats`、`skip_chats`、`content_max_chars`、`download_media`、
`sync_enabled`、`sync_accounts`、`sync_tick_seconds`、`sync_scan_seconds`、`sync_base_interval`、`sync_min_interval`、`sync_max_interval`、
`sync_half_life`、`sync_activity_window`、`sync_max_per_tick`、`sync_skip_muted`、`sync_include_service`、`muted_chats`。

## 落盘产物

**全部产物按读库账号分目录**：`<data_dir>\<account>\`（`<data_dir>` 默认
`%LOCALAPPDATA%\rms-wechat-session\data`，`<account>` = `xwechat_files` 下的账号目录名，如 `BurstM_792c`）。

```
%LOCALAPPDATA%\rms-wechat-session\data\<account>\
├── rms-wechat-YYYYMMDD.ndjson    增量模式产物（每行一条消息，按天分文件）
├── cursor.json                   增量游标（每会话一个 sort_seq）
├── new-YYYYMMDD.ndjson           新消息检测产物（有新消息的会话，按变化去重）
├── new_state.json                新消息检测快照（记录每会话上次的未读数与时间）
├── sync_state.json               动态同步状态（每会话 score / interval / next_due / 免打扰清单），可删除重建
├── sync.lock                     调度器单例锁（pid + owner + heartbeat），进程退出后自动失效
└── backfill\                     回溯模式产物
    ├── <safe-username>.ndjson    每个会话一份，时间升序，每行一条消息
    └── media\<safe-username>\    该会话下载下来的图片 / 语音 / 视频 / 文件
```

增量单条记录字段：`chat_username` / `chat_name` / `shard` / `local_id` / `sort_seq` / `type` / `sender_username` /
`sender_name` / `create_time` / `datetime` / `text`（人类可读正文，非文本类型记为 `[图片]` 等）/
`content`（原始串，截断至 `content_max_chars`）/ `content_truncated`。

回溯单条记录字段：`chat_username` / `chat_name` / `local_id` / `sort_seq` / `type` / `type_code` /
`sender_name` / `server_id` / `md5` / `create_time` / `datetime` / `text` / `content` / `content_truncated` /
`media_path`（媒体落盘路径，非媒体消息为 `null`）。

配置（不分账号，全局一份）：`%LOCALAPPDATA%\rms-wechat-session\config.json`。

群聊正文形如 `wxid_xxx:\n实际内容`，`text` 已剥离发送者前缀，`content` 保留原样。

> **数据目录在仓库之外**（`%LOCALAPPDATA%`），因此聊天记录**不会**进入本仓库、也不会被推送到远端。
> 若用 `wechat_config` 把它改到仓库内，请自行加入 `.gitignore`。

## 接入与验证

dsh 侧由项目覆盖层 [`dsh/cordis.yml`](../../../dsh/cordis.yml) 登记；MCP 侧由 `mcp/server.mjs` 自动扫描。

```powershell
# 边车自检（不依赖 Trae）
'{"cmd":"doctor"}' | & "C:\Users\admin\.wechat-session-venv\Scripts\python.exe" `
  "C:/Users/admin/Documents/trae_projects/rms_dsh/plugins/generic/rms-wechat-session/scripts/wechat_sidecar.py"

# dsh 冒烟（cwd 必须是 deepseek-harness/）
"" | pnpm dsh acp --patch "C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml"

# MCP 平面
node "C:/Users/admin/Documents/trae_projects/rms_dsh/mcp/server.mjs"
```

## 已知限制

- **微信必须处于登录运行态**；关掉微信后 `wechat_status` 会报密钥不可用。
- 微信大版本升级可能改变内存布局 / 库结构，届时需升级 `wechatauto-replica`。
- 首次全量采集 260 个会话、每会话 200 条会较慢（受 `limit_per_chat` 控制）。
- 全量回溯（`wechat_backfill`，含媒体下载）耗时较长：建议不加 `max_chats` 长时间跑，
  中途超时 / 中断后重复调用即可续跑。
- 图片 / 语音 / 视频在**增量模式**下只记录元信息（`text` 记为 `[图片]` 等）；
  要下载媒体请用**回溯模式**（`download_media=true`）。
- 缩略图类消息（`动画表情` 等）不在 `MEDIA_TYPES` 内，只记元信息，不下载。
- **`wechat_send` 有副作用且不可后台化**：会抢占鼠标键盘并置顶微信，必须微信窗口可见；
  不适合定时 / 无人值守场景，也有微信风控风险。发送失败最常见的两类原因是「窗口不可见或被锁屏」
  与「目标会话名不匹配」（可先用 `wechat_sessions` 核对名称）。
