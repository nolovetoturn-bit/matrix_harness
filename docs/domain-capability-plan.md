# Domain 能力套件规划（供后续会话继续实施）

> 本文记录已确认的设计决策、当前实现状态、后续改造方案与验收标准。
> 后续会话从「实施阶段」P1 开始，不需要重新讨论已确认项。

---

## 0. 已确认决策

1. 一个项目可以有多个 Domain（限界上下文）。
2. Domain 会话挂在项目会话下；Domain 有自己的记忆（`DOMAIN_MEMORY.md`）。
3. 每个 Model / Stub / Interact **只挂一个根 matrix**（1:1）。复合结构在根 matrix 的 DAG 内用 `group` 节点拆分，由预构建生成子 matrix。
4. Model 只分三种角色：
   - `request`：请求 DTO
   - `response`：返回 DTO
   - `persistence`：持久化模型
   - **去掉 `aggregate`**；聚合根在实践中常等同于 DTO，不再单独建模。
5. Stub 的每个 operation 声明 `request model(s) → response model(s)`；Stub 只允许在**同一 Domain 内**被调用。
6. Interact 只描述业务流程，**不保存 UI 规范**，以保证前端规范适应性。
7. Matrix 新增节点类型：
   - `persist`：对 persistence model 的 CRUD
   - `stub`：调用领域 Stub 的某个 operation
8. Interact 的 matrix **禁止 `persist` 节点**，**允许 `stub` 节点**。
9. Domain 需要支持 **export / import**：对外暴露一组 Model 和 Stub 契约。
10. 新增领域能力检索插件：通过子会话按需求检索已有 Domain / Stub 能力。

---

## 1. 当前已实现状态（不要重做）

插件根：

```
c:/Users/admin/Documents/trae_projects/rms_dsh/plugins/generic/rms-flow-runner-v2
```

已有能力：

- `lib/domain/schema.mjs`：`dom_/mdl_/stb_/itx_` id、Model/Stub/Interact 归一化。
- `lib/domain/store.mjs`：`domain-dom_*.json`、Domain 锁、`domainWorkDir`。
- `lib/domain/memory.mjs`：Domain 记忆与 `DOMAIN_MEMORY.md`。
- `lib/domain/session.mjs`：Domain 会话挂到项目会话；同 workspace；brief 注入领域记忆。
- `lib/domain/service.mjs`：Domain CRUD、元素 upsert/remove、`domain_matrix_intake`（1:1）、`domain_bind_matrix`、`domain_chat`、`domain_memory`、`domain_summary`。
- Project 记录有 `domain_ids`；Matrix 记录有 `domain_binding`。
- Matrix 会话层级：项目会话 → 领域会话 → 元素根 matrix 会话 → 子 matrix 会话。
- Panel：项目「领域」页签、领域视图（概览/Models/Stubs/Interacts/领域会话/领域记忆/操作日志）、元素编辑弹窗。
- Git checkpoint：快照包含 `state/domains/<id>.json`、domain work、领域会话事件；恢复时重建领域会话。
- 测试：`node --test test/engine.test.mjs test/matrix.test.mjs` 当前 45/45 通过。

当前元素 kind：

- Model kinds: `entity / value_object / aggregate / domain_event`
- Stub kinds: `repository / domain_service / external_service / acl / notification / other`
- Interact kinds: `command / query / use_case`

这些将在 P1 调整。

---

## 2. 目标数据模型

### 2.1 Model

```json
{
  "id": "mdl_xxx",
  "name": "OrderRequest",
  "type": "request | response | persistence",
  "kind": "entity | value_object | domain_event | dto",
  "description": "",
  "attributes": [{ "name": "id", "type": "string", "required": true }],
  "relations": [{ "target_model_id": "mdl_yyy", "kind": "association" }],
  "invariants": [],
  "matrix_id": null,
  "origin": null
}
```

规则：

- `request / response` 的 `kind` 固定为 `dto`。
- `persistence` 的 `kind` 可选 `entity / value_object / domain_event`，默认 `entity`。
- 显式去掉 `aggregate`。
- 矩阵入口/出口契约只允许 request / response model。
- relations 只允许同 `type` 内引用（persistence ↔ persistence，request ↔ request，response ↔ response）。
- `origin` 预留给导入能力：`{ export_id, domain_id, model_id }`，导入项 `readonly: true`。

迁移：

- 旧 `aggregate` → `type=persistence, kind=entity`
- 旧 `entity / value_object / domain_event` → `type=persistence`，保留 kind
- 无 type 的旧 model 一律按 persistence 处理
- 已有 interact 引用了 persistence model 时：迁移不阻断，但新写入/新矩阵生成时拒绝；面板标记待修复

