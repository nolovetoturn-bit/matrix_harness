# Flow Runner V2：Fanout / Merge 数据流协议（评审稿）

## 1. 背景

当前 DAG 是严格线性数据流：

- 根入口 `inputs` 只提供给第一个节点；
- 之后每个节点的 Cin 只等于上一节点的 Cout；
- 一个输出只能沿一条边传给一个下游节点；
- `branch` / `or_else` 是二选一，`fold` / `loop` 是串行迭代，均不能表达“同一个输出分发给多个节点”。

因此像下面这种结构目前无法直接表达：

```
入口 {value}
        ├──> plus_one  Cin {value} → Cout {result}
        └──> keep_value Cin {value} → Cout 77
                          ↓
                 merge {value: 77, result: 78}
                          ↓
                 verify {value, result}
```

必须靠脚本回读 `input.json`、共享 workspace 文件等旁路方式绕开，既破坏 Cin/Cout 契约，也无法在图上表达。

本协议新增 **fanout（一对多分发）+ merge（多路汇合）**，只解决 fork-join 型 DAG；任意 N→N 端口图不在本阶段范围。

## 2. 目标

- 一个上游输出可被多个下游节点同时消费；
- 分支之间隔离：各自有 Cin/Cout、产物目录、步骤缓存；
- 分支结束后有明确的汇合节点，得到单一下游 Cout；
- 契约校验按字段级检查分支输入和汇合输入；
- DAG 图能画出“一对多”的数据边；
- 不改变现有 sequence / branch / fold / loop / or_else 语义，旧 DAG 保持兼容。

## 3. IR 扩展

### 3.1 fanout

```json
{
  "id": "calc",
  "type": "fanout",
  "label": "并行计算加一与保留原值",
  "inputs": {
    "value": "number，来自上游 Cin"
  },
  "outputs": {
    "plus_one": "object，plus_one 分支的 Cout",
    "value": "number，carry 透传的上游输入字段"
  },
  "input": { "var": "value" },
  "carry": ["value"],
  "branches": [
    {
      "id": "plus_one",
      "type": "group",
      "label": "加一子流程",
      "inputs": { "value": "number" },
      "outputs": { "result": "number" }
    }
  ],
  "collect": "keyed"
}
```

需要把上游字段一并交给下游时，用 `carry` 直接带上，不必再生成一个只做复制、实际会执行脚本的透传分支。

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 否 | 分支输入表达式；缺省为当前上游输入。表达式可读取当前输入字段。 |
| `branches` | 是 | 1..`RMS_FLOW_FANOUT_MAX`（默认 8）个分支节点；本阶段不允许分支内再嵌套 fanout。 |
| `carry` | 否 | 需要原样带入汇总输出的上游输入字段名；仅 `keyed` 支持，字段必须存在于 `inputs` 且不能与分支 id 重名。 |
| `collect` | 否 | `keyed`（默认）或 `array`。 |
| `outputs` | 是 | 汇合输出的字段契约；`keyed` 模式的键必须覆盖所有分支 id 与 carry 字段。 |

分支输入语义：

- 每个分支收到 **同一份** fanout 输入；
- 分支路径为 `/<fanout path>/<branch id>`；
- 每个分支独立走步骤缓存和产物目录；
- `carry` 字段在汇总时直接从这份输入复制，不经过任何分支节点。

汇总输出：

- `collect: "keyed"`：

```json
{
  "plus_one": { "result": 78 },
  "value": 77
}
```

`value` 来自 `carry`，不是分支输出。

- `collect: "array"`：

```json
[ { "result": 78 }, 77 ]
```

数组顺序与 `branches` 声明顺序一致。

### 3.2 merge

merge 是叶子节点，不执行外部脚本，只按映射重新组织 fanout 的汇总输出。

```json
{
  "id": "join",
  "type": "merge",
  "label": "汇合加一结果与原值",
  "inputs": {
    "plus_one": "object，来自 fanout 的 keyed 输出",
    "keep": "number，来自 fanout 的 keyed 输出"
  },
  "outputs": {
    "value": "number",
    "result": "number"
  },
  "mapping": {
    "value": { "var": "keep" },
    "result": { "var": "plus_one.result" }
  }
}
```

