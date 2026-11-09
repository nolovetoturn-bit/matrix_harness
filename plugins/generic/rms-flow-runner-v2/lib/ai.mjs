import { createLlmExecutor } from './llm.mjs'
import { normalizeSkeleton, readonlyDefinition } from './matrix/schema.mjs'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function parseJson(text) {
  const source = String(text || '').trim()
  const candidates = [source]
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {}
  }
  throw new Error(`LLM 未返回合法 JSON：${source.slice(0, 120) || '空内容'}`)
}

const strings = (value, limit = 8) => Array.isArray(value)
  ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].slice(0, limit)
  : []

/**
 * 平台认知提示：移植自旧版 flow-runner 的 PLATFORM_GUIDE，替换为 matrix 语义。
 * 作用是把模型锚定在本平台 IR 上，避免追问“用 Java 还是 Python”这类外部技术栈。
 */
export const PLATFORM_GUIDE = `
你工作在 rms-flow-runner-v2（matrix 矩阵）平台：需求会被编译为本平台原生 Workflow IR（JSON）并在本机执行，而不是生成 Java、Python、Node.js、n8n、Camunda、Airflow 等外部框架的代码或方案。
用户说“当前平台 / 这个平台 / 就在这里做”时，一律指 rms-flow-runner-v2，不要追问外部技术栈，除非用户明确要求外部实现。
本平台能力：
- matrix 是唯一业务单元：每个 matrix 独立拥有需求、骨架 DAG、预构建、运行记录与验收；骨架里的 group 节点会创建独立子 matrix（有自己的需求与验收），不要在一个 matrix 内联展开多层。
- 控制流：sequence、branch、fold、loop、or_else；节点之间只通过 Cin→Cout 传递 JSON。
- 执行节点：llm(gen/choose)、human、agent（仅 dsh 宿主）、tool、script（node/ts/python/bash/pwsh）、http、det（仅兼容历史，新节点用 script）。
- 表达式是受限 JSON DSL（var/literal/if/and/or/not/coalesce/比较/四则/cat/length/in/range/join/split），不能写 JavaScript。
- 运行输出写入 run.output 与节点轨迹；需要打印到控制台时用 script 节点写 stdout。
澄清时只问会改变骨架的真实歧义：业务边界、输入输出契约、验收标准、是否需要独立子 matrix。不要问“用什么平台/技术栈/编程语言”，也不要把“内联嵌套还是递归”当必问项——多层需求默认用 group 子 matrix 逐层承载。
`.trim()

/**
 * IR 能力说明：移植自旧版 IR_GUIDE，去掉 build 占位与 ref 定义，改为 matrix 引用。
 */
