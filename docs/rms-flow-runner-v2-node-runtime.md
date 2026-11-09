# rms-flow-runner-v2 · Node 运行时与工单协议（设计定稿）

> 状态：**待评审**（本文件只定义协议，不改实现）
> 适用范围：`plugins/generic/rms-flow-runner-v2` 的 DAG 运行层
> 目标：Airflow 式的“DAG 即代码”，同一段代码可执行、可回看；支持 LLM 会话与人工中断工单。

---

## 1. 术语

| 术语 | 含义 |
|---|---|
| matrix | 业务单元，包含需求、骨架、definition、子矩阵 |
| definition | 编译后的 Workflow IR（sequence/branch/loop/leaf 节点） |
| run | 一次运行，独立 runId、独立工作区、独立日志与产物 |
| package | 一次运行物化出的自包含目录（pipeline/manifest/runtime/nodes/state/tickets） |
| pipeline | `pipeline.mjs`，实际被 node 执行的 DAG 代码 |
| runtime | `runtime.mjs`，pipeline 调用的运行时库 |
| bridge | Node 子进程回调 dsh 的本机 HTTP 接口（LLM、宿主工具） |
| ticket | 人工中断工单，human 节点等待答复时生成 |

## 2. 目标与非目标

### 目标
1. 每个 run 有一个自包含、可读、可执行的 `pipeline.mjs`，控制流直接体现在代码里。
2. `pipeline.mjs` 是**实际执行入口**，不是展示用的伪代码。
3. 节点产物、日志、输入输出继续保持现有 `runs/<runId>/` 结构。
4. LLM 节点走 dsh 会话；每个 run 默认一个独立 LLM 会话。
5. human 节点可中断：写工单、进程退出、答复后从缓存继续。
6. 保持现有 matrix 状态机、验收、子矩阵、审批门禁不变。

### 非目标
1. 不引入 Python 作为主执行器；运行时统一 Node。
2. 不把 dsh 的工具权限模型搬进 Node 进程；宿主工具仍经 bridge 走 dsh 审批。
3. 第一版不做任意代码 DAG 解析（不把用户手写 Python/JS 反向解析成 IR）。

## 3. 总体架构

```
dsh / matrix service
  ├─ 编译 definition → package（pipeline.mjs + manifest.json + runtime.mjs）
  ├─ 启动 node 子进程执行 pipeline.mjs
  ├─ 通过 bridge 提供 LLM / 宿主工具 / 审批
  └─ 消费 pipeline 退出码：completed / waiting / failed

run package（runs/<runId>/）
  ├─ pipeline.mjs        实际执行的 DAG 代码
  ├─ manifest.json       节点元数据 + 原始 IR
  ├─ runtime.mjs         运行时库（每次运行复制，保证可复现）
  ├─ nodes/<id>/         节点实现与产物
  ├─ workspace/          本次运行共享文件区
  ├─ state/
  │   ├─ steps/<path>.json   已完成步骤缓存
  │   ├─ resume.json         人工答复注入
  │   └─ llm-session.json    本 run 的 dsh 会话
  ├─ tickets/<ticketId>.json 工单
  └─ run.log             运行事件日志（JSONL）
```

## 4. 运行包目录与生命周期

```
runs/<runId>/
  manifest.json
  pipeline.mjs
  runtime.mjs
  input.json
  output.json
  run.log
  workspace/
  nodes/<pathKey>/
    node.json          # 该节点的 manifest 切片（便于单节点复跑）
    input.json
    output.json
    error.json
    meta.json
    stdout.log
    stderr.log
    work/              # 脚本本体与执行目录
  state/
    steps/<pathKey>.json
    resume.json
    llm-session.json
  tickets/
    tk_xxx.json
```

- `pathKey`：路径去掉前导 `/`，非 `[A-Za-z0-9_-]` 替换为 `_`，截断 120 字符。
  例：`/root/write_hello` → `root_write_hello`。
- 运行完成后保留整个目录；清理策略另行定义（默认不自动删除）。

