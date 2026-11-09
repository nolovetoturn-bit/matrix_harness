# rms-flow-runner（通用插件）

经验辅助规划、可恢复执行与人工确认监督的最小 LLM 工作流运行器。Planner 先检索工作日志经验并生成 Workflow IR 草稿；确认草稿后，Flow Runner 是唯一业务执行器，节点之间只通过 Cin/Cout 传递业务数据。总会话中的 Supervisor 只读分析定义、状态和轨迹，可建议暂停、终止、重新规划或插入人工中断，所有干预都必须经人工确认。

首版只提供 Det、LLM 判定与人工节点，不提供外部写入节点；不修改 Airflow/Azkaban，也不替换 dsh 的聊天界面。

## 文件

| 文件 | 角色 |
|---|---|
| `plugin.mjs` | dsh/MCP 双平面共用的工具契约 |
| `lib/runner.mjs` | Workflow IR 校验、表达式、解释器、fuel 与确定性重放 |
| `lib/store.mjs` | JSON 原子落盘、运行列表与跨进程恢复锁 |
| `lib/llm.mjs` | 零依赖 OpenAI/Anthropic 兼容传输 |
| `lib/ai.mjs` | 经验检索、Planner 输出修复与 Supervisor 只读分析 |
| `lib/service.mjs` | 规划、执行、监督、动作确认与不可变版本服务 |
| `lib/panel.mjs` | 仅监听 `127.0.0.1` 的面板与 API |
| `panel/index.html` | 工作流会话组、规划监督、DAG、Cin/Cout、节点定义查看与人工恢复界面 |
| `dsh/host.mjs` | dsh 工具注册适配器 |
| `test/runner.test.mjs` | 控制流、规划监督、动作确认、版本缓存与面板测试 |

## 最小 Workflow IR

`definition.version` 固定为 `1`，`definition.entry` 为入口节点。所有节点必须有全局唯一、ASCII 字母开头的 `id`；`label` 为可选中文显示名。

| type | 关键字段 | 语义 |
|---|---|---|
| `det` | `op: expr/literal/assert` | 确定性计算、字面量或校验；不执行任意 JavaScript |
| `llm` | `mode: gen/choose`, `prompt` | LLM 计算判定或选项判定；`gen` 默认只接收 JSON，可设 `output: text` |
| `human` | `prompt` | 挂起运行；恢复输入作为下一次调用的 Cin 注入原路径 |
| `agent` | `prompt`, `system?`, `output: json/text` | 在 dsh 宿主内创建受控 agent 会话（只读工具循环）完成调查；缺少 agent 运行时报明确失败 |
| `tool` | `tool`, `args?`, `output: json/text` | 调用宿主注册的工具（dsh 内受 `RMS_FLOW_TOOL_ALLOW` 白名单约束）；没有 toolRunner 时明确报错 |
| `script` | `runtime`, `code`, `args?`, `cwd?`, `env?`, `timeout_ms?`, `output: json/text` | 运行本地脚本；Cin 以 JSON 写入 stdin，stdout 解析为 Cout。`runtime` 取 `bash/sh/powershell/pwsh/node/ts/python/python3`（`ts` 依赖 Node 22.18+/23.6+ 原生类型剥离） |
| `http` | `url`, `method?`, `headers?`, `body?`, `timeout_ms?`, `output: json/text` | 直接发起 HTTP 请求；`url/headers/body` 支持表达式 |
| `subflow` | `definition` 或 `ref`, `input?`, `workspace?`, `fuel?`, `recursion?` | 执行子流程并把子运行最终 Cout 直接作为本节点 Cout；`definition` 内联，`ref` 引用命名定义；子运行独立持久化并记录父子关系 |
| `sequence` | `steps[]` | 顺序执行，前一步输出是下一步输入 |
| `branch` | `condition`, `then`, `else?` | Det 条件分支；无 `else` 时条件为假则透传输入 |
| `fold` | `items`, `initial`, `body` | 顺序折叠；body 输入为 `{acc,item,index}` |
| `loop` | `while`, `body`, `max_iterations?` | 上一步输出回灌下一步；全局 fuel 保证终止 |
| `or_else` | `primary`, `fallback` | primary 失败时用原输入执行 fallback；人工挂起不触发 fallback |

