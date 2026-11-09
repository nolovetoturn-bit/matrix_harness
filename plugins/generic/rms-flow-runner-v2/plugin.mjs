import {
  accept,
  answer,
  answerTicket,
  cancel,
  cancelTicket,
  confirmDagAction,
  ensureSession,
  evaluate,
  generateDag,
  get,
  intake,
  list,
  mail,
  nav,
  prebuild,
  reopenDag,
  retry,
  revise,
  reviseNodeAction,
  resume,
  rewindPoints,
  rewindSession,
  run,
  runArtifacts,
  runDetail,
  runs,
  setExecutionMode,
  submitInput,
  supervise,
  tickets,
  tree,
} from './lib/matrix/service.mjs'
import { startPanel } from './lib/panel.mjs'
import { resolveDataDir } from './lib/matrix/store.mjs'
import {
  archiveMatrix,
  moveMatrix,
  projectArchive,
  projectChat,
  projectCreate,
  projectGet,
  projectGit,
  projectList,
  projectMemory,
  projectNav,
  projectRunRunnable,
  projectSummary,
  projectTree,
  projectUpdate,
} from './lib/project/service.mjs'
import {
  domainArchive,
  domainBindMatrix,
  domainChat,
  domainCreate,
  domainElementRemove,
  domainElementUpsert,
  domainEnsureSession,
  domainExportCreate,
  domainExportGet,
  domainExportList,
  domainGet,
  domainImportApply,
  domainImportList,
  domainImportRemove,
  domainImportUpgrade,
  domainList,
  domainMatrixIntake,
  domainMemory,
  domainSummary,
  domainUpdate,
} from './lib/domain/service.mjs'

export const id = 'rms-flow-runner-v2'
export const kind = 'generic'
export const description = 'matrix（矩阵）工作流：每个 matrix 是可独立运行/验收的业务单元，树结构表达构建与验收顺序，跨 matrix 只走信箱。'

let hostDependencies = {}

/**
 * 由 dsh 宿主注入运行时能力。
 * @param {{agentRunner?: Function, codingAgentRunner?: Function, toolRunner?: Function, workspaceProvider?: object, sessionMirror?: Function, sessionEvents?: Function, matrixChat?: Function, llm?: object, panel_path?: string}} dependencies
 */
export function configure(dependencies = {}) {
  hostDependencies = { ...(dependencies || {}) }
}

const dataDir = {
  type: 'string',
  description: '可选数据目录；默认使用 RMS_MATRIX_DATA_DIR 或 <LOCALAPPDATA>/rms-flow-runner/matrix',
}
const matrixId = { type: 'string', description: 'matrix id（mx_...）；在 matrix 绑定会话内可省略，工具会自动绑定当前矩阵' }
const projectId = { type: 'string', description: '项目 id（pj_...）；在项目绑定会话内可省略，工具会自动绑定当前项目' }
const projectIdOptional = { type: 'string', description: '可选项目 id；新建根 matrix 时挂到该项目，缺省按名称新建项目' }
const domainId = { type: 'string', description: '领域 id（dom_...）；在领域绑定会话内可省略，工具会自动绑定当前领域' }
const domainElement = { type: 'object', description: '领域元素定义；模型含 name/type(request/response/persistence)/kind/description/attributes/invariants/relations；服务 operations 含 request_model_ids/response_model_ids；交互含 actors/request_model_ids/response_model_ids/stub_ids/preconditions/postconditions/main_flow/alternatives', additionalProperties: true }
const json = value => JSON.stringify(value, null, 2)
const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const tool = (name, description, properties, required, fn) => ({
  name,
  description,
  // matrix_id 允许省略：在 matrix 绑定会话内由会话 id 自动解析，拿不到就报缺失
  parameters: { type: 'object', properties: { ...properties, data_dir: dataDir }, required: required.filter(key => key !== 'matrix_id') },
  output,
  run(args, dependencies = hostDependencies, context = {}) {
    return fn(args, dependencies, context)
  },
})