- `mapping` 的表达式作用域就是 merge 的 Cin（即 fanout 的汇总输出）；
- 输出字段必须与 `outputs` 声明一致；
- merge 不调用 LLM，也不写外部文件。

### 3.3 与现有控制流的组合

- fanout 可以出现在 sequence 的任何一步，也可以作为 branch / loop / fold 的 body；
- fanout 的 `branches` 只允许叶子节点（llm / agent / script / http / tool / human / group），不允许再嵌套 `fanout`；
- fanout 后面通常接 merge，但不强制；任何能消费 keyed 集合的节点都可以作为下游。

### 3.4 骨架条件分支 branch

骨架 planner 可以直接生成 `branch`，字段与 IR 对齐：

```json
{
  "id": "route",
  "type": "branch",
  "label": "按正负分流",
  "inputs": { "value": "number" },
  "outputs": { "result": "string" },
  "condition": { ">=": [{ "var": "value" }, 0] },
  "then": { "id": "positive", "type": "script", "inputs": { "value": "number" }, "outputs": { "result": "string" } },
  "else": { "id": "negative", "type": "script", "inputs": { "value": "number" }, "outputs": { "result": "string" } }
}
```

- `condition` 是作用于 branch Cin 的表达式 DSL；
- `then` 必选、`else` 可选；then/else 只能是叶子类型（可包含 group），不能再嵌套控制流；
- 两路的 Cin 只能来自 branch 的 inputs，Cout 必须覆盖 branch 声明的 outputs；
- 无 else 时，condition=false 会直接透传输入，因此 outputs 必须由 inputs 覆盖；
- branch 与 fanout/merge 一样属于控制节点，不参与节点实现与预构建进度，运行轨迹只记录真正执行的分支节点。

## 4. 运行时语义

### 4.1 执行

生成 pipeline 时：

```js
// /root/calc（fanout 是控制节点，不进 manifest.nodes）
const calcInput = runtime.evalExpr({ var: 'value' }, prev)
const branches = await runtime.fanout('/root/calc', {
  id: 'calc',
  branches: ['plus_one', 'keep'],
  collect: 'keyed',
}, calcInput)

// /root/join（merge 只做 mapping，不起子进程）
const joined = runtime.merge('/root/join', {
  id: 'join',
  mapping: { value: { var: 'keep.value' }, result: { var: 'plus_one.result' } },
}, branches)
```

- 分支并发执行时使用独立子进程；默认并发上限 4，可用 `RMS_FLOW_FANOUT_CONCURRENCY` 调整；
- 任一分支失败，fanout 整体失败，错误路径指向该分支的完整 path；
- 已成功分支的步骤缓存保留，重试 fanout 时只重跑失败/未完成分支；
- 取消标记和子进程树终止沿用现有 `state/cancel.json` 与 `terminateRun` 机制。

### 4.2 产物

每个分支独立落盘；fanout/merge 只是传值控制节点，不写执行产物：

```
nodes/root_calc_plus_one/{input.json,output.json,meta.json}
nodes/root_calc_keep/{input.json,output.json,meta.json}
```

- `run.trace` 只包含真正执行的节点，分支 path 为 `/root/calc/plus_one`、`/root/calc/keep`；
- fanout/merge 不进入 `run.trace`，只在 `run.log` 记录 `fanout_start / fanout_end / merge` 事件；
- 汇总值可在下游真实节点的 `input.json` 审计，不需要单独为控制节点落盘。

### 4.3 缓存

- 单个分支按原有 `path + node hash + input hash` 缓存；
- 分支实现变化只重跑该分支，不影响其它分支；
- fanout/merge 本身没有额外缓存层，二者是进程内传值。

## 5. 契约校验

### 5.1 fanout

- fanout `inputs` 字段必须由上游 Cout 提供（与现有线性规则一致）；
- 每个分支的 `inputs` 字段必须被 fanout 输入的字段覆盖；
- `collect: keyed` 时，fanout `outputs` 的键必须覆盖所有分支 id 与 `carry` 字段；
- `carry` 字段必须存在于 fanout `inputs`，不能与分支 id 重名，且只支持 `keyed`；
- 分支 id 必须唯一，且不能为空。

### 5.2 merge

- merge `inputs` 的字段必须由 fanout 汇总输出提供（keyed 分支 id 或 array 索引）;
- `mapping` 里引用的路径必须存在于 merge Cin；
- merge `outputs` 的字段必须能在 mapping 输出中找到。