表达式采用 JSON 数据，支持 `var`、`literal`、`if`、`and/or/not`、`coalesce`、比较、`+ - * / %`、`cat`、`length`、`in`、`range`、`join`、`split`。例如 `{ "count": { "+": [{ "var": "count" }, 1] } }` 会生成新对象，不需要也不能注入 JS 代码。

需要批量生成文本时不要用 `fold`/`loop` 逐项枚举（每项都会消耗 fuel 并写一条 trace），改用单个 `det` 节点：`{ "join": [{ "range": [1, 10000] }, "\n"] }` 一次生成 10000 行。

运行每个实际节点消耗 1 个 fuel，默认 100，可通过 `definition.fuel` 或 `flow_start.fuel` 调整。恢复时从入口做确定性重放：已完成节点直接读取轨迹输出，因此不会重复调用已完成的 LLM；人工输入只注入原挂起路径。跨版本续跑仅复用路径、节点定义哈希与 Cin 均一致的已完成缓存，定义或输入变化后会重新执行。

## 入口契约 `definition.inputs`

节点类型彼此独立：确定性节点（`det`/`script`/`http`/`tool`）与非确定性节点（`llm`/`agent`）可以任意组合，工作流可以完全没有 LLM 节点。声明入口契约后，所有启动路径都会校验输入：

```json
{
  "version": 1,
  "name": "按站点跑可见性检查",
  "inputs": {
    "site": { "type": "string", "required": true, "description": "要检查的站点" },
    "limit": { "type": "integer", "min": 1, "max": 500, "default": 50 },
    "raw_note": { "type": "string", "judge": "llm", "description": "自然语言补充，由流程内节点解析" }
  },
  "entry": { "id": "check", "type": "script", "runtime": "node", "code": "..." }
}
```

字段支持 `type`（`string/number/integer/boolean/json/array/object`）、`required`、`default`、`enum`、`min`/`max`、`description`、`judge`。`judge: "llm"` 表示该字段是原始字符串，由 IR 内的 `llm`/`agent` 节点自行解析；此时 `entry` 必须至少包含一个 LLM/Agent 节点，否则定义校验失败。声明 `inputs` 后，未知字段与类型不符都会报错；未声明时保持旧的“任意 JSON Cin”行为。

## 工作目录

每个会话有独立的 `workspace`（绝对路径），保存在 `session-<id>.json`，运行记录继承该目录。不同会话的文件读写互不干扰：

- 默认值：`<data_dir>/workspaces/<session_id>`，首次启动或设置时自动创建。
- 指定方式：`flow_plan({ workspace })`、`flow_start` / `flow_invoke` 的 `workspace`，或 `flow_workspace({ session_id, workspace })`；面板的“工作目录”卡片等价于 `flow_workspace`。
- `flow_workspace` 同时更新会话与尚未启动的草稿；已启动的运行保持原工作目录。工作区发生变化时递增 `workspace_revision` 并创建新 dsh 镜像会话，不修改旧会话的 cwd。
- dsh 宿主复用 `WorkspaceRegistry` 注册目录并挂载会话；`session/build/run` 记录 `workspace_id` 与 `dsh_session_id`，构建的 `sessions` 和运行的 `repairs` 另存每次真实 agent 调用的会话 ID 与父子关系。宿主未提供 `WorkspaceRegistry` 时不阻塞插件加载，工作目录与确定性节点仍按本地路径运行。
- `script` 节点默认以运行的工作目录为 cwd；相对 `cwd`（如 `"cwd": "sub"`）以工作目录为根解析，绝对 `cwd` 原样使用。
- `agent` 节点的临时 dsh 会话同样以工作目录为 cwd，并在提示中限定只读访问范围。
- 规划器会获知当前会话目录，并被要求不要在 IR 中写死机器相关的绝对路径。

## 子流程与递归

`subflow` 节点可以直接内联一段子 IR，也可以引用已保存的命名定义：

```json
{ "id": "verify", "type": "subflow", "ref": { "name": "countdown", "version": 1 }, "input": { "n": 3 } }
```