export const IR_GUIDE = `
Workflow IR 必须是 {"version":1,"name":"...","fuel":100,"entry":节点}。可选 "inputs" 声明入口契约：
- inputs: {"字段名":{"type":"string|number|integer|boolean|json|array|object","required":true|false,"default":任意JSON,"enum":[...],"min":数字,"max":数字,"description":"..."}}
节点 id 必须唯一、ASCII 字母开头。节点类型：
- det（仅兼容历史，新节点不要使用）: {"id","type":"det","op":"literal|expr|assert",...}
- llm gen: {"id","type":"llm","mode":"gen","prompt":"...","output":"json"|"text"}。
- llm choose: {"id","type":"llm","mode":"choose","prompt":"...","options":[{"id","label","value"}]}。
- human: {"id","type":"human","prompt":"..."}，挂起等待人工输入。
- agent: {"id","type":"agent","prompt":"...","system":"...","output":"json"|"text"}，仅 dsh 宿主可用。
- tool: {"id","type":"tool","tool":"已注册工具名","args":表达式,"output":"json"|"text"}。
- script: {"id","type":"script","runtime":"node|ts|python|python3|bash|sh|powershell|pwsh","code":"脚本正文","args":["额外参数"],"cwd":"...","timeout_ms":60000,"output":"json"|"text"}，Cin 以 JSON 写入 stdin，stdout 作为 Cout。
- http: {"id","type":"http","method":"GET|POST|PUT|PATCH|DELETE|HEAD","url":"https://...","headers":{...},"body":表达式,"timeout_ms":30000,"output":"json"|"text"}。
- subflow: {"id","type":"subflow","matrix_id":"mx_..."} 引用子 matrix（由骨架 group 节点编译产生，节点实现里禁止手写）。
- sequence: {"id","type":"sequence","steps":[节点...]}，上一节点 Cout 是下一节点 Cin。
- branch: {"id","type":"branch","condition":表达式,"then":节点,"else":节点}。
- fold: {"id","type":"fold","items":表达式,"initial":任意JSON,"body":节点}，body Cin 为 {acc,item,index}。
- loop: {"id","type":"loop","while":表达式,"max_iterations":数字,"body":节点}。
- or_else: {"id","type":"or_else","primary":节点,"fallback":节点}。
- fanout: {"id","type":"fanout","input":表达式,"branches":[叶子节点...],"carry":["输入字段"],"collect":"keyed"|"array"}，把同一份 Cin 分发给多个分支并发执行；branches 只能是叶子节点（禁止嵌套 fanout/merge/其它控制流）；keyed 时 outputs 必须覆盖所有分支 id 与 carry 字段，array 时按声明顺序汇合为数组且不允许 carry。carry 用于把上游字段直接带入汇总输出，避免生成只做透传的分支。
- merge: {"id","type":"merge","inputs":{...},"outputs":{...},"mapping":{"输出字段":表达式}}，按 mapping 把 fanout 的 keyed 输出重组成单一 Cout；mapping 的作用域就是 merge 的 Cin，不执行外部脚本。
表达式只能用 JSON：{"var":"path"}、{"literal":value}、{"if":[c,a,b]}、{"and":[...]}、{"or":[...]}、{"coalesce":[...]}、{"==="|"!=="|">"|">="|"<"|"<=":[a,b]}、{"in":[a,b]}、{"+"|"-"|"*"|"/"|"%":[...]}、{"!":value}、{"cat":[...]}、{"length":value}、{"range":[start,end]}、{"join":[数组,分隔符]}、{"split":[字符串,分隔符]}。禁止 JavaScript。
新节点的确定性计算、数据变换一律用 script（runtime 选 node/ts/python），不要生成 det。需要生成列表时用 script 输出 JSON，禁止用 fold/loop 逐项枚举（会消耗 fuel 并产生大量 trace）。
`.trim()

