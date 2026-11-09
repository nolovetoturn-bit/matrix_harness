# rms-flow-runner：Matrix 架构重构方案

> 本文是重构的唯一需求与设计基线。实现时先按本文落地，遇到本文未覆盖的细节，以“每个 matrix 都是同一套单元、树结构是唯一事实来源、跨 matrix 只走信箱”三条原则推导。
>
> 旧模型（根会话 / 子会话 / 构建栈 / 回填）全部废弃，不复用旧数据。

## 1. 背景与结论

现有模型把“根会话”和“子会话”当成两种身份：子会话只能构建+等待验收回填，根会话才能运行；再叠加全局构建栈、层会话、自底向上回填、整栈暂停，导致验收状态反复横跳、子会话不是一等单元。

重构结论：**统一为 matrix（矩阵）**。每个 matrix 都是可独立运行、可独立验收、可递归包含其它 matrix 的业务单元；树结构本身表达构建与验收顺序，不再需要全局构建栈。

## 2. 核心概念

- **matrix**：唯一业务单元。
  - 一个 matrix 对应**一个 dsh 会话**作为运行时（每个节点都建会话，含规划/骨架阶段）。
  - 拥有：需求与澄清、骨架 DAG、预构建结果（definition）、子 matrix 列表、运行记录、信箱、dsh 会话、独立工作目录。
  - 所有 matrix 的页面/状态机/操作完全一致，根与子没有特殊分支。
- **matrix 树**：节点可以递归引入其它 matrix 节点（subflow）。父 matrix 的 DAG 中，子流程节点引用子 matrix（按 id 引用），不内联定义。
- **跨 matrix 通信**：唯一通道是**信箱**。禁止跨会话直接读写对方状态；状态派生（子验收→父可运行）是结构计算，不算通信。
- **会话消息**：每个 matrix 的会话流里同时存在两类消息，UI 用同一时间线渲染并区分：
  - `chat`：用户的沟通/指令 + agent 的需求澄清、DAG 意见回复等对话消息。
  - `agent`：系统/监督/构建事件（需求分析结果、节点进度、运行轨迹、验收结论、信箱事件摘要）。
- **运行记录**：每个 matrix 有各自的运行记录（run），互不共享。

## 3. 状态机

### 3.1 门禁态（稳定态）

| 状态 | 标识 | 进入条件 | 可执行操作 |
|---|---|---|---|
| 待确认需求 | `awaiting_requirement` | 已受理，需求分析认为信息足够 | 提需求修订、开始生成 DAG |
| 待构建 DAG | `awaiting_dag` | 骨架 DAG 已生成 | 确认 DAG、提交修改意见重新生成 |
| 待预构建 | `awaiting_prebuild` | DAG 已确认 | 确认启动预构建、查看只读 DAG |
| 可运行 | `runnable` | 自身预构建完成 **且** 全部直接子 matrix 已验收 | 运行、验收（验收按钮仅此状态显示） |
| 已验收 | `accepted` | 人工验收通过 | 只读查看；父 matrix 状态重算 |

### 3.2 瞬态

| 状态 | 标识 | 说明 |
|---|---|---|
| 澄清中 | `clarifying` | 需求不足，等待用户回答；回答后回到 `awaiting_requirement` 或直接 `awaiting_dag` |
| 构建中 | `building` | 正在逐节点预构建（节点编码） |
| 等待人工 | `waiting_human` | 节点需要人工输入，等待在会话里答复 |
| 失败 | `failed` | 可重试；只影响本 matrix，不暂停其它 matrix |
| 已终止 | `cancelled` | 人工终止，保留数据 |

### 3.3 状态转移