- 命名定义通过 `flow_define` 保存，每次保存生成新版本，默认激活最新版本；`flow_defs` 查看定义列表或某个定义的版本内容。
- 子运行是真实的独立运行：持久化 `parent_run_id`、`parent_node_id`、`parent_path`、`root_run_id`、`depth`、`subflow_chain`、`definition_ref`。
- 子流程最终 Cout 直接作为父节点 Cout，父流程不需要额外映射。
- 子运行默认继承父运行的工作目录；`workspace` 可指定相对子目录（相对父工作目录解析）或绝对路径。
- 递归：引用自身（祖先链中已出现同一 `name@version`）必须显式设置 `recursion: true`，否则直接报错；深度上限默认 16（内联嵌套与 ref 递归都计入），可用 `RMS_FLOW_SUBFLOW_MAX_DEPTH` 调整（1..32）。
- 子流程中出现 `human` 节点时，父运行进入 `waiting_human`，`pending.subflow_run_id` 指向子运行；`flow_resume` 会自动递归路由到最深等待中的子运行，子运行完成后把结果注入父节点继续推进。
- 规划阶段可以产出 `build` 占位（`{ "type": "subflow", "label": "报告生成", "build": { "task": "..." } }`），此时父草稿只能查看、不能执行；`flow_start` / `flow_invoke` / `flow_confirm` 会明确报「存在未构建的子流程占位」。
- 多层/递归需求不再由根规划一次展开所有层：规划器只写第 1 层并留一个占位，后续每层由 Building 的独立子会话按占位的 `build.task` 生成，再逐层回填。

## Building 阶段

复杂任务不再由 Planner 一次生成整棵树的所有节点细节，而是自顶向下拆解、逐节点实现：

1. **Skeleton**：根会话只产出骨架（`id/role/intent/inputs/outputs/complexity`）与入口契约，不写实现。
2. **逐节点新会话**：每个节点单独开一次会话，只看该节点契约、兄弟节点摘要与父级契约；上下文与树规模无关。
3. **复杂度阈值**：会话判定为 `implement` 时直接产出该节点的真实 IR；判定为 `decompose` 时产出子骨架并递归入队。`implement` 的 IR 里可以继续保留 `subflow.build` 占位，系统会为每个占位创建独立子节点与会话，逐层构建到叶子，再自底向上替换占位。
4. **组装**：自底向上编译，`group` 节点编译为 `subflow`（`definition` 内联），完成后执行 `validateDefinition` + `validateInput`，生成 `draft` 运行与待确认 `start` 动作。
5. **人工介入**：节点会话可返回 `need_human`。构建状态停在 `waiting_human`，请求保存在 `human`（含 `path`、`question`、`options`、`suggested_zoom`），统一在根会话展示，避免多层界面同时弹窗。

zoom 机制用于调整分析角度和范围：`zoom=in` 收紧范围、细化到可实现，通常直接 `implement`；`zoom=out` 放宽范围、重新划分边界，允许继续拆解；同时可传 `angle` / `scope` / `answer` 作为下一轮会话的权威约束。答复后只重跑该节点（清空其子节点与实现），历史记录在 `history`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `RMS_FLOW_BUILD_COMPLEXITY_MAX` | 3 | 节点内直接实现的复杂度阈值（1..5） |
| `RMS_FLOW_BUILD_MAX_DEPTH` | 8 | 骨架递归与构建占位嵌套层数上限，达到后强制 `implement` 且不再接受占位 |
| `RMS_FLOW_BUILD_MAX_NODES` | 40 | 单次构建的节点总数上限 |
| `RMS_FLOW_BUILD_MAX_SESSIONS` | 60 | 单次构建的会话总数上限 |

构建状态保存在 `build-<session_id>.json`；中断后可按 `status` 续跑，无需重放历史对话。`flow_build` 的 `step` 每次只推进一个节点，`run` 连续推进到 `waiting_human` / `awaiting_confirm` / `failed`。面板和 `flow_build status` 展示当前节点、逐节点状态、进度与每次会话结果。

dsh 中的骨架和节点构建使用真实 agent 会话；节点实现使用可写工作区的 coding agent，要求实际写文件并执行语法检查或可行试运行。Node 脚本还会在执行前做 `node --check` 预检，失败输出与校验错误会回灌到下一次独立修复会话，最终 IR 只保留验证后的脚本正文。