export const SKELETON_GUIDE = `
你为一个 matrix（矩阵）规划骨架 DAG，只做拆解，不写任何节点实现细节，也不内联多层结构。
matrix 是唯一业务单元：每个 matrix 独立完成需求、骨架、预构建、运行与验收。
骨架是扁平的：根节点 children 就是本 matrix 的执行步骤，按顺序左→右执行。

节点字段（每个 children 节点必须有）：
- id：ASCII 字母开头，唯一。
- type：最终节点类型，只能是 llm / agent / script / http / tool / human / group / fanout / merge / branch；领域元素根 matrix 按领域上下文还可以使用 persist / stub。DAG 确认后类型锁定，预构建不得改变。
- label：显示名。
- intent：一句话说明该节点做什么、业务规则是什么。
- inputs：输入契约 Cin（必填，JSON 对象/数组/字符串描述，写明字段、类型、来源）。
- outputs：输出契约 Cout（必填，JSON 对象/数组/字符串描述，写明字段、类型、下游怎么用）。
- complexity：1..5，>=4 表示实现难度高。

type 选择规则：
- group：需要独立成子 matrix 的子流程。只有满足“有独立需求边界与验收标准 / 可能继续多层拆分 / 需要单独运行与验收”之一才用。group 不写 children，字段同样要给全（子 matrix 会拿 inputs/outputs 和 intent 自行完成需求→骨架→验收）。
- script：确定性计算、数据变换、字符串处理（首选）。
- llm：自然语言判断或生成；agent：只读调查代码/文件；tool：调用已注册工具；http：直接请求；human：必须由人提供输入或确认。
- branch：条件执行。字段 condition 是作用于该节点 Cin 的表达式（如 {">":[{"var":"value"},0]}），then 必选、else 可选；then/else 只能是叶子类型（不能嵌套控制流），它们的 Cin 只能来自 branch 的 inputs，且两路的 outputs 都必须覆盖 branch 声明的 outputs。condition=false 且没有 else 时 branch 直接透传输入，因此这种情况下 outputs 必须由 inputs 覆盖。
- 不允许把 sequence/loop/or_else 写成骨架节点；顺序由 children 表达，条件分支只能用 branch，分支内部不要再嵌套控制流。
- fanout：只在确实需要“同一个上游输出分发给多个并行节点，再汇合”时使用。fanout 节点用 children 声明 1..8 个分支（分支只能是叶子类型，不能是 fanout/merge）；inputs/outputs 必须写成字段对象，keyed 默认且 outputs 的键必须覆盖所有分支 id 与 carry 字段。如果下游还需要上游原始字段，用 carry 直接带上（例如 carry:["value"]），不要单独生成只做透传的分支节点。紧接其后的下游通常是 merge。
- merge：只用于汇合 fanout 输出。inputs 写 fanout 汇总得到的分支键，outputs 写最终字段，mapping 必须是 {"输出字段":表达式} 且与 outputs 一一对应；merge 不需要实现细节，预构建会直接合成。
- persist：对当前领域 persistence model 的 create/get/update/delete/list，字段 {"model_id":"mdl_...","operation":"create|get|update|delete|list","key":"可选","where":{},"inputs":{},"outputs":{}}；只允许出现在 persistence model 根 matrix 与 stub 根 matrix，request/response model 与 interact 根 matrix 禁止。
- stub：调用当前领域 stub 的某个 operation，字段 {"stub_id":"stb_...","operation":"operation 名","request_model_ids":[],"response_model_ids":[],"inputs":{},"outputs":{}}；interact 根 matrix 允许 stub、禁止 persist。

硬约束：
- 节点数 1..8，节点 id 全骨架唯一；不要内联多层，更深层用 group。
- 每个节点必须写全 inputs 和 outputs，不能省略、不能用空对象/空数组占位。
- 数据流必须逐节点对齐：根 entry 若需要运行时输入必须声明 inputs；第一个节点的 Cin 只能来自 entry.inputs，之后每个节点的 Cin 只能来自上一节点的 outputs。
- 若下游节点同时需要“根入口字段 + 上游结果”，必须让上游节点把这些入口字段一起放进 outputs 透传（例如子流程输出 {value, result}）；不得假设运行时会自动保留根输入，也不能读取未声明的入口字段。
- 优先少拆：能用 2-4 个步骤直说的，不要造 group；group 只用于确实要独立交付的子流程。
- 不要为“汇总/输出”这类收尾动作单独造节点，除非它有自己的业务逻辑。
- 若 payload.revision_instruction 存在：必须按意见真正修改节点类型/契约/拆分，并在 summary 写明改了什么；payload.previous_skeleton 是上一版只读 DAG，禁止原样重生成。

输出只允许一个 JSON：
{"summary":"规划摘要","skeleton":{"entry":{"id":"root","label":"...","intent":"...","inputs":{"value":{"type":"number","required":true,"description":"运行时输入"}},"children":[
  {"id":"fetch","type":"script","label":"拉取数据","intent":"...","inputs":{"source":"string"},"outputs":{"rows":"array"},"complexity":2},
  {"id":"report","type":"group","label":"独立报告子流程","intent":"...","inputs":{"rows":"array"},"outputs":{"report":"object"},"complexity":4}
]}},"acceptance_criteria":["可验证的验收标准"],"assumptions":["假设"]}
需要一入多出再汇合时，示例：
{"id":"calc","type":"fanout","label":"并行计算","intent":"同一输入分发给加一分支并带上原值","inputs":{"value":"number"},"outputs":{"plus_one":"object","value":"number"},"carry":["value"],"collect":"keyed","complexity":3,"children":[
  {"id":"plus_one","type":"script","label":"加一","intent":"返回 value+1","inputs":{"value":"number"},"outputs":{"result":"number"},"complexity":1}
]},
{"id":"join","type":"merge","label":"汇合","intent":"把分支结果整理成下游契约","inputs":{"plus_one":"object","value":"number"},"outputs":{"value":"number","result":"number"},"mapping":{"value":{"var":"value"},"result":{"var":"plus_one.result"}},"complexity":1}
需要条件执行时，示例：
{"id":"route","type":"branch","label":"按正负分流","intent":"value >= 0 走 then，否则走 else","inputs":{"value":"number"},"outputs":{"result":"number"},"condition":{">=":[{"var":"value"},0]},"complexity":2,"then":{
  "id":"positive","type":"script","label":"非负处理","intent":"返回正结果","inputs":{"value":"number"},"outputs":{"result":"number"},"complexity":1
},"else":{
  "id":"negative","type":"script","label":"负数处理","intent":"返回负结果","inputs":{"value":"number"},"outputs":{"result":"number"},"complexity":1
}}
`.trim()