```
受理 → (需求分析)
      ├─ 信息不足 → clarifying → 回答 → 需求分析
      └─ 信息足够 → awaiting_requirement
awaiting_requirement → 生成骨架 DAG → awaiting_dag
awaiting_dag → (提交意见) → 重新生成 DAG → awaiting_dag
awaiting_dag → 确认 → awaiting_prebuild
awaiting_prebuild → 确认启动 → building
building → 节点需要人工 → waiting_human → 答复 → building
building → 失败 → failed → 重试 → building
building → 自身预构建完成：
          ├─ 存在未验收子 matrix → 等待（不作为门禁态，展示“等待子矩阵验收”）
          └─ 全部子 matrix 已验收 → runnable
runnable → 人工验收 → accepted
```

### 3.4 关键规则

1. **可运行条件**：`自身预构建完成 && 所有直接子 matrix 状态 == accepted`。
2. 子 matrix 变为 `accepted` 时，**自底向上重算父 matrix 状态**：父若已预构建完成且全部子已验收 → `runnable`；否则保持不变。
3. **验收按钮只在 `runnable` 显示**，位置固定在右侧 DAG 图上方。
4. 已验收的 matrix 不允许再回到未验收状态；如需修改，创建新的子版本 matrix（新 matrix，父引用切换），旧 matrix 保持 accepted 归档（此点作为实现时的强约束，避免“验收回退”）。
5. 运行与验收独立：运行失败只影响该 matrix 的运行记录，不改变其门禁状态；验收只由人工在 `runnable` 触发。

## 4. 会话与输入路由

每个 matrix 一个 dsh 会话，`parentSession` 按 matrix 树挂接；节点编码会话仍以 `origin: subagent` 隐藏。matrix 的 cwd 独立（建议 `<data>/matrix/<matrixId>/work`），节点编码会话使用其下 `.nodes/<node>` 目录。

**统一会话区**：中栏是单一消息流（`chat` 与 `agent` 两类消息按时间线混排并区分样式）+ 单一输入框。输入按当前状态自动路由：

| 当前状态 | 输入含义 | 后端动作 |
|---|---|---|
| `clarifying` | 回答澄清问题 | 需求分析（可再次 clarifying 或进入 `awaiting_dag`） |
| `awaiting_requirement` | 需求修订 / 补充 | 重新分析需求 |
| `awaiting_dag` | 对 DAG 的修改意见 | 重新生成骨架 DAG |
| `awaiting_prebuild` | 修订需求/重新生成 DAG（可选） | 回到 `awaiting_dag` |
| `waiting_human` | 回答节点提出的人工问题 | 继续构建 |
| `building` | 追加指令/说明 | 注入下一次节点会话（信箱） |
| `runnable` / `accepted` | 监督分析 / 运行修订意见 | 监督分析（只读，不直接改定义） |
| `failed` | 重试说明 | 重试失败节点 |

UI 上输入框上方显示当前路由提示（例如“当前输入将作为 DAG 修改意见”），避免用户误判。

## 5. 数据模型（全新目录，旧数据废弃）

新数据目录：`<LOCALAPPDATA>/rms-flow-runner/matrix/`（旧 `runs/` 下内容不再读取；确认新模型稳定后可整体删除）。

### 5.1 `matrix-<matrixId>.json`

```jsonc
{
  "id": "mx_...",
  "name": "…",
  "task": "…",                     // 本 matrix 的需求
  "state": "awaiting_requirement", // 见状态机
  "parent_id": "mx_... | null",
  "root_id": "mx_...",
  "depth": 0,
  "analysis": { "sufficient": true, "questions": [], "summary": "…" },
  "clarifications": [ { "question": "…", "answer": "…" } ],
  "assumptions": [],
  "acceptance_criteria": [],
  "skeleton": { "version": 1, "entry": { } },       // 骨架 DAG（只读渲染）
  "definition": null,                                // 预构建完成后编译的定义
  "children": [ { "node_id": "…", "node_path": "…", "matrix_id": "mx_..." } ],
  "dsh_session_id": "…",
  "cwd": "…",
  "run_ids": [],
  "mailbox": { "mails": [], "total": 0 },
  "error": null,
  "history": [],
  "created_at": "…",
  "updated_at": "…"
}
```

### 5.2 run（沿用现有运行记录结构，改归属）