### 构建交接（plan → build）

子流程占位不需要人工搬上下文：用 `flow_build` 传 `from_run_id`（父草稿）与 `node_id`（占位节点）即可接手。

1. 系统为占位创建确定性会话 `sess-<父会话>_<node_id>_<来源草稿后缀>`（写入 `parent_session_id` / `root_session_id` / `depth` / `origin`），并把占位上下文（父任务、节点标签、`build.task`、输入输出契约）注入构建状态；后缀保证逐层交接时同名占位不会复用上一层的构建。
2. 构建完成后自动回填父 IR：沿 `superseded_by` 找到最新草稿，把占位替换为 `subflow.definition`，生成 v+1 新草稿（`planner.kind=build_handoff`），旧草稿标记 `superseded`，并把父会话 `draft_run_id` 指向新版本。
3. 同一节点被重复构建（例如 `bug_report` 重建）时，直接替换已构建的 subflow 定义并继续递增版本号。

### 预构建（panel / 面板）与构建栈

草稿含 `subflow.build` 占位时不能直接启动：`flow_start` / `flow_invoke` / `flow_confirm` 都会报「存在未构建的子流程占位」。面板提供「预构建」按钮（右栏草稿卡片与中栏待确认动作卡片），一次点击按**共享构建栈**逐个为占位创建子会话并构建：

1. **整棵树共用一个构建栈**（`buildstack-<根会话>.json`）：草稿占位与各层构建里发现的嵌套占位都是栈条目（记录归属会话/节点、层级、子会话 id 与状态），面板「构建栈」卡片展示全树进度。
2. **驱动语义**：按栈顺序推进，同一构建内的嵌套占位子条目深度优先递归（子先于父），子构建完成即**自底向上回填**父构建的 `subflow.build` 为 `subflow.definition`，父构建继续自身队列；直到**回到根会话且栈空**才完成构建。
3. **每层独立子会话**：第 1 层（根层）先有自己的会话（`sess-<根会话>_layer1`，挂在发起会话之下，只作层级锚点、不做需求分析与编码），嵌套占位不再构建内递归，各自再开 `sess-*` 子会话挂到上一层之下；dsh 侧栏因此呈现「发起会话 → 第1层 → 第2层 …」的完整层级链。
4. **整体暂停**：任一条目进入 `waiting_human` / `failed`，整个栈停止驱动（兄弟条目不再推进）；在归属子会话答复人工请求后（`flow_build answer` 会从断点恢复整栈）继续。
5. **深度守卫**：嵌套层级受 `RMS_FLOW_BUILD_STACK_DEPTH`（默认 16，1..64）限制，超过即该父构建失败。
6. 中栏「确认执行」按钮按占位状态门禁：有未构建占位时按钮变为「预构建子流程（N）」，全部构建完成（`remaining=0`）后才出现「确认执行」。
7. 对应 API：`POST /api/runs/<run_id>?action=prebuild`（body `{ step: true }` 每次推进一个栈条目），返回 `{ status, run_id, definition_version, remaining, placeholders, builds, stack }`；`flow_build run` / `flow_build answer` 同样走共享构建栈。

## 会话树与信箱

- 会话记录新增 `parent_session_id`、`root_session_id`、`depth`、`origin`；`flow_sessions` 返回整棵树（或传 `session_id` 只看某棵子树），每个节点带未读信件数。
- `flow_mail` 提供会话间通信：`send`（`context`/`question`/`bug_report`/`note`/`answer`）、`inbox`（读取并默认标记已读）、`reply`（回信并标记原信已解决）。
- 只能在同一个根会话树内通信，目标深度受 `RMS_FLOW_SESSION_MAX_DEPTH`（默认 4）限制；同一发件人 + 主题 + `node_path` 的未解决信件会复用，避免重复投递。
- `bug_report` 会命中目标会话构建状态中的节点（`refs.node_path` 优先，其次 `refs.node_id`），以 `action: mailbox` 触发该节点重建；完成后自动回一封 `answer`，并把原信标记为已解决。
- 面板左侧按 `parent_session_id` 渲染会话树，可折叠子树；父会话详情的“子流程会话”卡片可直接跳转。
- 运行轨迹中的 `subflow` 节点可下钻：点击 DAG 节点或步骤里的“进入子流程”，或聚焦后按 Enter；`Alt+←` 返回父运行/父会话，`Alt+→` 进入当前运行或会话的第一个子流程。