export async function analyzeRequirement(args, dependencies = {}) {
  const task = String(args.task || '').trim()
  if (!task) throw new Error('task 不能为空')
  const llm = dependencies.llm || createLlmExecutor()
  const response = await llm.complete({
    system: `${PLATFORM_GUIDE}
你是 matrix 的需求分析员，只判断信息是否足够形成可执行骨架，不设计节点、不执行业务。
只输出 {"sufficient":true|false,"missing":["缺失信息"],"questions":["向用户追问的问题"],"assumptions":["信息不足但可先采用的假设"],"summary":"一句话需求结论"}。
questions 最多 3 条，必须具体、可直接回答；sufficient=true 时 questions 必须为空。
如果给出 assumptions，必须说明这些假设会在骨架与验收标准中显式写入。
只问会改变骨架的真实歧义（业务边界、输入输出契约、验收标准、是否需要独立子 matrix）；不要问“用什么平台/技术栈/编程语言”。`,
    user: JSON.stringify({
      task,
      round: args.round || 0,
      clarifications: (args.clarifications || []).map(item => ({ question: item.question, answer: item.answer })),
      revision_instruction: args.instruction || null,
    }, null, 2),
  })
  const parsed = parseJson(response.content)
  if (!isObject(parsed) || typeof parsed.sufficient !== 'boolean') throw new Error('需求分析结果缺少 sufficient')
  return {
    sufficient: parsed.sufficient,
    missing: strings(parsed.missing, 5),
    questions: strings(parsed.questions, 3),
    assumptions: strings(parsed.assumptions, 8),
    summary: String(parsed.summary || '').trim(),
  }
}

function skeletonPayload(args) {
  return {
    task: args.task,
    analysis_summary: args.analysis?.summary || null,
    clarifications: (args.clarifications || []).map(item => ({ question: item.question, answer: item.answer })),
    assumptions: args.assumptions || [],
    revision_instruction: args.instruction || null,
    previous_skeleton: args.previousSkeleton ? readonlyDefinition(args.previousSkeleton) : null,
    child_hint: args.childHint || null,
    domain_context: args.domainContext || null,
  }
}

/** 领域绑定上下文说明：只在领域元素根 matrix 注入。 */
function domainGuide(context) {
  const models = (context.models || []).map(model => `${model.name}(${model.id}, ${model.type}/${model.kind})`).join('、') || '（无）'
  const stubs = (context.stubs || []).map(stub => `${stub.name}(${stub.id})操作：${(stub.operations || []).map(operation => operation.name).join('/') || '无'}`).join('；') || '（无）'
  return `
【领域绑定上下文】
当前 matrix 是领域元素 ${context.element.type}「${context.element.name}」（${context.element.id}）。
允许的节点类型：${context.allowed_node_types.join(' / ')}。
领域 Models：${models}
领域 Stubs：${stubs}
领域规则：
${(context.rules || []).map(rule => `- ${rule}`).join('\n')}
persist / stub 节点同样必须写全 inputs 与 outputs，且 Cin/Cout 必须与上下游对齐。`.trim()
}

/**
 * 生成骨架 DAG。校验失败时带着上一版输出重试一次。
 */
export async function planSkeleton(args, dependencies = {}) {
  const task = String(args.task || '').trim()
  if (!task) throw new Error('task 不能为空')
  const llm = dependencies.llm || createLlmExecutor()
  const system = `${PLATFORM_GUIDE}
${IR_GUIDE}
${SKELETON_GUIDE}
${args.domainContext ? `${domainGuide(args.domainContext)}\n` : ''}本次只输出骨架 JSON，不要输出任何节点的 Workflow IR 实现。
${args.instruction ? `本次修订要求：${args.instruction}` : ''}`
  const payload = skeletonPayload(args)
  let lastError
  let previousOutput = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let content
    if (dependencies.skeletonPlanner) {
      content = await dependencies.skeletonPlanner({ system, payload, previousOutput, lastError })
    } else {
      content = (await llm.complete({
        system,
        user: JSON.stringify(attempt === 0 ? payload : {
          ...payload,
          repair_instruction: `上次输出未通过校验：${lastError}。请修复后只返回完整 JSON。`,
          previous_raw_output: previousOutput.slice(-4000) || null,
        }, null, 2),
      })).content
    }
    previousOutput = String(content || '')
    try {
      const parsed = parseJson(content)
      if (!isObject(parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
        throw new Error('骨架结果缺少 summary')
      }
      const skeleton = normalizeSkeleton(parsed.skeleton)
      return {
        summary: parsed.summary.trim(),
        skeleton,
        acceptance_criteria: strings(parsed.acceptance_criteria, 8),
        assumptions: strings(parsed.assumptions, 8),
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error)
    }
  }
  throw new Error(`骨架生成失败：${lastError}`)
}