- `run.parent_matrix_id` 取代 `parent_session_id`。
- 运行的子流程节点携带 `matrix_id` 引用；执行时调用该 matrix 的独立运行。
- 每个 matrix 的 `run_ids` 只包含自己的运行。

### 5.3 删除的数据

`buildstack-*.json`、`build-*.json`、旧的 `session-*.json`/`flow-*.json` 模型字段（构建栈、层会话、回填、`awaiting_accept` 语义）全部不再使用。

## 6. 执行语义

1. **预构建**：在 matrix 内逐节点编码；遇到子流程节点时，**创建/关联子 matrix**（每个子节点一个 matrix + dsh 会话），不内联展开；本 matrix 自身预构建在子 matrix 存在期间可继续完成，但进入 `runnable` 必须等所有子 `accepted`。
2. **运行**：父 matrix 运行到子流程节点时，**调用子 matrix 的运行**，子运行有独立 run 记录与输出，父运行通过节点契约接收子输出；子 matrix 未处于 `runnable/accepted` 时父不可运行（由状态规则保证）。
3. **失败与重试**：任何失败只落在本 matrix（或本 matrix 的某次子运行），重试只重置对应节点/子运行，不波及其它 matrix。
4. **并发**：每个 matrix 一把锁；同一 matrix 同时只允许一个预构建/运行推进任务。不同 matrix 可并行。

## 7. 导航

- **「下一个未验收」按钮**：对当前 matrix 子树做深度优先遍历（先序、左→右），返回第一个满足“尚未验收且没有未验收后代”的节点（即最深、最左的可操作叶子）；已验收子树整体跳过；若当前子树全部验收，则沿父链向上寻找最近一个未验收的兄弟/祖先分支。
- **「返回父级」按钮**：仅导航到 `parent_id`，不改变任何状态。
- **面包屑**：根 → … → 当前 matrix，可点击跳转。

## 8. 面板 UI（每个 matrix 一页，布局一致）

- 顶部：matrix 名称、状态徽标、面包屑、`下一个未验收` / `返回父级`。
- 中栏（会话区）：统一消息流（chat / agent 两种样式）+ 单一输入框（状态路由提示）。不再区分“监督会话”和“沟通需求会话”。
- 右栏：
  - **DAG 图**：骨架期为只读骨架（占位节点标注“待子构建”）；`runnable` 后展示最终 definition。
  - **验收按钮**：固定在 DAG 图上方，仅 `runnable` 显示。
  - **运行记录**：该 matrix 的历史运行（独立列表，可进入查看 trace/输出）。
  - **节点/进度**：当前构建节点、尝试次数、耗时、节点会话 id、最近节点会话列表。
  - **错误与重试**：失败卡片 + 重试按钮。
  - **信箱**：该 matrix 的收发消息（跨 matrix 唯一通信通道）。

## 9. 后端接口（建议）

- `GET /api/matrix/tree`：整棵树（含状态、子引用）。
- `GET /api/matrix/:id`：matrix 详情（含 definition、children、runs、mailbox、会话消息）。
- `POST /api/matrix/:id/:action`，action ∈
  `intake` / `answer` / `revise` / `confirm-dag` / `prebuild` / `retry` / `accept` / `run` / `evaluate` / `cancel`。
- 后台推进：按 matrix 串行队列（per-matrix queue），面板 3 秒轮询展示进度；不再有全局构建栈驱动。
- dsh 工具：`flow_*` 系列保留对外形态，内部改为 matrix 语义（必要时新增 `matrix_*` 并保留旧工具名做别名）。

## 10. 必须删除/替换的现有实现

- `buildstack-*.json` 及 `driveStack` / `queueStackDrive` / `refreshStackStatus` / `PAUSE_STATUSES` / `SETTLED_STATUSES`。
- 层会话（`ensureRootLayerSession`）与层链逻辑。
- `startHandoffBuild` / `startNestedBuild` / `applyNestedBackfill` / `applyHandoffBackfill` / 占位回填。
- 子会话 `awaiting_accept` 语义、根/子两套分支（`finalizeBuild` 中的 child 分支）。
- 面板上的“构建栈”“子会话需求/验收门禁”等旧交互（由 matrix 页面替代）。