## 5. manifest.json v1

```json
{
  "version": 1,
  "engine": "node",
  "matrix_id": "mx_xxx",
  "run_id": "run-xxx",
  "name": "创建并校验 hello.txt",
  "created_at": "2026-10-30T10:00:00.000Z",
  "definition_hash": "sha256:...",
  "io_mode": "files",
  "workspace": "workspace",
  "entry": { " ...原始 definition.entry..." },
  "bridge": {
    "base_url": "http://127.0.0.1:3080/flow-runner-v2",
    "token_file": "state/bridge-token",
    "run_id": "run-xxx"
  },
  "nodes": {
    "/root/write_hello": {
      "path": "/root/write_hello",
      "node_id": "write_hello",
      "type": "script",
      "label": "写入 hello.txt",
      "hash": "sha256:...",
      "inputs": { "seed": "string" },
      "outputs": { "path": "string", "actualContent": "string" },
      "dir": "nodes/root_write_hello",
      "script": {
        "runtime": "node",
        "file": "work/main.cjs",
        "args": [],
        "timeout_ms": 60000,
        "output": "json"
      }
    },
    "/root/verify_hello": {
      "path": "/root/verify_hello",
      "node_id": "verify_hello",
      "type": "script",
      "label": "校验 hello.txt",
      "hash": "sha256:...",
      "dir": "nodes/root_verify_hello",
      "script": { "runtime": "node", "file": "work/main.cjs", "output": "json" }
    }
  },
  "control": {
    "kind": "sequence",
    "steps": ["/root/write_hello", "/root/verify_hello"]
  }
}
```

约定：
- `nodes` 的键是 trace 路径，与现有 `run.trace[].path` 一致。
- `control` 只是便于阅读/工具消费的摘要；真实控制流在 `pipeline.mjs`。
- `entry` 保留原始 IR，作为审计与回退依据。
- manifest 不内联大段脚本源码；源码在 `nodes/<pathKey>/work/main.<ext>`，用 `file` 引用。

## 6. pipeline.mjs 生成规则

### 6.1 基本形态

```js
import { createRuntime } from './runtime.mjs'

const runtime = await createRuntime()

try {
  const cin = await runtime.start()
  const v1 = await runtime.step('/root/write_hello', cin)
  const v2 = await runtime.step('/root/verify_hello', v1)
  await runtime.finish(v2)
} catch (error) {
  await runtime.fail(error)
}
```

要求：
1. 代码必须可被 `node pipeline.mjs` 直接执行。
2. 每个叶子节点一次 `runtime.step(path, input)`；输入输出与 IR 语义一致。
3. 控制节点直接生成 JS 控制流，保证可读：
   - `sequence`：顺序 `const vN = await runtime.step(...)`
   - `branch`：`if (runtime.evalExpr(cond, scope)) { ... } else { ... }`
   - `fold`：`for (const [index, item] of runtime.items(expr, scope).entries()) { ... }`
   - `loop`：`while (runtime.evalExpr(whileExpr, scope)) { ... }`，带 `max_iterations`
   - `or_else`：`try { primary } catch/failure { fallback }`
4. `runtime.step` 内部处理**步骤缓存**：命中则跳过执行，直接返回缓存输出。
5. 不允许在 pipeline 中直接 `import` 业务脚本；脚本只能通过 `runtime.step` 执行。

### 6.2 生成示例（branch + human）

```js
import { createRuntime } from './runtime.mjs'
const runtime = await createRuntime()

try {
  const cin = await runtime.start()
  const v1 = await runtime.step('/root/collect', cin)

  let v2
  if (runtime.evalExpr({ field: 'rows.length', op: 'gt', value: 0 }, v1)) {
    v2 = await runtime.step('/root/process', v1)
  } else {
    v2 = await runtime.step('/root/empty', v1)
  }

  const approved = await runtime.step('/root/approve', v2) // human 节点：无答复时写工单并退出
  await runtime.finish(approved)
} catch (error) {
  await runtime.fail(error)
}
```

## 7. runtime.mjs API