export const NODE_IMPLEMENT_GUIDE = `
你负责一个 matrix 骨架节点的真实编码与验证，只输出该节点对应的 Workflow IR 节点 JSON，不输出解释、Markdown 或进度说明。
节点契约：
- 该节点的 id、type、inputs、outputs 已在 DAG 中锁定：顶层 "id" 必须等于给定 id，"type" 必须等于给定 type，不得改变类型或改名。
- 必须按给定的 inputs（Cin）与 outputs（Cout）实现：Cin 是上一步输出的 JSON，Cout 是本节点输出的 JSON；不要依赖未声明的字段。
- 节点之间只能通过 Cin/Cout 传数据，不要读取、复用或推测其它节点/其它 matrix 留下的文件与产物。
- 当前工作目录是本节点专属目录（本 matrix 工作区下的 .nodes/<node>），只允许读写本目录内的文件；不要写死机器相关的绝对路径。
- 确定性计算、数据变换、字符串处理一律用 script 节点（runtime：node/ts/python/bash/pwsh）；Cin 从 stdin 读入，stdout 必须是 JSON 或显式 output:"text"。
- 需要判断/生成自然语言内容时用 llm 节点（mode:gen 默认输出 JSON）；需要对代码或文件做只读调查时用 agent 节点。
- 禁止使用 subflow / build 占位 / ref 定义（多层需求由骨架的 group 节点创建子 matrix 表达）。
- 禁止把 type 改成 sequence/branch 等控制类型：顺序由骨架 children 表达，分支逻辑写进 script/llm 节点内部。
编码与验证要求：
- 如果节点是 script：必须使用写文件工具把脚本写入本节点目录，再使用命令执行工具以本节点目录为 cwd 做语法检查和可行的试运行；失败要先修复再试；不得只把未经尝试的代码贴出来。
- node 脚本既可以用 ESM（import/export），也可以用 CommonJS（require/module.exports）；两种写法都能运行，但不要在同一个脚本里混用。
- 运行期采用文件式 I/O：Cin 在 RMS_INPUT_FILE，Cout 写入 RMS_OUTPUT_FILE（JSON），本次运行共享的目录是 RMS_RUN_DIR；大文件/多文件产物优先放共享目录。stdin/stdout 仍兼容。
- 输入里出现 previous_implementation 时，表示这是对已有节点的修复：在原有代码基础上按 feedback / 修复说明改，不要推翻重写无关部分。
- 必须在当前会话中亲自同步完成编码和验证；不得使用 subagent 或后台任务，不得回复“正在等待”。
- 全部验证结束后，最终消息只输出 {"node":{...}} 形式的本节点 JSON；node.code 必须包含验证后的完整脚本正文，不能只给文件路径。
${IR_GUIDE}
`.trim()

/**
 * 调用编码会话实现一个 skeleton step 节点，返回待校验的 IR 节点。
 */
export async function implementNode(args, dependencies = {}) {
  const system = `${NODE_IMPLEMENT_GUIDE}
只输出 {"node":WorkflowIR节点} 的合法 JSON。`
  const payload = {
    task: args.task,
    node: {
      id: args.node.id,
      type: args.node.type,
      label: args.node.label,
      intent: args.node.intent,
      inputs: args.node.inputs,
      outputs: args.node.outputs,
      complexity: args.node.complexity,
    },
    siblings: args.siblings || [],
    previous_nodes: args.previousNodes || [],
    acceptance_criteria: args.acceptanceCriteria || [],
    pending_instructions: args.instructions || [],
    feedback: args.feedback || null,
    previous_implementation: args.previousImplementation || null,
  }
  let content
  let sessionId = null
  if (dependencies.codingAgentRunner) {
    const response = await dependencies.codingAgentRunner({
      system,
      prompt: '请在该工作目录内实现这个节点：先读现有文件了解上下文，必要时写脚本文件并自测，最后只输出要求的 JSON。',
      input: payload,
      workspace: args.workspace,
      cwd: args.cwd,
      sessionId: args.sessionId,
      parentSessionId: args.parentSessionId,
    })
    content = response?.text ?? response?.content ?? response
    sessionId = response?.session_id || null
  } else {
    const llm = dependencies.llm || createLlmExecutor()
    content = (await llm.complete({ system, user: JSON.stringify(payload, null, 2) })).content
  }
  const parsed = parseJson(content)
  if (!isObject(parsed)) throw new Error('节点实现结果必须是对象')
  const node = isObject(parsed.node) ? parsed.node : parsed
  if (!isObject(node)) throw new Error('节点实现结果缺少 node')
  if (node.id !== args.node.id) throw new Error(`节点 id 必须为 ${args.node.id}，实际为 ${node.id}`)
  return { node, session_id: sessionId || null }
}