### 人工请求下沉

- 构建期：人工请求只留在归属子会话（`build.human`），根会话不再持有可交互请求，只在 `flow_get` / `flow_sessions` 中返回指针（`session.pending_human`、`children[].pending_human`、`delegated_human`）。指针包含 `session_id`、`path`、`request_id`、`question`，按指针到子会话调用 `flow_build answer` 即可。
- 运行期：子运行等待人工时，根运行 `pending` 只保留 `subflow_run_id` 指针；`flow_resume` 支持只传 `session_id`，自动定位等待链入口、向下路由到等待中的子运行，再把结果逐层回传。
- 子会话进入 `waiting_human` 时会自动向父会话发一封 `question` 通知信（`refs.node_path` 指向该节点），父会话可在收件箱直接看到。

### 子会话多轮讨论

- 构建过程中收到的任意 `context` / `question` 信件，会在下一次节点会话前刷新进 `build.mailbox`（注入最近 5 封）并标记已读，因此不必等整轮构建结束。
- 父会话对通知信的 `reply` 会作为 `answer` 自动投递给子构建：命中等待中的节点后以 `action: mailbox` 重建该节点并继续推进，无需切换会话；多轮请求可重复该过程。
- 在子会话内直接 `flow_build answer` 答复时，会同步把父会话中对应通知信标记为已解决，避免重复投递。

## 工具（MCP 全名）

| 工具 | 说明 |
|---|---|
| `rms-flow-runner__flow_plan` | 受理任务并开启会话：需求分析 → 必要时澄清（最多 3 轮）→ 检索经验生成草稿与待确认 `start` 动作，不执行节点 |
| `rms-flow-runner__flow_answer` | 回答会话的澄清问题，信息补足后自动进入规划 |
| `rms-flow-runner__flow_revise` | 启动前修订任务或规划方向并重新生成草稿 |
| `rms-flow-runner__flow_evaluate` | 按验收标准评估已结束运行；通过则 `accepted`，不通过只生成待确认 `replan` |
| `rms-flow-runner__flow_start` | 从已有 IR 直接创建并推进运行；手工入口，不经过 Planner |
| `rms-flow-runner__flow_invoke` | 按 `run_id` 复用已有定义的入口契约直接运行；不经过需求分析、澄清与规划，全确定性流程可零 LLM |
| `rms-flow-runner__flow_workspace` | 查看或设置会话工作目录；同时更新会话与未启动草稿，省略目录则重置为默认路径 |
| `rms-flow-runner__flow_define` | 保存/更新命名工作流定义，自动递增版本；`activate: false` 可只存不激活 |
| `rms-flow-runner__flow_defs` | 列出命名定义；传 `name` 返回版本列表与激活版本完整定义 |
| `rms-flow-runner__flow_build` | Building 阶段：`start` 生成骨架并开工（传 `from_run_id` + `node_id` 则接手父草稿的子流程占位并自动回填），`step` 推进一个节点，`run` 连续推进，`answer` 在归属子会话答复人工请求（父会话也可用 `flow_mail` 回复通知信），`status` 查看构建树与进度；完成时产出 `draft` 运行，需再用 `flow_confirm` 批准启动 |
| `rms-flow-runner__flow_sessions` | 查看会话树：不传参数返回全部根及其子树，传 `session_id` 只返回该子树（含子会话未读信件数与等待中的人工请求指针） |
| `rms-flow-runner__flow_mail` | 会话信箱：`send` 发信（`context`/`question`/`bug_report`/`note`/`answer`，`bug_report` 触发节点重建）、`inbox` 查收、`reply` 回复（回复子会话的人工请求信会自动注入答案并继续该构建） |
| `rms-flow-runner__flow_resume` | 提交人工节点 JSON 输入，或无输入恢复普通暂停；也可只传 `session_id` 定位等待链并自动向下路由、回传结果 |
| `rms-flow-runner__flow_supervise` | 草稿尚未执行时按指令走会话级修订并重新规划；运行中则分析轨迹生成结论和待确认干预建议（有 dsh agent 时可核对代码） |
| `rms-flow-runner__flow_confirm` | 批准或拒绝启动、暂停、终止、重规划、插入人工动作 |
| `rms-flow-runner__flow_get` | 传 `session_id` 读取会话阶段/澄清/假设/验收标准/评估/动作（含 `pending_human` 人工请求指针）；传 `run_id` 读取运行轨迹 |
| `rms-flow-runner__flow_list` | 列出会话（含未运行会话）及各版本状态 |
| `rms-flow-runner__flow_ui` | 返回面板地址：dsh 宿主不再加载本插件（常驻已由 `rms-flow-runner-v2` 接管，见 `/flow-runner-v2/`）；独立 MCP 下启动本地面板并自动分配端口 |