### 7.1 工厂

```js
const runtime = await createRuntime({
  runDir: process.env.RMS_RUN_DIR,
  resume: process.argv.includes('--resume'),
})
```

### 7.2 方法

| 方法 | 语义 |
|---|---|
| `start()` | 读取 `input.json`，作为 Cin |
| `step(path, input)` | 按 manifest 分派节点；处理缓存、产物、日志；返回 Cout |
| `evalExpr(expr, scope)` | 与解释器一致的表达式求值（唯一语义来源） |
| `items(expr, scope)` | fold 的数组求值 |
| `finish(output)` | 写 `output.json`，退出码 0 |
| `fail(error)` | 写 `error.json`，退出码 1 |
| `waiting(ticket)` | 写工单/checkpoint，退出码 75 |
| `hash(value)` | 与解释器一致的 canonical JSON hash |

### 7.3 步骤缓存

`state/steps/<pathKey>.json`：

```json
{
  "version": 1,
  "path": "/root/write_hello",
  "node_id": "write_hello",
  "node_hash": "sha256:...",
  "input_hash": "sha256:...",
  "status": "completed",
  "output": { "...": "..." },
  "details": { "runtime": "node", "exit_code": 0 },
  "artifact_dir": "nodes/root_write_hello",
  "started_at": "...",
  "finished_at": "..."
}
```

命中条件：`node_hash` 与 `input_hash` 完全一致且 `status=completed`。
- 人工答复后重放时，已完成步骤全部命中；human 节点读取 `state/resume.json` 后写入缓存并继续。
- 节点代码或输入变化时缓存失效，重新执行。

### 7.4 文件式 I/O 契约

- `RMS_INPUT_FILE`：节点输入 JSON。
- `RMS_OUTPUT_FILE`：节点输出 JSON（优先读取）。
- `RMS_RUN_DIR`：本次运行共享目录（跨节点传文件）。
- `RMS_ARTIFACT_DIR`、`RMS_NODE_DIR`、`RMS_NODE_ID`、`RMS_RUN_ID`。
- 兼容：仍向 stdin 写 Cin，stdout 可作为 Cout（未写 output.json 时）。
- node 脚本可用 ESM 或 CommonJS；扩展名按语法自动选择。

### 7.5 退出码

| 退出码 | 含义 | dsh 侧状态 |
|---|---|---|
| 0 | completed | completed |
| 1 | failed | failed（读取 `error.json`） |
| 75 | waiting_human | waiting_human（读取工单） |
| 2 | 包/manifest 非法 | failed |
| 3 | bridge 不可用（LLM/宿主工具） | failed（可重试） |

### 7.6 取消

dsh 写 `state/cancel` 后，runtime 在每个 `step` 前检查；命中则以退出码 0 + `status=cancelled` 结束。超时由 dsh kill 进程树兜底。

## 8. 节点映射

| IR 节点 | runtime 行为 | 依赖 |
|---|---|---|
| script | 子进程执行，文件式 I/O | 本地运行时 |
| http | Node fetch | 本地网络 |
| subflow | 调用子 matrix 的 `pipeline.mjs`（独立 runId/工作区） | 子包已生成 |
| tool | 调 bridge `/bridge/tool`；或本地 tool 脚本 | dsh 审批 |
| llm | 调 bridge `/bridge/llm`；使用本 run 会话 | dsh 会话 |
| agent | 调 bridge `/bridge/agent`（可带工具） | dsh 会话/审批 |
| human | 无答复→工单+退出 75；有答复→继续 | 工单系统 |

控制节点（sequence/branch/fold/loop/or_else）不产生 step，直接生成 JS 控制流；`det` 节点按现有语义作为本地断言/表达式步骤。

### subflow
- 调用子 matrix 的 package；输入/输出仍通过 `input.json`/`output.json`。
- 子 run 拥有独立 `runs/<childRunId>/`，父 run.log 记录 `subflow_run_id`。
- 子 matrix 未验收/不可运行时直接失败，与现有门禁一致。