### 2.2 Stub

```json
{
  "id": "stb_xxx",
  "name": "InventoryPort",
  "kind": "repository | domain_service | external_service | acl | notification | other",
  "description": "",
  "operations": [{
    "name": "reserve",
    "request_model_ids": ["mdl_req_1"],
    "response_model_ids": ["mdl_resp_1"],
    "description": ""
  }],
  "matrix_id": null,
  "scope": "domain",
  "origin": null
}
```

规则：

- 每个 operation 的 request/response model 必须存在，且类型正确。
- Stub 只能引用同 Domain 的 model；导入 stub 的 model 会在导入域内生成本地只读副本。
- 不允许 stub 直接引用 persistence model。
- `scope=domain` 固定；跨域只能通过 import。

### 2.3 Interact

```json
{
  "id": "itx_xxx",
  "name": "PlaceOrder",
  "kind": "command | query | use_case",
  "description": "",
  "actors": ["Customer"],
  "request_model_ids": ["mdl_req_1"],
  "response_model_ids": ["mdl_resp_1"],
  "stub_ids": ["stb_xxx"],
  "preconditions": [],
  "postconditions": [],
  "main_flow": [],
  "alternatives": [],
  "matrix_id": null
}
```

规则：

- 只保留业务流程，不保存 UI/screen/route/components。
- model 引用只允许 request/response；禁止 persistence。
- stub 引用只允许当前 Domain（含导入别名）。
- interact 的 matrix 禁止 persist 节点，允许 stub 节点。

---

## 3. Matrix 节点设计

### 3.1 新增节点类型

在 `lib/matrix/schema.mjs` 的 `NODE_TYPES` 增加：

```
persist
stub
```

`BRANCH_TYPES` 同步加入 `persist` 与 `stub`（branch 的 then/else 可以调用）。

### 3.2 persist 节点

```json
{
  "id": "save_order",
  "type": "persist",
  "label": "保存订单",
  "model_id": "mdl_order",
  "operation": "create | get | update | delete | list",
  "key": "orderId",
  "where": {},
  "inputs": { "order": "object" },
  "outputs": { "order": "object" }
}
```

约束：

- `model_id` 必须指向同 Domain 的 `type=persistence` model；
- 只允许出现在 persistence model matrix、stub matrix；
- 禁止出现在 request/response model matrix、interact matrix；
- 由运行时直接执行，不进入 LLM 编码节点。

### 3.3 stub 节点

```json
{
  "id": "reserve_inventory",
  "type": "stub",
  "label": "预留库存",
  "stub_id": "stb_inventory",
  "operation": "reserve",
  "request_model_ids": ["mdl_req_1"],
  "response_model_ids": ["mdl_resp_1"],
  "inputs": { "...": "..." },
  "outputs": { "...": "..." }
}
```

约束：

- `stub_id` 必须是当前 Domain 的 Stub（含导入别名）；
- operation 必须存在；
- request/response model 必须与 operation 契约一致；
- 禁止出现 persistence model。

### 3.4 执行语义

**stub 节点**：编译为对 stub 根 matrix 的 subflow 调用。

- 复用现有 `subflow` 运行时；
- stub 根 matrix 负责服务实现或外部适配；
- 需要在 matrix 记录中引入领域依赖：

```json
{ "domain_dependencies": ["mx_stub_..."] }
```

- interact 根 matrix 的 runnable 条件需要扩展为：
  自身预构建完成 && 直接子 matrix 已验收 && domain_dependencies 已验收。
- stub matrix 验收后，需要反向重算依赖它的 interact matrix。

**persist 节点**：新增运行时 handler。

- 第一版使用项目级 JSON 文件存储：

```
<dataDir>/projects/<projectId>/data/<model_id>.json
```

- 支持 create/get/update/delete/list；
- 原子写 + 按 model 文件加锁；
- 节点编译时写入 `project_id` 与 `model_id`，运行时无需再反查；
- 持久化数据纳入项目 Git 快照：`state/data/`。

---

## 4. 约束的四个生效点

1. **领域目录写入时**（`lib/domain/schema.mjs` + `service.mjs`）
   - model type/kind
   - stub operation request/response 类型
   - interact 禁止 persistence 引用
   - 同 Domain 引用

2. **骨架生成时**（`lib/matrix/require.mjs` + `lib/ai.mjs`）
   - 把 Domain 上下文注入 `planSkeleton` 提示词：
     - 当前元素是 model / stub / interact
     - request/response/persistence 清单
     - stub operation 契约
     - 允许的节点类型
   - interact：明确禁止 persist，允许 stub。

