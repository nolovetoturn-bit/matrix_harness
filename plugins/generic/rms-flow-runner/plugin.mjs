import {
  acceptBuild, answerBuild, answerFlow, configureWorkspace, confirmBuildDag, confirmFlow, defineFlow, evaluateFlow, getBuild, getFlow, getSession, inboxMail,
  instructFlow, intakeFlow, invokeFlow, listDefinitions, listFlow, listSessionGroups, listSessionTree, replyMail, resumeFlow,
  retryBuild, reviseFlow, runBuild, sendMail, startBuild, startBuildSession, startFlow, stepBuild,
} from './lib/service.mjs'
import { startPanel } from './lib/panel.mjs'
import { resolveDataDir } from './lib/store.mjs'

export const id = 'rms-flow-runner'
export const kind = 'generic'
export const description = '经验检索驱动的 LLM 工作流会话闭环：需求分析、澄清、规划、待确认、执行、验收；节点 Cin/Cout 传递业务数据，干预动作须经人工确认。'

let hostDependencies = { autoRepair: true }

/**
 * 由宿主适配器注入运行时能力（例如 dsh agent 循环）。
 * @param dependencies - `{ agentRunner, codingAgentRunner, workspaceProvider, sessionMirror, llm, retrieveExperience }` 的子集
 */
export function configure(dependencies = {}) {
  hostDependencies = { autoRepair: true, ...(dependencies || {}) }
}