### tool
- 第一版仅放行现有 `toolRunner` 白名单；参数经 manifest 的 `tool` 字段传入。
- 返回 `{ value }`；错误转成节点失败。
- 宿主工具调用必须复用现有 approval policy。

## 9. LLM 运行时

### 9.1 会话策略
- **每个 run 默认一个独立 dsh 会话**：`<runId>-llm`。
- 首次 LLM 节点时创建并写入 `state/llm-session.json`；运行结束 dispose（持久化日志保留）。
- 可选 `session: "per-node"` 让单个节点独立会话（manifest 字段）。
- 会话 cwd = run workspace，工具按现有只读/编码策略限制。

### 9.2 bridge 请求

`POST /api/runs/:runId/bridge/llm`

```json
{
  "node_id": "summarize",
  "path": "/root/summarize",
  "system": "可选",
  "prompt": "用户提示词",
  "input": { "任何 JSON" }
}
```

响应：

```json
{
  "text": "模型输出",
  "session_id": "run-xxx-llm",
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

### 9.3 bridge 鉴权
- `state/bridge-token`（0600）由 dsh 生成；请求头 `x-rms-run-token`。
- 仅允许 loopback；校验 `runId` 与 token；拒绝跨 run。
- 日志记录每次调用的 node/path/耗时。

## 10. 人工中断与工单协议

### 10.1 工单 schema

```json
{
  "version": 1,
  "id": "tk_xxx",
  "run_id": "run-xxx",
  "matrix_id": "mx_xxx",
  "root_matrix_id": "mx_root",
  "node_id": "approve",
  "path": "/root/approve",
  "kind": "human",
  "prompt": "请确认是否继续",
  "input": { "任何 JSON" },
  "status": "open",
  "answer": null,
  "created_at": "2026-10-30T10:00:00.000Z",
  "answered_at": null,
  "answered_by": null,
  "resume_attempt": 0
}
```

状态：`open → answered | cancelled`。

### 10.2 生命周期

1. human step：无答复 → 写工单 + `state/checkpoint.json` → 退出码 75。
2. dsh：run.status=`waiting_human`，run.pending=`{path,node_id,ticket_id,prompt}`；archive/镜像一条事件。
3. 用户或 agent 答复：写 `state/resume.json`：
   ```json
   { "/root/approve": { "answer": {...}, "ticket_id": "tk_xxx", "answered_at": "..." } }
   ```
4. dsh 重新拉起 `node pipeline.mjs --resume`；已完成步骤命中缓存，human 节点读取答复并继续。
5. 工单标记 answered；run 继续；若再次遇到 human 节点则生成新工单。

### 10.3 工单 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/matrix/:matrixId/tickets?status=open` | 当前 matrix 工单 |
| GET | `/api/tickets?status=open` | 全局未处理工单 |
| GET | `/api/tickets/:ticketId` | 工单详情 |
| POST | `/api/tickets/:ticketId/answer` | `{ answer, answered_by }` → 恢复 run |
| POST | `/api/tickets/:ticketId/cancel` | 取消工单并终止 run |

### 10.4 面板
- “工单”卡片：当前 matrix 的未处理工单，显示节点、提示、输入，提供答复框。
- 答复后自动刷新 run 状态；dsh 会话同步显示“新工单/已答复”事件。
- agent 工具 `matrix_tickets`：`list` / `answer`（answer 需用户明确同意）。

## 11. 与现有实现的兼容

1. `execution_mode` 继续保留：`files` / `inline` 只影响节点 I/O。
2. **运行引擎直接切换为 Node，不保留双引擎**：
   - 删除解释器执行路径（`advanceRun` 不再作为运行入口）；
   - `pipeline.mjs` 是唯一运行入口，每次运行生成。
3. 节点类型迁移顺序：script/http → subflow → llm → human/ticket → tool/agent。
4. 用现有解释器作为一次性 golden 对照（仅测试期），验证后移除。
5. 旧的 run 记录保留可查看，但不再支持从旧 run 继续执行。