### 5.3 错误示例

```
节点「join」的 Cin 需要 [keep]，但 fanout 汇总输出只有 [plus_one]
分支「keep」的 Cin 需要 [source]，但 fanout 输入只提供 [value]
```

契约校验在：

- 骨架生成后；
- 确认 DAG 前；
- 预构建前（兜底）。

## 6. DAG 图

- fanout 与 merge 用**菱形**表示，标注“传值 · 不执行”；矩形只表示真正执行的节点；
- fanout 菱形位于当前层，各分支并排画在下一层，边标签为“同输入”；
- 各分支到 merge 菱形画数据边，标签为分支 id；
- merge 菱形在下一层；
- 数据字段缺失时菱形描边标红（详情里显示缺哪些字段）；
- 入口/出口节点保持现有实现。

示例布局：

```
[入口 {value}]
      │ value
      ▼
[fanout calc]
   ├──同输入──> [plus_one] Cout result
   └──同输入──> [keep] Cout value
                         │
                         ▼
                     [merge join]
                         │ value, result
                         ▼
                     [verify_add_one]
                         │ verified
                         ▼
                      [出口]
```

## 7. 骨架生成与预构建

- 骨架节点类型新增 `fanout`、`merge`、`branch`；
- planner 仅在确实需要一对多分发时使用 fanout、需要条件执行时使用 branch，否则保持线性 sequence；
- 下游需要上游原始字段时用 `carry`，禁止再生成只做透传的分支节点；
- fanout 的分支节点照常逐节点实现；分支内禁止控制流；
- merge 不创建编码会话，直接由 `mapping` 合成 IR；
- fanout/merge 不参与节点实现与预构建进度，编译时直接合成控制结构；
- 预构建进度只记录真实分支：`entry/<fanout>/<branch>`；
- 子 matrix（group 分支）仍按现有 group 规则创建、验收；验收后再运行 fanout。

## 8. 兼容性

- 现有 definition / manifest 版本保持 `version: 1`；新类型为可选扩展；
- 未使用 fanout/merge 的 DAG 行为完全不变；
- 旧运行包重放不需要迁移；
- 新增 `RMS_FLOW_FANOUT_MAX`、`RMS_FLOW_FANOUT_CONCURRENCY` 两个环境变量。

## 9. 测试与验收

### 引擎

- fanout 两个分支收到同一输入；keyed/array 两种汇总输出；
- merge 按 mapping 重组；
- 单个分支失败 → fanout 失败 → 重试只重跑失败分支；
- 分支缓存命中；
- 取消时终止所有分支进程。

### 契约

- fanout 分支缺字段被拒绝；
- merge 引用不存在的分支字段被拒绝；
- branch 缺少 condition、then/else 契约越界被拒绝；
- 一个 Cout 分发给三个分支并通过 merge 汇合；
- branch then/else 按 condition 只执行其中一路。

### 面板

- 图上显示 fanout 分支、merge、数据边；
- fanout/merge 显示为菱形并标注“传值 · 不执行”；
- 缺失字段标红；
- 运行轨迹不包含 fanout/merge；
- 旧线性 DAG 布局不回归。

### 端到端

用当前 `mx_368e540b77dd` 的加一场景重写：

```
入口 {value}
fanout: plus_one + keep
merge: {value: keep, result: plus_one.result}
verify: {value, result} → {expected, result, verified}
```

运行 `value=77`，期望输出 `expected=78, result=78, verified=true`，且不再需要回读 `input.json`。

## 10. 需要确认的决策

1. fanout 分支默认**并发**执行（上限 4）还是默认串行、显式开启并发？建议并发。
2. 汇总输出默认 `keyed`，是否需要同时支持 `array`？建议保留。
3. merge 使用 `mapping` 表达式（建议），还是复用普通 `script` 节点？
4. 是否允许分支内嵌套 fanout？本期建议禁止，后续再评估。
5. 是否将 `fanout` / `merge` 暴露给骨架 planner（推荐），还是只允许 agent 手工写 definition？

确认后按以下顺序实施：

1. IR / 校验 / runtime / manifest；
2. 骨架生成与预构建；
3. 流程图；
4. 测试与真实 matrix 回归。