3. **确认 DAG / 预构建 / 编译时**
   - 新增 `lib/domain/policy.mjs`：
     - `allowedNodeTypes(matrix, domainElement)`
     - `assertDomainSkeleton(matrix, skeleton, domain)`
     - `assertDomainNode(node, domain)`
   - `confirmDag`、`prebuildMatrix`、`compileSkeleton` 都调用，防止绕过面板/提示词。

4. **运行时兜底**
   - persist：校验 model 类型与操作；
   - stub：校验 stub matrix 已验收、契约匹配；
   - interact matrix 出现 persist 节点直接拒绝。

---

## 5. Export / Import

### 5.1 导出范围

只导出：

- request / response models
- stubs 及其 operations

不导出：

- persistence models
- interacts
- memory / sessions / runs
- 内部 matrix 定义

### 5.2 导出包（不可变快照）

```json
{
  "export_id": "exp_xxx_v1",
  "domain_id": "dom_xxx",
  "version": 1,
  "name": "订单履约能力",
  "summary": "",
  "models": [],
  "stubs": [],
  "checksum": "",
  "created_at": ""
}
```

存放：

```
<dataDir>/registry/domain-exports/<export_id>.json
```

### 5.3 Domain 记录新增

```json
{
  "exports": [{ "id": "exp_xxx_v1", "version": 1, "created_at": "", "model_ids": [], "stub_ids": [] }],
  "imports": [{
    "id": "imp_xxx",
    "export_id": "exp_xxx_v1",
    "provider_domain_id": "dom_xxx",
    "version": 1,
    "model_map": {},
    "stub_map": {},
    "imported_at": ""
  }]
}
```

### 5.4 导入规则

- 导入的 model/stub 标记 `readonly: true`、`origin`；
- 生成目标 Domain 的本地 id，并记录 map；
- 导入 stub 视为本 Domain stub，满足“只允许同领域调用”；
- import 版本锁定，provider 更新不自动生效；
- 升级需显式 `domain_import_upgrade` 并展示契约 diff；
- 被 interact/matrix 引用时禁止删除/降级。

### 5.5 导入 stub 的执行

默认：

- 为导入 stub 创建本地适配器根 matrix（`domain_matrix_intake`），任务提示“只实现契约适配，不复制 provider 内部实现”。

可选：

- 如果 provider 在同一 dataDir 且根 matrix 可用，配置为 subflow 直连。

### 5.6 Git 快照

项目快照新增：

- `state/exports/`：本项目导出包副本
- `state/imports/`：本项目导入包副本
- `state/data/`：persistence store
- 原有 `state/domains/` 保留

---

## 6. 能力检索插件

建议新增插件：

```
plugins/generic/rms-domain-registry
```

职责只读，不直接修改 Domain。

### 6.1 工具

- `domain_registry_list({ query? })`
- `domain_registry_get({ export_id })`
- `domain_discover({ requirement, project_id?, top_k? })`

### 6.2 检索流程

```
需求文本
→ 注册表关键词/标签召回候选 export
→ 开只读子会话（sub-session）
→ 子会话阅读候选包契约
→ 输出结构化匹配结果（匹配 stub、契约缺口、建议导入）
→ 用户/主 agent 决定 domain_import_apply
```

子会话：

- sessionId：`domain-discover-<uuid>`
- parentSessionId：可挂当前项目/领域会话
- workspace：项目 cwd 或临时目录
- 工具限制：只读 registry 工具
- 输出 JSON：

```json
{
  "matches": [{
    "export_id": "",
    "domain_id": "",
    "version": 1,
    "score": 0.0,
    "matched_stubs": [{ "stub_id": "", "operation": "", "reason": "" }],
    "missing": [],
    "suggested_import": true
  }],
  "no_match_reason": ""
}
```

### 6.3 边界

- 检索插件只读；
- 导出/导入写操作由 flow-runner 的 `domain_export_* / domain_import_*` 提供；
- 注册表是跨项目全局资源，因此放 `<dataDir>/registry`。

---

## 7. 实施阶段

### P1：领域语义收敛

文件：

- `lib/domain/schema.mjs`
- `lib/domain/service.mjs`
- `lib/domain/memory.mjs`（无需大改）
- `panel/index.html`
- `test/matrix.test.mjs`

任务：

- Model 增加 `type`，移除 `aggregate`；request/response 固定 `kind=dto`。
- Stub operation 增加 `request_model_ids / response_model_ids`。
- Interact 增加 `request_model_ids / response_model_ids`，去掉 UI 字段。
- 校验：同 Domain、类型正确、interact 禁止 persistence。
- 迁移旧 domain 数据（惰性迁移）。
- 面板编辑器同步字段。

验收：

- 旧领域可正常读取；
- 非法 stub 契约被拒绝；
- interact 引用 persistence 被拒绝；
- 现有测试全过。