## 12. 安全与权限

- bridge 只监听 loopback，token 每 run 一份，过期即失效。
- tool 节点必须走 dsh approval policy；Node 进程不得直接获得 shell 权限。
- LLM/agent 会话沿用现有工具白名单与审批。
- 工单答复记录 `answered_by`（user/agent）；agent 代答必须可审计。

## 13. 日志与可观测性

`run.log` 每行：

```json
{ "at": "...", "run_id": "...", "phase": "step_start|step_end|waiting|resume|bridge|finish", "path": "/root/write_hello", "node_id": "write_hello", "status": "value|failed|waiting", "duration_ms": 123 }
```

- 面板运行弹窗增加“运行代码”页签：展示 `pipeline.mjs`，并可按节点跳转到 `nodes/<pathKey>/work` 与产物。
- `matrix_run_artifacts` 继续可用；新增返回 `pipeline` 路径与文本。

## 14. 测试与验收

1. **包生成**：同一 definition 生成的 manifest/pipeline 结构稳定（golden 文件）。
2. **script/http/subflow**：与解释器输出逐字节一致。
3. **缓存重放**：重复运行命中缓存，不重复产生副作用；输入变化后失效。
4. **LLM**：每 run 会话唯一；两次运行不共享上下文；bridge 鉴权失败被拒绝。
5. **工单**：human 节点退出 75；答复后从断点继续；取消后 run 终止。
6. **失败**：节点失败写 `error.json`，run status=failed；重试可只重跑失败步骤。
7. **安全**：非 loopback、错误 token、跨 run 调用直接 401/403。

## 15. 已确认决策（2026-11-02）

1. **LLM 会话粒度：每 run 一个会话**，运行内复用；节点可用 `session: "per-node"` 覆盖。
2. **工单范围：只做 matrix 内工单**，不做全局工单中心。
3. **tool 节点全放行**：不限制工具白名单，但必须经 dsh bridge 并复用现有 approval policy。
4. **`pipeline.mjs` 每次运行生成**，与本次输入和节点代码绑定。
5. **只使用 Node 引擎，不保留双引擎**；解释器路径在迁移完成后删除。
6. **运行包按数量清理**：`RMS_FLOW_RUN_KEEP`（默认 100），超出后删除最旧的运行包与记录。

---

## 附录 A：pipeline.mjs 完整示例

```js
// runs/run-xxx/pipeline.mjs
import { createRuntime } from './runtime.mjs'

const runtime = await createRuntime()

try {
  const cin = await runtime.start()

  const collected = await runtime.step('/root/collect', cin)

  let processed
  if (runtime.evalExpr({ field: 'rows.length', op: 'gt', value: 0 }, collected)) {
    processed = await runtime.step('/root/process', collected)
  } else {
    processed = await runtime.step('/root/empty', collected)
  }

  const approved = await runtime.step('/root/approve', processed)
  await runtime.finish(approved)
} catch (error) {
  await runtime.fail(error)
}
```

## 附录 B：工单答复后的恢复流程

```
POST /api/tickets/tk_xxx/answer {answer}
  → 写 runs/<runId>/state/resume.json
  → run.status = running
  → spawn node pipeline.mjs --resume
      → step 缓存命中：collect/process 跳过
      → human('/root/approve') 读取 resume.json → 写缓存 → 继续
  → run.status = completed
  → ticket.status = answered
```

## 附录 C：错误码

| code | 场景 | 处理 |
|---|---|---|
| `PACKAGE_INVALID` | manifest/目录缺失 | run failed |
| `STEP_TIMEOUT` | 节点超时 | 节点 failed，可重试 |
| `BRIDGE_UNAUTHORIZED` | token/run 不匹配 | run failed，不重试 |
| `BRIDGE_UNAVAILABLE` | dsh 未启动 | run failed，可重试 |
| `TICKET_CANCELLED` | 工单取消 | run cancelled |
| `REPLAY_MISMATCH` | 缓存 node_hash 不一致 | 丢弃缓存并重新执行 |