const dataDir = {
  type: 'string',
  description: '可选运行数据目录；默认使用 RMS_FLOW_RUNNER_DATA_DIR 或本机用户数据目录',
}
const json = value => JSON.stringify(value, null, 2)
const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export const tools = [
  {
    name: 'flow_plan',
    description: '受理任务并开启工作流会话：先分析需求是否足够，不足则追问（最多 3 轮），再检索工作日志经验生成 Workflow IR 草稿并等待人工确认启动。触发场景：新建任务、任务规划、生成工作流、经验检索。Keywords: flow plan, workflow session, intake, clarify, 任务规划, 经验检索',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '需要实现的任务目标；会话会先判断信息是否足够，再生成 IR' },
        session_id: { type: 'string', description: '可选会话 id；留空自动生成 sess-... ' },
        parent_session_id: { type: 'string', description: 'session_id 的兼容别名' },
        name: { type: 'string', description: '可选会话显示名' },
        input: { description: '可选默认入口 Cin；Planner 可在草稿中明确给出最终 Cin' },
        experience_query: { type: 'string', description: '可选经验检索词；默认使用 task，无结果时回退 pb-analysis 日志' },
        fuel: { type: 'integer', minimum: 1, maximum: 10000 },
        workspace: { type: 'string', description: '会话工作目录（绝对路径）。缺省为 <data_dir>/workspaces/<session_id>；script 节点默认在此目录执行，相对 cwd 以此为根' },
        data_dir: dataDir,
      },
      required: ['task'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await intakeFlow(args, dependencies))
    },
  },
  {
    name: 'flow_answer',
    description: '回答会话的澄清问题；信息补足后会自动进入规划并生成待确认草稿。触发场景：回答追问、补充需求信息。Keywords: flow answer, clarification, 澄清, 补充需求',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'flow_plan 返回的会话 id' },
        answer: { type: 'string', description: '对澄清问题的回答，可一次覆盖多个问题' },
        data_dir: dataDir,
      },
      required: ['session_id', 'answer'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await answerFlow(args, dependencies))
    },
  },
  {
    name: 'flow_revise',
    description: '在启动前修订会话任务或规划指令；启动后的修改必须通过验收生成的待确认 replan 动作。触发场景：修改任务、调整规划方向。Keywords: flow revise, edit draft, 修订任务, 调整规划',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '要修订的会话 id' },
        task: { type: 'string', description: '可选，替换任务描述' },
        name: { type: 'string', description: '可选，替换会话显示名' },
        instruction: { type: 'string', description: '可选，给规划器的修订要求' },
        data_dir: dataDir,
      },
      required: ['session_id'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await reviseFlow(args, dependencies))
    },
  },
  {
    name: 'flow_evaluate',
    description: '验收当前运行是否满足会话验收标准；通过则结束会话，不通过只生成待确认的 replan 草稿，不会自动重跑。触发场景：验收结果、判断任务是否完成。Keywords: flow evaluate, acceptance, 验收, 评估',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '要验收的会话 id' },
        run_id: { type: 'string', description: '可选，直接指定运行；缺省使用会话当前运行' },
        data_dir: dataDir,
      },
      required: [],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await evaluateFlow(args, dependencies))
    },
  },
  {
    name: 'flow_start',
    description: '从已有 Workflow IR 直接创建并推进运行（手工入口，不经过 Planner）。触发场景：启动工作流、运行流程、创建工作流会话组。Keywords: flow start, workflow run, 工作流, 会话组',
    parameters: {
      type: 'object',
      properties: {
        parent_session_id: { type: 'string', description: '总决策会话 id；同一 id 下的运行在前端组成一个工作流会话组' },
        name: { type: 'string', description: '本次运行显示名；缺省使用 definition.name' },
        definition: {
          type: 'object',
          description: 'Workflow IR。节点支持 det/llm/human/agent/tool/script/http/subflow/sequence/branch/fold/loop/or_else；script 节点用 runtime 指定运行语言（bash/sh/powershell/pwsh/node/ts/python/python3），http 节点直接发起请求，tool 节点调用宿主注册的工具，subflow 节点用 definition 内联或 ref 引用命名定义；节点 id 必须唯一。det 仅兼容历史工作流，新工作流请用 script 做确定性计算',
          properties: {
            version: { type: 'integer', description: '固定为 1' },
            name: { type: 'string' },
            fuel: { type: 'integer', minimum: 1, maximum: 10000 },
            inputs: {
              type: 'object',
              description: '入口契约：字段名 → { type, required, default, enum, min, max, description, judge }。judge=llm 的字段由 IR 内 llm/agent 节点解析原始字符串',
            },
            entry: { type: 'object', description: '入口节点' },
          },
          required: ['version', 'entry'],
        },
        input: { description: '传入入口节点的 Cin；definition 声明 inputs 时必须是满足契约的对象（未知字段或类型不符会报错）' },
        fuel: { type: 'integer', minimum: 1, maximum: 10000, description: '可选，覆盖 definition.fuel' },
        workspace: { type: 'string', description: '可选，本次运行的工作目录（绝对路径）；缺省为 <data_dir>/workspaces/<parent_session_id>' },
        data_dir: dataDir,
      },
      required: ['parent_session_id', 'definition'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await startFlow(args, dependencies))
    },
  },
  {
    name: 'flow_invoke',
    description: '按 run_id 直接复用已有工作流定义运行，不经过需求分析、澄清与规划（不调用任何 LLM 规划）；输入按 definition.inputs 契约校验。全确定性工作流（det/script/http/tool）可零 LLM 执行。触发场景：直接调用工作流、按契约跑数、重复执行已验证流程。Keywords: flow invoke, direct run, 直接运行, 复用工作流, 脚本跑数',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '作为模板的运行 id（草稿或已完成运行均可），其 definition 会被复用' },
        input: { description: '满足 definition.inputs 契约的输入对象；缺省使用来源运行的 input' },
        name: { type: 'string', description: '可选，本次运行显示名' },
        parent_session_id: { type: 'string', description: '可选，覆盖来源运行的会话组 id' },
        fuel: { type: 'integer', minimum: 1, maximum: 10000, description: '可选，覆盖来源运行的 fuel' },
        workspace: { type: 'string', description: '可选，本次运行的工作目录（绝对路径）；缺省沿用来源运行的目录' },
        data_dir: dataDir,
      },
      required: ['run_id'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await invokeFlow(args, dependencies))
    },
  },
  {
    name: 'flow_build',
    description: 'Building 阶段：自顶向下拆解任务骨架，然后逐节点新开会话判断复杂度，达标则直接实现，超标则继续拆成子工作流，最后组装成待确认草稿。人工请求支持 zoom in/out 调整分析角度与范围。触发场景：复杂任务构建、分步生成工作流、骨架拆解。Keywords: flow build, skeleton, decompose, building, 构建阶段, 骨架拆解, 递归拆解, zoom',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'step', 'run', 'answer', 'start_session', 'confirm_dag', 'retry', 'accept', 'status'],
          description: 'start 开始构建并生成骨架；step 推进一个节点；run 推进到等待人工或待确认；answer 在归属子会话回答人工请求（父会话可用 flow_mail 回复）；start_session 推进子会话需求确认并生成骨架 DAG（信息不足会停在 clarifying，等 flow_answer）；confirm_dag 人工确认骨架 DAG 后才开始预构建；retry 构建失败后重置失败节点并继续；accept 人工验收子构建并回填父占位；status 查看构建进度',
        },
        session_id: { type: 'string', description: '构建会话 id（也接受 parent_session_id）' },
        from_run_id: { type: 'string', description: 'start 时可选，父草稿 run_id；与 node_id 一起使用时直接接手该草稿中的 subflow.build 占位' },
        node_id: { type: 'string', description: 'start 时可选，父草稿中要构建的占位节点 id' },
        task: { type: 'string', description: 'start 时的任务目标（从父草稿接手时可省略，自动取 build.task）' },
        name: { type: 'string', description: '可选工作流显示名' },
        workspace: { type: 'string', description: 'start 时的工作目录；缺省为 <data_dir>/workspaces/<session_id>' },
        answer: { type: 'string', description: 'answer 时的人工答复' },
        zoom: {
          type: 'string',
          enum: ['in', 'out'],
          description: 'answer 时的视角调整：in 收紧范围、细化到可实现；out 放宽范围、重新划分边界与分析角度',
        },
        angle: { type: 'string', description: 'answer 时可选的新的分析角度' },
        scope: { type: 'string', description: 'answer 时可选的新的分析范围' },
        request_id: { type: 'string', description: '可选，校验人工请求 id' },
        build_id: { type: 'string', description: '可选，校验构建 id' },
        data_dir: dataDir,
      },
      required: ['action'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      if (args.action === 'start') return json(await startBuild(args, dependencies))
      if (args.action === 'step') return json(await stepBuild(args, dependencies))
      if (args.action === 'run') return json(await runBuild(args, dependencies))
      if (args.action === 'answer') {
        const action = args.zoom === 'in' ? 'zoom_in' : args.zoom === 'out' ? 'zoom_out' : 'answer'
        return json(await answerBuild({ ...args, action }, dependencies))
      }
      if (args.action === 'start_session') return json(await startBuildSession(args, dependencies))
      if (args.action === 'confirm_dag') return json(await confirmBuildDag(args, dependencies))
      if (args.action === 'retry') return json(await retryBuild(args, dependencies))
      if (args.action === 'accept') return json(await acceptBuild(args, dependencies))
      return json(await getBuild(args))
    },
  },
  {
    name: 'flow_workspace',
    description: '查看或设置某个会话的工作目录；设置后该会话后续运行与未启动草稿都会使用新目录，script 节点默认在此执行。触发场景：指定工作目录、切换输出目录、隔离会话文件。Keywords: workspace, 工作目录, 会话目录',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话 id（也接受 parent_session_id）' },
        workspace: { type: 'string', description: '新的工作目录（绝对路径或相对当前进程的路径）；省略则重置为 <data_dir>/workspaces/<session_id>' },
        data_dir: dataDir,
      },
      required: ['session_id'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await configureWorkspace({
        ...args,
        session_id: args.session_id || args.parent_session_id,
      }, dependencies))
    },
  },
  {
    name: 'flow_define',
    description: '保存或更新可复用的命名工作流定义；subflow 节点可通过 ref 引用它，递归也必须通过命名定义实现。触发场景：定义子工作流、复用流程、编写递归工作流。Keywords: flow define, reusable workflow, subflow, 命名定义, 递归',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '定义名，字母开头，仅字母/数字/下划线/连字符' },
        definition: {
          type: 'object',
          description: 'Workflow IR。节点类型含 subflow：可用 definition 内联子流程，或用 ref 引用命名定义；ref 支持字符串或 { name, version }。递归时在 subflow 节点设置 recursion: true，并受 RMS_FLOW_SUBFLOW_MAX_DEPTH 限制',
          properties: {
            version: { type: 'integer', description: '固定为 1' },
            name: { type: 'string' },
            fuel: { type: 'integer', minimum: 1, maximum: 10000 },
            inputs: {
              type: 'object',
              description: '入口契约：字段名 → { type, required, default, enum, min, max, description, judge }',
            },
            entry: { type: 'object', description: '入口节点' },
          },
          required: ['version', 'entry'],
        },
        activate: { type: 'boolean', description: '是否把本次版本设为激活版本，默认 true' },
        data_dir: dataDir,
      },
      required: ['name', 'definition'],
    },
    output,
    async run(args) {
      return json(defineFlow(args))
    },
  },
  {
    name: 'flow_defs',
    description: '列出已保存的命名工作流定义；提供 name 时返回该定义及当前激活版本的完整 IR。触发场景：查看可复用流程、检查递归定义。Keywords: flow defs, list definitions, 定义列表',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '可选定义名；提供后返回完整激活版本' },
        data_dir: dataDir,
      },
      required: [],
    },
    output,
    run(args) {
      return json(listDefinitions(args))
    },
  },
  {
    name: 'flow_resume',
    description: '恢复工作流：等待人工节点时注入 input 并继续；普通暂停可不传 input，从持久化轨迹重放推进。传 session_id 时定位该会话下等待链的入口运行，自动路由到深层子运行并回传结果。触发场景：恢复工作流、提交人工节点、继续流程。Keywords: flow resume, human input, 人工确认, 恢复',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'flow_plan 或 flow_start 返回的工作流运行 id' },
        session_id: { type: 'string', description: '可选，按会话定位等待链的入口运行，恢复时自动向下路由到等待中的子运行并回传结果；与 run_id 二选一' },
        input: { description: '人工节点产出的任意 JSON；waiting_human 必填，普通暂停恢复不传' },
        data_dir: dataDir,
      },
      required: [],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await resumeFlow(args, dependencies))
    },
  },
  {
    name: 'flow_supervise',
    description: '监督当前工作流：草稿尚未执行时，指令会触发会话级修订并重新规划出新草稿；运行中则读取轨迹（有 dsh agent 运行时可进一步核对代码）并生成待确认干预建议，不会直接暂停、终止或修改工作流。触发场景：监督工作流、修改草稿、分析异常、建议中断、建议重新规划。Keywords: flow supervise, workflow analysis, 监督分析, 修改工作流, 中断建议',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '要监督分析的运行 id' },
        instruction: { type: 'string', description: '可选监督指令；它是监督上下文，不会作为业务节点 Cin' },
        data_dir: dataDir,
      },
      required: ['run_id'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await instructFlow(args, dependencies))
    },
  },
  {
    name: 'flow_confirm',
    description: '批准或拒绝规划/监督产生的待确认动作。只有批准后才启动、暂停、终止、重新规划或插入人工节点；重规划会创建新版本并保留旧轨迹。Keywords: flow confirm, approve action, 人工确认, 批准干预',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '动作所属运行 id；版本动作确认后可能返回新 run_id' },
        action_id: { type: 'string', description: 'flow_plan 或 flow_supervise 返回的待确认 action id' },
        approved: { type: 'boolean', description: 'true 批准执行，false 拒绝并保留审计记录' },
        data_dir: dataDir,
      },
      required: ['run_id', 'action_id', 'approved'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      return json(await confirmFlow(args, dependencies))
    },
  },
  {
    name: 'flow_sessions',
    description: '查看会话树：根会话、由构建交接产生的子会话及其深度、状态、未读信件与等待中的人工请求指针；提供 session_id 时返回该节点的子树，可逐层下钻查看细节。触发场景：会话树、子会话详情、下钻查看。Keywords: flow sessions, session tree, 会话树, 子会话, 下钻',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '可选，从该会话开始返回子树' },
        data_dir: dataDir,
      },
      required: [],
    },
    output,
    run(args) {
      return json(listSessionTree(args))
    },
  },
  {
    name: 'flow_mail',
    description: '会话间信箱：在同一根会话树内发送 context/question/bug_report/note 信件，查看收件箱或回复。构建中收到的信件会注入下一次节点会话；bug_report 命中子会话构建节点时触发重建，构建完成后自动回信；回复子会话的人工请求信会自动继续该构建。触发场景：会话间协调、子流程疑似有问题、发信沟通、查看未读。Keywords: flow mail, mailbox, 信箱, 发信, 回信, bug report',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['send', 'inbox', 'reply'],
          description: 'send 发信；inbox 查看收件箱（默认标记已读）；reply 回复某封信',
        },
        session_id: { type: 'string', description: '当前会话 id（发信方/收信方）' },
        to_session: { type: 'string', description: 'send 时的目标会话 id' },
        kind: {
          type: 'string',
          enum: ['context', 'question', 'bug_report', 'note', 'answer'],
          description: '信件类型，默认 note；question 需要对方回复，bug_report 会触发目标构建节点重建',
        },
        subject: { type: 'string', description: '可选主题；相同发信方+节点路径+主题在未处理前幂等' },
        body: { type: 'string', description: '信件正文，超长会被截断' },
        refs: {
          type: 'object',
          description: '可选引用：{ run_id, node_path, node_id }，bug_report 用 node_path 或 node_id 指定要重建的节点',
          properties: {
            run_id: { type: 'string' },
            node_path: { type: 'string' },
            node_id: { type: 'string' },
          },
        },
        requires_reply: { type: 'boolean', description: '可选，是否需要回复；question/bug_report 默认 true' },
        reply_to: { type: 'string', description: 'send 时可选，关联的原信件 id' },
        mark_read: { type: 'boolean', description: 'inbox 时是否标记已读，默认 true' },
        data_dir: dataDir,
      },
      required: ['action', 'session_id'],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      if (args.action === 'send') return json(await sendMail(args, dependencies))
      if (args.action === 'reply') return json(await replyMail(args, dependencies))
      return json(inboxMail(args))
    },
  },
  {
    name: 'flow_get',
    description: '读取工作流会话（阶段、澄清问答、假设、验收标准、评估、动作）或单个运行（当前阶段、状态、每步输入输出、等待中的人工节点）。触发场景：查看会话详情、查看运行详情、步骤轨迹、输入输出。Keywords: flow get, session detail, run trace, 当前阶段, 步骤输入输出',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '要读取的会话 id；提供后返回会话视图' },
        run_id: { type: 'string', description: '要读取的运行 id；未提供 session_id 时使用' },
        data_dir: dataDir,
      },
      required: [],
    },
    output,
    run(args, dependencies = hostDependencies) {
      if (args.session_id) return json(getSession(args, dependencies))
      return json(getFlow(args, dependencies))
    },
  },
  {
    name: 'flow_list',
    description: '列出工作流会话（含未运行会话）及各运行的阶段、状态与验收结果。触发场景：会话列表、工作流列表、运行总览。Keywords: flow list, workflow sessions, 会话列表',
    parameters: {
      type: 'object',
      properties: {
        parent_session_id: { type: 'string', description: '可选，只查看指定总决策会话的运行' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回的会话数，默认 50' },
        data_dir: dataDir,
      },
      required: [],
    },
    output,
    run(args, dependencies = hostDependencies) {
      const runs = listFlow(args, dependencies)
      return json({ ...runs, sessions: listSessionGroups(args, dependencies).sessions })
    },
  },
  {
    name: 'flow_ui',
    description: '启动或返回本地三栏面板，用于新建规划、监督分析、确认干预、预览 DAG、查看 Cin/Cout 和处理人工节点。Keywords: flow ui, workflow panel, 工作流面板',
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 0, maximum: 65535, description: '监听端口；默认 0（自动分配空闲端口）' },
        data_dir: dataDir,
      },
      required: [],
    },
    output,
    async run(args, dependencies = hostDependencies) {
      // dsh 宿主已把面板挂成常驻路由（/flow-runner/），直接返回地址，不再单独起端口
      if (dependencies.panel_path && args.port === undefined) {
        return json({ url: dependencies.panel_path, data_dir: resolveDataDir(args.data_dir), resident: true })
      }
      const panel = await startPanel(args, dependencies)
      return json({ url: panel.url, data_dir: panel.data_dir })
    },
  },
]