export const tools = [
  {
    name: 'matrix_intake',
    description: '受理任务并创建一个 matrix：建 dsh 会话、需求分析；信息不足进入 clarifying 并给出问题，信息足够进入 awaiting_requirement。新建根 matrix 时请传 project_id 挂到项目。触发场景：新建矩阵、受理任务、需求分析。Keywords: matrix intake, 受理, 新建矩阵',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '本 matrix 的需求' },
        name: { type: 'string', description: '可选显示名' },
        parent_id: { type: 'string', description: '可选父 matrix id；正常子 matrix 由预构建自动创建' },
        project_id: projectIdOptional,
        data_dir: dataDir,
      },
      required: ['task'],
    },
    output,
    run(args, dependencies = hostDependencies) {
      return intake(args, dependencies).then(json)
    },
  },
  tool('matrix_answer', '回答 clarifying 状态的澄清问题；信息补足后进入 awaiting_requirement。', {
    matrix_id: matrixId,
    answer: { type: 'string', description: '对澄清问题的回答' },
  }, ['matrix_id', 'answer'], (args, dependencies, context) => answer(args, dependencies, context).then(json)),
  tool('matrix_revise', '修订需求或提交 DAG 修改意见：状态决定是重新分析需求还是重新生成骨架 DAG。', {
    matrix_id: matrixId,
    task: { type: 'string', description: '可选，替换任务描述' },
    instruction: { type: 'string', description: '可选，修订要求/对 DAG 的修改意见' },
  }, ['matrix_id'], (args, dependencies, context) => revise(args, dependencies, context).then(json)),
  tool('matrix_generate_dag', '从 awaiting_requirement 生成骨架 DAG，进入 awaiting_dag。', {
    matrix_id: matrixId,
    instruction: { type: 'string', description: '可选生成要求' },
  }, ['matrix_id'], (args, dependencies, context) => generateDag(args, dependencies, context).then(json)),
  tool('matrix_confirm_dag', '人工确认骨架 DAG，进入 awaiting_prebuild。', { matrix_id: matrixId }, ['matrix_id'],
    (args, dependencies, context) => confirmDagAction(args, dependencies, context).then(json)),
  tool('matrix_prebuild', '启动逐节点预构建；group 节点会创建子 matrix。background=true 时立即返回，进度靠轮询。', {
    matrix_id: matrixId,
    background: { type: 'boolean', description: '是否后台推进' },
  }, ['matrix_id'], (args, dependencies, context) => prebuild(args, dependencies, context).then(json)),
  tool('matrix_reopen_dag', '重大修改 DAG：退回 awaiting_dag，作废旧预构建、评估与验收结果；可选 instruction 直接按修改意见重生成骨架。不给 instruction 时保留当前骨架，可继续修改或重新确认。', {
    matrix_id: matrixId,
    instruction: { type: 'string', description: '可选，重大修改意见；给定时立即重生成骨架' },
  }, ['matrix_id'], (args, dependencies, context) => reopenDag(args, dependencies, context).then(json)),
  tool('matrix_retry', '预构建失败后重试：只重置失败节点，已完成节点与子 matrix 保留。', {
    matrix_id: matrixId,
    instruction: { type: 'string', description: '可选重试说明' },
  }, ['matrix_id'], (args, dependencies, context) => retry(args, dependencies, context).then(json)),
  tool('matrix_revise_node', '修复单个节点的实现（节点 id/类型/Cin-Cout 契约不变）：可直接给 script 节点的完整 code，或给 instruction 让编码会话按最近一次运行错误重写；完成后刷新 definition，其它节点不受影响。', {
    matrix_id: matrixId,
    node_path: { type: 'string', description: '节点路径（entry/<id>）或节点 id' },
    instruction: { type: 'string', description: '修复说明；未给 code 时使用，会自动附带最近一次运行失败信息' },
    code: { type: 'string', description: 'script 节点的完整新代码；给定时直接替换实现' },
    runtime: { type: 'string', description: '可选，覆盖 script runtime（node/ts/python/bash/pwsh）' },
  }, ['node_path'], (args, dependencies, context) => reviseNodeAction(args, dependencies, context).then(json)),
  tool('matrix_resume', '向 waiting_human 的运行注入人工输入并继续（子运行等待时由 flow 自动路由）。', {
    matrix_id: matrixId,
    run_id: { type: 'string', description: '可选运行 id；缺省取等待中的运行' },
    input: { description: '人工节点输入' },
  }, ['matrix_id'], (args, dependencies, context) => resume(args, dependencies, context).then(json)),
  tool('matrix_accept', '人工验收：仅 runnable 可验收；通过后自底向上重算父 matrix 状态。', { matrix_id: matrixId }, ['matrix_id'],
    (args, dependencies, context) => accept(args, dependencies, context).then(json)),
  tool('matrix_run', '运行 matrix：仅 runnable 可运行；子流程节点会调用子 matrix 的独立运行。', {
    matrix_id: matrixId,
    input: { description: '可选入口 Cin' },
  }, ['matrix_id'], (args, dependencies, context) => run(args, dependencies, context).then(json)),
  tool('matrix_evaluate', '按验收标准只读评估运行；不改变门禁状态。', {
    matrix_id: matrixId,
    run_id: { type: 'string', description: '可选运行 id；缺省取最近一次 completed 运行' },
  }, ['matrix_id'], (args, dependencies, context) => evaluate(args, dependencies, context).then(json)),
  tool('matrix_supervise', '监督分析：只读需求/骨架/定义/运行轨迹，给出结论与建议，不修改定义、不改变门禁。', {
    matrix_id: matrixId,
    run_id: { type: 'string', description: '可选运行 id；缺省取最近一次运行' },
    instruction: { type: 'string', description: '可选监督关注点' },
  }, ['matrix_id'], (args, dependencies, context) => supervise(args, dependencies, context).then(json)),
  tool('matrix_cancel', '人工终止 matrix（保留数据）。', {
    matrix_id: matrixId,
    reason: { type: 'string' },
  }, ['matrix_id'], (args, dependencies, context) => cancel(args, dependencies, context).then(json)),
  tool('matrix_rewind', '会话撤回：action=list 列出已完成对话轮次；action=rewind 需 at_seq，从该轮分叉新 dsh 会话并把 matrix 绑定切过去，面板时间线回退到该轮。matrix 的门禁状态与运行记录不变。', {
    matrix_id: matrixId,
    action: { type: 'string', enum: ['list', 'rewind'] },
    at_seq: { type: 'integer', description: 'rewind 时的轮次边界 seq（来自 list 结果）' },
  }, ['action'], (args, dependencies, context) => {
    if (args.action === 'rewind') return rewindSession(args, dependencies, context).then(json)
    return rewindPoints(args, dependencies, context).then(json)
  }),
  tool('matrix_input', '统一输入框：按当前状态自动路由（澄清回答/需求修订/DAG 意见/重试说明/监督）。', {
    matrix_id: matrixId,
    text: { type: 'string' },
  }, ['matrix_id', 'text'], (args, dependencies, context) => submitInput(args, dependencies, context).then(json)),
  tool('matrix_get', '读取 matrix 详情：状态、骨架、definition、子矩阵、会话消息、运行记录、信箱、面包屑与导航。', {
    matrix_id: matrixId,
  }, ['matrix_id'], (args, dependencies, context) => get(args, dependencies, context).then(json)),
  tool('matrix_tree', '读取整棵 matrix 树；传 root_id 只看子树，传 project_id 只看该项目下的根。', {
    root_id: { type: 'string', description: '可选根 matrix id' },
    project_id: { type: 'string', description: '可选项目 id，只看该项目' },
    include_archived: { type: 'boolean', description: '是否包含已归档根 matrix（默认 false）' },
  }, [], (args) => json(tree(args))),
  tool('matrix_nav', '导航：面包屑、父级、「下一个未验收」（DFS 最深最左）。', { matrix_id: matrixId }, ['matrix_id'],
    (args, _dependencies, context) => json(nav(args, context))),
  tool('matrix_mail', '跨 matrix 信箱：send / inbox / reply。只在同一项目内投递。', {
    action: { type: 'string', enum: ['send', 'inbox', 'reply'] },
    matrix_id: matrixId,
    to_matrix: { type: 'string', description: 'send 时的目标 matrix id' },
    kind: { type: 'string', enum: ['context', 'question', 'bug_report', 'note', 'answer'] },
    subject: { type: 'string' },
    body: { type: 'string' },
    mail_id: { type: 'string', description: 'reply 时的原信件 id' },
    mark_read: { type: 'boolean' },
  }, ['matrix_id', 'action'], (args, dependencies, context) => mail(args, dependencies, context).then(json)),
  tool('matrix_runs', '列出某个 matrix 的运行记录；传 run_id 读取单次运行轨迹。', {
    matrix_id: matrixId,
    run_id: { type: 'string' },
  }, [], (args) => (args.run_id ? json(runDetail(args)) : json(runs(args)))),
  tool('matrix_run_artifacts', '查看运行产物与日志：不给 path 返回文件清单和 run.log；给 path 读取该文件内容。用于定位失败节点、检查输入输出。', {
    matrix_id: matrixId,
    run_id: { type: 'string', description: '运行 id（必填）' },
    path: { type: 'string', description: '可选，产物内相对路径，如 nodes/_root_write_hello/output.json' },
  }, ['run_id'], (args) => json(runArtifacts(args))),
  tool('matrix_set_run_mode', '切换 DAG 运行 I/O 模式：files（文件式，节点输入/输出/日志落盘可审计，推荐）或 inline（仅 stdin/stdout）。', {
    matrix_id: matrixId,
    execution_mode: { type: 'string', enum: ['files', 'inline'] },
  }, ['execution_mode'], (args, dependencies, context) => setExecutionMode(args, dependencies, context).then(json)),
  tool('matrix_tickets', '查看或处理 matrix 内的人工工单。action=list 列出工单；action=answer 需 ticket_id 和 answer，会恢复对应运行；action=cancel 取消工单。代答必须获得用户明确同意。', {
    matrix_id: matrixId,
    action: { type: 'string', enum: ['list', 'answer', 'cancel'] },
    ticket_id: { type: 'string' },
    answer: { description: '答复内容，字符串或 JSON' },
  }, ['action'], (args, dependencies, context) => {
    if (args.action === 'answer') return answerTicket(args, dependencies, context).then(json)
    if (args.action === 'cancel') return cancelTicket(args, dependencies, context).then(json)
    return json(tickets(args, context))
  }),
  tool('matrix_list', '列出全部 matrix（含树）；传 project_id 只看该项目，include_archived 才返回归档树。', {
    project_id: { type: 'string', description: '可选项目 id' },
    include_archived: { type: 'boolean', description: '是否包含已归档根 matrix（默认 false）' },
  }, [], (args) => json(list(args))),
  tool('matrix_session', '确保 matrix 的 dsh 会话存在；返回会话 id 与工作目录。', { matrix_id: matrixId }, ['matrix_id'],
    (args, dependencies, context) => ensureSession(args, dependencies, context).then(json)),
  tool('project_create', '新建项目：项目是顶层容器，可有多个根 matrix，并有自己的 dsh 会话、工作区与记忆。Keywords: project, 新建项目', {
    name: { type: 'string', description: '项目名称' },
    brief: { type: 'string', description: '项目目标/范围说明' },
    cwd: { type: 'string', description: '可选项目工作区目录；缺省 <dataDir>/projects/<project_id>/work' },
  }, ['name'], (args, dependencies) => projectCreate(args, dependencies).then(json)),
  tool('project_list', '列出项目（默认只列 active）及根 matrix 计数、可运行/已验收数量、记忆条数。', {
    include_archived: { type: 'boolean', description: '是否包含已归档项目' },
  }, [], (args) => json(projectList(args))),
  tool('project_get', '读取项目详情：根 matrix、状态统计、项目记忆、项目会话消息与运行汇总。', {
    project_id: projectId,
  }, [], (args, dependencies, context) => projectGet(args, dependencies, context).then(json)),
  tool('project_update', '更新项目名称或说明。', {
    project_id: projectId,
    name: { type: 'string' },
    brief: { type: 'string' },
  }, [], (args, dependencies, context) => projectUpdate(args, dependencies, context).then(json)),
  tool('project_archive', '归档项目（只改项目状态，不动根 matrix 门禁与运行记录）。', {
    project_id: projectId,
  }, [], (args, dependencies, context) => projectArchive(args, dependencies, context).then(json)),
  tool('project_chat', '项目会话输入：交给项目绑定的 dsh agent，由 agent 调用 project_* / matrix_* 工具推进。', {
    project_id: projectId,
    text: { type: 'string' },
  }, ['text'], (args, dependencies, context) => projectChat(args, dependencies, context).then(json)),
  tool('project_memory', '项目记忆：action=list/add/update/remove；变更会同步写入 PROJECT_MEMORY.md 并注入项目会话。', {
    project_id: projectId,
    action: { type: 'string', enum: ['list', 'add', 'update', 'remove'] },
    text: { type: 'string', description: 'add/update 时的记忆内容' },
    entry_id: { type: 'string', description: 'update/remove 时的记忆 id（mem-...）' },
    tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
  }, ['action'], (args, dependencies, context) => projectMemory(args, dependencies, context).then(json)),
  tool('project_tree', '读取项目下的根 matrix 树。', {
    project_id: projectId,
  }, [], (args, _dependencies, context) => json(projectTree(args, context))),
  tool('project_summary', '项目汇总：各状态 matrix 数量、可运行根、未验收根与运行统计。', {
    project_id: projectId,
  }, [], (args, _dependencies, context) => json(projectSummary(args, context))),
  tool('project_nav', '项目级导航：先看当前 matrix 子树，再按根创建顺序找「下一个未验收」。', {
    project_id: projectId,
    matrix_id: { type: 'string', description: '可选当前 matrix id' },
  }, [], (args, _dependencies, context) => json(projectNav(args, context))),
  tool('project_run_runnable', '顺序运行项目内所有 runnable 根 matrix；可传 matrix_ids 限定范围。', {
    project_id: projectId,
    matrix_ids: { type: 'array', items: { type: 'string' }, description: '可选根 matrix 清单' },
  }, [], (args, dependencies, context) => projectRunRunnable(args, dependencies, context).then(json)),
  tool('matrix_move', '把根 matrix 及其整棵子树移动到另一个项目；子 matrix 不能单独移动。', {
    matrix_id: matrixId,
    target_project_id: { type: 'string', description: '目标项目 id（pj_...）' },
  }, ['target_project_id'], (args, dependencies, context) => moveMatrix(args, dependencies, context).then(json)),
  tool('matrix_archive', '归档/恢复根 matrix：只影响可见性，不改门禁状态与运行记录。archived 缺省为 true。', {
    matrix_id: matrixId,
    archived: { type: 'boolean', description: 'true 归档（默认），false 恢复' },
  }, [], (args, dependencies, context) => archiveMatrix(args, dependencies, context).then(json)),
  tool('project_git', '项目 Git checkpoint：init 初始化 / commit 提交 / status / log / diff / restore 恢复快照。快照含项目元数据、matrix 定义与 work、运行记录、dsh 会话事件。restore 会重建 dsh 会话并覆盖当前项目状态，调用前需用户明确同意。', {
    project_id: projectId,
    action: { type: 'string', enum: ['init', 'commit', 'status', 'log', 'diff', 'restore'] },
    message: { type: 'string', description: 'commit 提交说明' },
    commit: { type: 'string', description: 'diff/restore 的提交 hash' },
    limit: { type: 'integer', description: 'log 条数，默认 20' },
  }, ['action'], (args, dependencies, context) => projectGit(args, dependencies, context).then(json)),
  tool('domain_create', '新建领域（限界上下文）：领域有独立 LLM 会话、记忆，并包含 models / stubs / interacts。', {
    project_id: projectId,
    name: { type: 'string', description: '领域名称' },
    brief: { type: 'string', description: '领域目标/范围' },
  }, ['name'], (args, dependencies, context) => domainCreate(args, dependencies, context).then(json)),
  tool('domain_list', '列出项目下的领域及元素数量、已实现数量。', {
    project_id: projectId,
    include_archived: { type: 'boolean' },
  }, [], (args, dependencies, context) => json(domainList(args, context))),
  tool('domain_get', '读取领域详情：models / stubs / interacts、绑定 matrix 状态、领域记忆、会话与操作日志。', {
    domain_id: domainId,
  }, [], (args, dependencies, context) => domainGet(args, dependencies, context).then(json)),
  tool('domain_update', '更新领域名称、目标、限界上下文与通用语言。', {
    domain_id: domainId,
    name: { type: 'string' },
    brief: { type: 'string' },
    bounded_context: { type: 'string' },
    ubiquitous_language: { type: 'array', items: { type: 'string' } },
  }, [], (args, dependencies, context) => domainUpdate(args, dependencies, context).then(json)),
  tool('domain_archive', '归档领域（不改其 matrix 状态）。', { domain_id: domainId }, [],
    (args, dependencies, context) => domainArchive(args, dependencies, context).then(json)),
  tool('domain_model_upsert', '新增或更新领域模型。type=request/response 时 kind=dto；type=persistence 时 kind=entity/value_object/domain_event。', {
    domain_id: domainId,
    element: domainElement,
  }, ['element'], (args, dependencies, context) => domainElementUpsert({ ...args, kind: 'model' }, dependencies, context).then(json)),
  tool('domain_stub_upsert', '新增或更新领域服务/端口（repository/domain_service/external_service/acl/notification）。', {
    domain_id: domainId,
    element: domainElement,
  }, ['element'], (args, dependencies, context) => domainElementUpsert({ ...args, kind: 'stub' }, dependencies, context).then(json)),
  tool('domain_interact_upsert', '新增或更新领域交互；request/response model 与 stub 必须已存在，禁止引用 persistence model。', {
    domain_id: domainId,
    element: domainElement,
  }, ['element'], (args, dependencies, context) => domainElementUpsert({ ...args, kind: 'interact' }, dependencies, context).then(json)),
  tool('domain_model_remove', '删除领域模型；已有根 matrix 或被 interact 引用时拒绝。', {
    domain_id: domainId,
    element_id: { type: 'string' },
  }, ['element_id'], (args, dependencies, context) => domainElementRemove({ ...args, kind: 'model' }, dependencies, context).then(json)),
  tool('domain_stub_remove', '删除领域服务；已有根 matrix 或被 interact 引用时拒绝。', {
    domain_id: domainId,
    element_id: { type: 'string' },
  }, ['element_id'], (args, dependencies, context) => domainElementRemove({ ...args, kind: 'stub' }, dependencies, context).then(json)),
  tool('domain_interact_remove', '删除领域交互。', {
    domain_id: domainId,
    element_id: { type: 'string' },
  }, ['element_id'], (args, dependencies, context) => domainElementRemove({ ...args, kind: 'interact' }, dependencies, context).then(json)),
  tool('domain_matrix_intake', '为领域元素创建唯一根 matrix（1:1）；复合结构必须在该根 matrix 的 DAG 内用 group 拆分。', {
    domain_id: domainId,
    kind: { type: 'string', enum: ['model', 'stub', 'interact'] },
    element_id: { type: 'string', description: '元素 id' },
  }, ['kind', 'element_id'], (args, dependencies, context) => domainMatrixIntake(args, dependencies, context).then(json)),
  tool('domain_bind_matrix', '把已有、未绑定的根 matrix 挂到领域元素。', {
    domain_id: domainId,
    kind: { type: 'string', enum: ['model', 'stub', 'interact'] },
    element_id: { type: 'string' },
    matrix_id: matrixId,
  }, ['kind', 'element_id', 'matrix_id'], (args, dependencies, context) => domainBindMatrix(args, dependencies, context).then(json)),
  tool('domain_chat', '领域会话输入：交给挂在项目会话下的领域 agent，由其增量调用 domain_* 工具完成建模。', {
    domain_id: domainId,
    text: { type: 'string' },
  }, ['text'], (args, dependencies, context) => domainChat(args, dependencies, context).then(json)),
  tool('domain_memory', '领域记忆：list / add / update / remove；变更同步 DOMAIN_MEMORY.md 并注入领域会话。', {
    domain_id: domainId,
    action: { type: 'string', enum: ['list', 'add', 'update', 'remove'] },
    text: { type: 'string' },
    entry_id: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  }, ['action'], (args, dependencies, context) => domainMemory(args, dependencies, context).then(json)),
  tool('domain_summary', '领域汇总：元素覆盖率、绑定 matrix 状态。', { domain_id: domainId }, [],
    (args, _dependencies, context) => json(domainSummary(args, context))),
  tool('domain_session', '确保领域会话存在；返回领域/项目会话 id 与工作目录。', { domain_id: domainId }, [],
    (args, dependencies, context) => domainEnsureSession(args, dependencies, context).then(json)),
  tool('domain_export_create', '导出领域能力（request/response model + stub，不含 persistence/interact），生成不可变版本包。', {
    domain_id: domainId,
    name: { type: 'string', description: '能力名称，默认领域名' },
    summary: { type: 'string', description: '能力摘要，默认领域说明' },
  }, [], (args, dependencies, context) => domainExportCreate(args, dependencies, context).then(json)),
  tool('domain_export_list', '列出当前领域的所有导出包（按版本倒序）。', { domain_id: domainId }, [],
    (args, _dependencies, context) => json(domainExportList(args, context))),
  tool('domain_export_get', '读取导出包详情（models / stubs / checksum）。', {
    export_id: { type: 'string' },
  }, ['export_id'], (args, _dependencies, context) => json(domainExportGet(args))),
  tool('domain_import_apply', '导入其他领域的导出包：生成本地只读 model/stub 副本并锁定版本。', {
    domain_id: domainId,
    export_id: { type: 'string' },
  }, ['export_id'], (args, dependencies, context) => domainImportApply(args, dependencies, context).then(json)),
  tool('domain_import_list', '列出当前领域的导入记录（provider、版本、id 映射）。', { domain_id: domainId }, [],
    (args, _dependencies, context) => json(domainImportList(args, context))),
  tool('domain_import_remove', '移除导入；导入项仍被本地引用或已有适配 matrix 时拒绝。', {
    domain_id: domainId,
    import_id: { type: 'string' },
  }, ['import_id'], (args, dependencies, context) => domainImportRemove(args, dependencies, context).then(json)),
  tool('domain_import_upgrade', '升级导入到更新版本；保留本地 id 与适配 matrix，返回契约差异。', {
    domain_id: domainId,
    import_id: { type: 'string' },
    export_id: { type: 'string', description: '可选新导出包 id；缺省取 provider 领域最新版本' },
  }, ['import_id'], (args, dependencies, context) => domainImportUpgrade(args, dependencies, context).then(json)),
  {
    name: 'matrix_ui',
    description: '返回 matrix 面板地址：dsh 宿主内是常驻路由 /flow-runner-v2/；独立 MCP 下启动本地端口。Keywords: matrix ui, 矩阵面板',
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 0, maximum: 65535 },
        data_dir: dataDir,
      },
      required: [],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      if (dependencies.panel_path && args.port === undefined) {
        return json({ url: dependencies.panel_path, data_dir: resolveDataDir(args.data_dir), resident: true })
      }
      const panel = await startPanel(args, dependencies)
      return json({ url: panel.url, data_dir: panel.data_dir })
    },
  },
]