### 推荐：受理、澄清、规划、确认、执行、验收

```json
{
  "task": "规划一次清盘数据可见性的只读排查，关键现场验证必须等待人工输入",
  "experience_query": "清盘 数据可见性 现场验证"
}
```

`flow_plan` 返回会话视图。若 `session.status=clarifying`，用 `flow_answer` 提交回答：

```json
{ "session_id": "sess-...", "answer": "目标站点是 example.com，输出含页面标题即完成" }
```

信息足够后自动生成草稿，`session.status=awaiting_confirm`，`runs[0]` 为草稿运行，`actions` 中有待确认 `start` 动作。此时没有执行任何节点。将返回的 `run_id` 与 start `action_id` 交给 `flow_confirm`：

```json
{
  "run_id": "flow-...",
  "action_id": "action-...",
  "approved": true
}
```

批准后才开始按 IR 推进。运行结束会自动调用验收评估员：满足验收标准则 `session.status=accepted`；不通过只生成待确认的 `replan` 草稿，须再次 `flow_confirm` 才会创建递增 `definition_version` 的新运行并重跑，旧运行标记为 `superseded`。关键状态仍会自动进行监督分析，也可调用 `flow_supervise` 手动分析。

### 手工 IR 调用示例

```json
{
  "parent_session_id": "decision-clearance-001",
  "name": "清盘现场只读验证",
  "definition": {
    "version": 1,
    "fuel": 50,
    "entry": {
      "id": "root",
      "type": "sequence",
      "steps": [
        {
          "id": "premise",
          "type": "det",
          "op": "expr",
          "expr": { "visible": { "var": "visible" } }
        },
        {
          "id": "onsite",
          "type": "human",
          "label": "人机现场验证",
          "prompt": "请在本机扫码登录 RMS，完成只读复现后注入确认结果"
        },
        {
          "id": "result",
          "type": "det",
          "op": "expr",
          "expr": { "confirmed": { "var": "confirmed" }, "result": { "var": "result" } }
        }
      ]
    }
  },
  "input": { "visible": false }
}
```

返回 `status=waiting_human` 后，用 `flow_resume` 提交：

```json
{
  "run_id": "flow-...",
  "input": { "confirmed": true, "result": "empty-state-reproduced" }
}
```

也可调用 `flow_ui`，在页面的人工节点卡片中提交同样的 JSON。面板为三栏：左侧是工作流会话组及版本；中栏分为上下两块，上方是规划摘要、经验引用、最新监督结论和动作批准/拒绝，下方是跨版本监督消息与指令输入；右侧是可收起的运行事实栏，包含 DAG、逐步 Cin/Cout、人工恢复和运行事件。规划草稿及重规划草稿可在右侧预览 DAG，预览不代表已执行。侧栏收起后保留竖排标签、状态点和当前处理节点；点击窄条或「展开」即可恢复。

## 存储与 LLM 配置