## 11. 重构步骤（建议顺序）

1. **P0 基础**：matrix schema、状态常量、事件（`matrix/accepted` 触发父状态重算）、纯函数状态机。
2. **P1 存储与树**：matrix store（读写/遍历/DFS 导航）、树 API。
3. **P2 需求与 DAG**：受理、需求分析/澄清、骨架生成、DAG 修订、确认。
4. **P3 预构建**：每 matrix 节点编码（复用现有 runner/工作目录隔离/审批策略）；子流程节点创建子 matrix + 会话；失败重试。
5. **P4 运行**：matrix 独立运行；子流程节点调用子 matrix 运行；运行记录按 matrix。
6. **P5 验收**：`runnable` 判定与验收；子验收 → 父状态重算；验收后只读归档。
7. **P6 UI**：重写为统一 matrix 页面（会话流/右栏 DAG/验收按钮/运行记录/导航/信箱）。
8. **P7 清理**：删除旧栈/回填/层会话代码与旧数据读取；补文档与测试。
9. **P8 验证**：端到端跑一棵 3 层树（每层一个子流程），验证状态、导航、运行、验收、重试。

## 12. 测试策略

- 状态机单测：所有门禁态/瞬态转移，非法转移拒绝。
- 树派生：子验收→父 `runnable`；部分子未验收→父不可运行。
- DFS 导航：最深最左未验收叶子、已验收子树跳过、全验收向上寻找、返回父级。
- 会话/消息：chat 与 agent 消息分类；输入按状态路由。
- 预构建：每节点建会话；子节点创建子 matrix；节点工作目录隔离；失败重试只影响本 matrix。
- 运行：子流程节点调用子 matrix 运行并拿到输出；子运行失败不影响父状态。
- 验收：仅 `runnable` 显示/接受验收；验收后父状态重算。
- 面板冒烟：每 matrix 页面一致、验收按钮位置与显隐、运行记录、导航按钮。

## 13. 完成定义（DoD）

- 每个节点都有独立 dsh 会话，侧栏成树。
- 每个 matrix 页面布局、状态机、消息区完全一致；会话区合并 chat/agent 消息。
- `可运行` 严格满足“自身预构建完成 && 全部子矩阵已验收”。
- 验收按钮仅在 `runnable` 出现，且在右侧 DAG 上方。
- 每个 matrix 有独立运行记录；父运行子流程时调用子矩阵运行。
- 「下一个未验收」「返回父级」按本文行为工作；无全局构建栈。
- 旧数据/旧代码不再参与运行。

## 14. 已确认的决策（来自需求方）

1. 每个节点都建 dsh 会话（含规划期）。
2. 父 matrix 执行子流程 = 调用子 matrix 的独立运行（非内联）。
3. 监督与需求沟通合并为同一会话，消息按 `chat` / `agent` 区分。
4. 除 5 个门禁态外，加入澄清中、构建中、等待人工、失败、已终止等瞬态。
5. 「下一个未验收」按 DFS 取最深、最左的未验收节点；「返回父级」只导航。
6. **新起数据，旧数据全部废弃**（不做迁移）。

## 15. 风险与实现注意

- **会话数量**：每个节点一个 dsh 会话，深树会很多；UI 侧栏需虚拟化/懒加载，避免一次渲染过多节点。
- **循环引用**：matrix 引用子 matrix 时必须做环检测（禁止 A→B→A）。
- **运行嵌套**：调用子 matrix 运行时需限制递归深度与并发，输出通过节点契约回传。
- **状态重算**：子验收触发父重算要幂等，避免重复事件导致状态抖动。
- **删除顺序**：先停止旧驱动与面板旧入口，再删数据文件读取逻辑，最后清旧数据目录。