function compact(value, limit = 1800) {
  const text = JSON.stringify(value ?? null)
  return text.length <= limit ? value : `${text.slice(0, limit)}…[已截断]`
}

/**
 * 验收/评估运行（只读，不改变门禁状态）。
 */
export async function evaluateRun(run, criteria, dependencies = {}) {
  const llm = dependencies.llm || createLlmExecutor()
  const snapshot = {
    task: run.task,
    acceptance_criteria: criteria,
    status: run.status,
    output: compact(run.output, 2400),
    error: run.error || null,
    trace: (run.trace || []).slice(-24).map(step => ({
      node_id: step.node_id,
      path: step.path,
      kind: step.kind,
      status: step.status,
      output: compact(step.output, 600),
      error: step.error || null,
    })),
  }
  const response = await llm.complete({
    system: `你是 matrix 的验收评估员，只读运行事实与验收标准，不修改定义、不执行节点。
只输出 {"passed":true|false,"gaps":["未满足项"],"evidence":["依据"],"recommend":"accept"|"replan"}。
passed=true 时 gaps 必须为空且 recommend 必须为 accept。`,
    user: JSON.stringify(snapshot, null, 2),
  })
  const parsed = parseJson(response.content)
  if (!isObject(parsed) || typeof parsed.passed !== 'boolean') throw new Error('验收结果缺少 passed')
  const passed = parsed.passed && run.status === 'completed'
  return {
    passed,
    gaps: passed ? [] : strings(parsed.gaps, 8),
    evidence: strings(parsed.evidence, 8),
    recommend: passed ? 'accept' : 'replan',
  }
}

/**
 * 监督分析（移植自旧版 supervisor 角色）：只读运行轨迹与定义，给出结论和建议，
 * 不修改定义、不执行节点、不直接干预门禁。
 */
export async function analyzeRun(args, dependencies = {}) {
  const snapshot = {
    task: args.task,
    state: args.state,
    instruction: args.instruction || null,
    definition: compact(args.definition, 4000),
    skeleton_summary: args.skeletonSummary || null,
    runs: (args.runs || []).slice(0, 3).map(run => ({
      id: run.id,
      status: run.status,
      current: run.current,
      pending: run.pending,
      error: run.error,
      trace: (run.trace || []).slice(-16).map(step => ({
        node_id: step.node_id,
        path: step.path,
        kind: step.kind,
        status: step.status,
        output: compact(step.output, 600),
        error: step.error || null,
      })),
    })),
  }
  const system = `${PLATFORM_GUIDE}
你是 matrix 的监督分析员，只读需求、骨架、定义与运行轨迹，给出结论与建议；不能修改定义、Cin/Cout 或直接执行节点，也不能替用户做验收决定。
只输出 {"conclusion":"监督结论","suggestions":["可执行建议"],"risks":["风险或异常"]}；没有风险时 risks 返回 []。
建议必须具体、指向可操作的下一步（例如补哪个节点、调整哪个契约、重试哪个失败项）。`
  let content
  if (typeof dependencies.agentRunner === 'function') {
    const response = await dependencies.agentRunner({
      system: `${system}
你可以使用只读工具（read/grep/glob）核对代码与产物来验证判断；禁止修改任何文件。最终回复只输出要求的 JSON。`,
      prompt: '请阅读 matrix 快照，按需核对代码与运行产物，然后给出监督结论与建议。',
      input: snapshot,
    })
    content = response?.text ?? response?.content ?? response
  } else {
    const llm = dependencies.llm || createLlmExecutor()
    content = (await llm.complete({ system, user: JSON.stringify(snapshot, null, 2) })).content
  }
  const parsed = parseJson(content)
  if (!isObject(parsed) || typeof parsed.conclusion !== 'string' || !parsed.conclusion.trim()) {
    throw new Error('监督结果缺少 conclusion')
  }
  return {
    conclusion: parsed.conclusion.trim(),
    suggestions: strings(parsed.suggestions, 6),
    risks: strings(parsed.risks, 6),
  }
}