### P2：Matrix 节点与策略

文件：

- `lib/matrix/schema.mjs`
- `lib/matrix/contracts.mjs`
- `lib/matrix/require.mjs`
- `lib/matrix/prebuild.mjs`
- `lib/ai.mjs`
- `lib/domain/policy.mjs`（新增）
- `panel/index.html`

任务：

- NODE_TYPES 增加 `persist`、`stub`。
- normalizeSkeletonNode 支持两种节点字段。
- readonlyDefinition / DAG 视图 / 节点弹窗展示。
- `assertDomainSkeleton` 策略校验。
- planSkeleton 提示词注入 Domain 上下文与允许节点类型。
- prebuild 不把 persist/stub 当编码节点；stub 解析目标 matrix。

验收：

- interact 骨架出现 persist → 生成/确认/预构建被拒绝；
- interact 使用 stub → 通过并解析依赖；
- persistence model 可使用 persist；
- request/response model 使用 persist 被拒绝。

### P3：执行语义

文件：

- `lib/runner.mjs` / `lib/engine/runtime.mjs`
- `lib/matrix/execute.mjs`
- `lib/matrix/state.mjs`
- `lib/matrix/service.mjs`
- `lib/project/git.mjs`

任务：

- persist 节点运行时 + JSON store + 文件锁。
- stub 节点编译为 subflow。
- matrix 增加 `domain_dependencies` 与验收门禁。
- stub matrix 验收后反向重算依赖 matrix。
- Git 快照增加 `state/data/`。

验收：

- interact 运行调用 stub matrix；
- stub matrix 未验收时 interact 不可运行；
- persist CRUD 数据落盘并可被后续节点读取；
- Git restore 后 data 与依赖关系正确。

### P4：Export / Import

文件：

- `lib/domain/registry.mjs`（新增）
- `lib/domain/import.mjs`（新增）
- `lib/domain/service.mjs`
- `plugin.mjs`
- `lib/panel.mjs`
- `panel/index.html`
- `lib/project/git.mjs`

任务：

- `domain_export_create / list / get`
- `domain_import_apply / list / remove / upgrade`
- 不可变导出包与 checksum
- 导入只读 model/stub、本地 id 映射、版本锁定
- 引用保护与升级 diff
- 面板「导出能力 / 已导入」区
- Git 快照 exports/imports

验收：

- 导出不含 persistence/interact；
- 导入后 interact 可使用导入 stub；
- 升级/删除被引用时拒绝；
- restore 后导入关系仍有效。

### P5：能力检索插件

目录：

```
plugins/generic/rms-domain-registry
```

任务：

- `dsh/host.mjs` 注册只读工具
- `domain_registry_list/get`
- `domain_discover` 子会话
- 只读工具限制与 JSON 输出校验

验收：

- 给需求能返回匹配领域/stub 与缺口；
- 子会话不能写领域数据；
- 检索结果可被主 agent 用来触发 import。

### P6：面板与回归

- 领域视图元素卡片显示 type/kind、stub request→response、interact 流程。
- 节点弹窗显示 persist/stub 详情。
- 测试覆盖 + 浏览器验证。

---

## 8. 测试清单（新增）

- Model type 迁移与校验。
- Stub operation request/response 类型校验。
- Interact 禁止 persistence。
- interact 骨架 persist 节点被拒绝。
- stub 节点解析目标 stub matrix。
- persist 运行时 CRUD。
- stub 节点运行 subflow。
- domain_dependencies 门禁与反向重算。
- 导出包不包含 persistence。
- 导入只读、版本锁定、引用保护、升级 diff。
- Git 快照包含 data/exports/imports。
- 能力检索子会话输出结构。

验证命令：

```powershell
node --test test/engine.test.mjs test/matrix.test.mjs
```

---

## 9. 待确认（默认按推荐执行）

1. **导出范围**：只导出 request/response + stubs（推荐）。
2. **导入 stub 执行**：默认生成本地适配器 matrix；同 dataDir provider 可选 subflow 直连（推荐）。
3. **注册表位置**：全局 `<dataDir>/registry`（推荐，支持跨项目）。

如无异议，后续会话直接按推荐值实施。

---

## 10. 当前环境备注

- dsh 启动命令（cwd `deepseek-harness`）：

```powershell
pnpm dsh --profile web --patch C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml --host 192.168.34.5 --trusted-host 192.168.34.5:3080 --no-open
```

- 改码后需要重启 dsh；token 会变化，从命令输出日志读取。
- 插件当前加载 59 个工具，测试 45/45 通过。
- 面板地址形如：`http://192.168.34.5:3080/flow-runner-v2/?token=<新token>`。