- 默认运行目录：`%LOCALAPPDATA%/rms-flow-runner/runs`；可用工具参数 `data_dir` 或环境变量 `RMS_FLOW_RUNNER_DATA_DIR` 覆盖。
- 每次节点状态变化都会原子写入 `flow-*.json`；同一次恢复用 `.locks/` 防止 dsh/MCP 两个平面并发推进。
- LLM 默认复用 `DEEPSEEK_API_KEY` 或 `$DSH_HOME/.credentials.yaml`，无凭据时尝试本机 Ollama。
- 可用 `RMS_FLOW_LLM_BASE_URL`、`RMS_FLOW_LLM_API_KEY`、`RMS_FLOW_LLM_MODEL`、`RMS_FLOW_LLM_PROTOCOL`、`RMS_FLOW_LLM_TIMEOUT_MS`、`RMS_FLOW_LLM_MAX_TOKENS`（默认 16000）覆盖。
- 输出被 `max_tokens` 截断时（OpenAI 的 `finish_reason=length` 或 Anthropic 的 `stop_reason=max_tokens`）自动放大一倍额度重试一次（上限 32000）；截断残片不会被当成完整结果外泄，两次都截断才报错。
- 面板默认动态端口；可通过 `flow_ui.port` 或 `RMS_FLOW_UI_PORT` 指定。
- `agent` 节点与运行中监督只在 dsh 宿主内可用：默认只读工具白名单 `read,read_image,glob,grep`，可用 `RMS_FLOW_AGENT_TOOLS` 覆盖；单次会话超时 `RMS_FLOW_AGENT_TIMEOUT_MS`（默认 600000）。MCP 平面没有 agent 运行时，遇到 `agent` 节点会明确失败而不是静默降级。
- Building 的 coding agent 默认使用 `read,read_image,glob,grep,write,edit,bash,pwsh`，可用 `RMS_FLOW_CODING_AGENT_TOOLS` 覆盖；写文件和命令执行仍受当前工作区边界约束，preset 注入的作用域工具也按同一白名单在执行时拦截。
- 运行失败的 `script` 节点会把错误、Cin 和原 IR 回灌给局部修复会话，只替换失败节点并自动重跑；默认最多 2 次，可用 `RMS_FLOW_AUTO_REPAIR_MAX` 调整（0..8），超限进入 `exhausted` 并转人工。
- `script` 节点默认超时 `RMS_FLOW_EXEC_TIMEOUT_MS`（默认 120000），可用节点 `timeout_ms` 覆盖；`script`/`http` 在 MCP 与 dsh 平面都可用，无需 LLM。
- `tool` 节点在 dsh 宿主内可用，可调用的工具白名单为 `RMS_FLOW_TOOL_ALLOW`（默认 `read,read_image,glob,grep`），单次调用超时 `RMS_FLOW_TOOL_TIMEOUT_MS`（默认 120000）。

## 接入与验证

dsh 常驻已切换到 `rms-flow-runner-v2`（矩阵版本）：web profile 的用户层 `$DSH_HOME/profiles/web/cordis.patch.yml` 只登记 v2 的 `dsh/host.mjs`，`dsh web` 启动即挂载 `/flow-runner-v2/`，无需再传 `--patch`。旧版 `rms-flow-runner` 的 dsh 适配器不再登记（`/flow-runner/` 常驻停用），其 `flow_*` 工具仅在 MCP 平面保留。项目覆盖层 [`dsh/cordis.yml`](../../../dsh/cordis.yml) 只登记其余 rms 插件，同一插件不得两处重复登记。MCP 侧由 `mcp/server.mjs` 自动扫描。规约见 [`docs/dsh-plugin-spec.md`](../../../docs/dsh-plugin-spec.md)。

```powershell
# 行为与面板 API 测试
node --test "C:/Users/admin/Documents/trae_projects/rms_dsh/plugins/generic/rms-flow-runner/test/runner.test.mjs"

# dsh 配置冒烟：不传 --patch 也能看到 rms-flow-runner-v2 行（来自 profile 用户层）
pnpm dsh --profile web --dump-config
# 启动后验证 v2 常驻面板（旧版 /flow-runner/ 已停用）
#   http://127.0.0.1:3080/flow-runner-v2/api/health
"" | pnpm dsh acp --patch "C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml"

# MCP 平面
node "C:/Users/admin/Documents/trae_projects/rms_dsh/mcp/server.mjs"
```

MCP 握手与 `tools/list` 探针见 `docs/rms-dsh-mcp.md` §3.3。修改插件后需重载 Trae 窗口/MCP 客户端，当前会话才会出现新工具。
