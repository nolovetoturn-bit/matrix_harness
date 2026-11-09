import { validateDefinition, validateInput } from './runner.mjs'
import { createLlmExecutor } from './llm.mjs'

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const PLATFORM_GUIDE = `
你工作在 rms-flow-runner 平台：需求会被编译为本平台原生的 Workflow IR（JSON）并在本机执行，而不是生成 n8n、Camunda、Python、Java 等外部框架的代码或方案。
用户说“当前平台 / 这个平台 / 就在这里做”时，一律指 rms-flow-runner，不要追问外部技术栈，除非用户明确要求外部实现。
本平台能力：
- 控制流：sequence、branch、fold、loop、or_else、failure；节点间以 Cin→Cout 传递 JSON。
- 执行节点：llm(gen/choose)、human、agent（仅 dsh 宿主）、tool、script、http、subflow。
- 子流程：subflow 三选一——definition 内联（只在层数很少且能保证逐层完整时使用）、ref 引用已保存定义（ref 引用自身即递归，必须设置 recursion:true）、build 占位。执行期嵌套深度上限 RMS_FLOW_SUBFLOW_MAX_DEPTH，默认 16，最大 32，覆盖内联与 ref 两种方式；超过上限需先调高环境变量。
- 多层/递归需求默认走「逐层构建」：先划分哪些部分在当前层直接实现、哪些放进子工作流，当前层自己实现，更深层收敛成一个 build 占位，由 Building 的独立子会话逐层生成并回填；不要一次展开所有层。
- 层数必须在规划期静态定死：build 占位必须写 layers（含占位自身的剩余层数），规则是 1 <= layers <= 根层预算-1（根层预算 RMS_FLOW_BUILD_LAYERS，默认 10），只能逐层递减；写成运行时输入或变量、或缺失 layers 都会被拒绝。build.task 里要写明本层预算的具体整数和预算为 1 时的终止行为（直接实现叶子并返回结果），否则子会话会把“剩余层数”当变量继续外推。
- 构建占位：暂未想清实现、或多层/递归中属于更深层的部分，写成 subflow + build.task + build.layers，交给 Building 阶段逐节点实现。
- 运行输出：写入 run.output 与节点轨迹（面板「运行轨迹」可看）；需要打印到控制台时用 script 节点写 stdout。
- 表达式是受限 JSON DSL，不能写 JavaScript。
澄清时只问会改变本平台 IR 的真实歧义：例如层数口径（总 10 层还是根外 10 层）、输出形态（最终整数还是逐层日志）、每层的递进规则。不要问“用什么平台/技术栈”，也不要把“内联嵌套还是自引用递归”当必问项——多层/递归默认逐层构建 + 占位。
`.trim()

export const IR_GUIDE = `
Workflow IR 必须是 {"version":1,"name":"...","fuel":100,"entry":节点}。可选 "inputs" 声明入口契约：
- inputs: {"字段名":{"type":"string|number|integer|boolean|json|array|object","required":true|false,"default":任意JSON,"enum":[...],"min":数字,"max":数字,"judge":"deterministic|llm","description":"..."}}
- 声明了 inputs 后，启动/调用只接受这些字段，未知字段会报错；default 会自动补齐。
- judge:"deterministic"（默认）表示调用方直接传值；judge:"llm" 表示调用方传原始字符串，必须由 entry 里的 llm/agent 节点按工作流定义解析后向下传，且 entry 中至少要有一个 llm/agent 节点。
节点 id 必须唯一、ASCII 字母开头。节点类型：
- det（仅兼容历史工作流，新工作流不要使用）: {"id","type":"det","op":"literal","value":任意JSON}；或 op:"expr", expr:表达式；或 op:"assert", condition:表达式, message。
- llm gen: {"id","type":"llm","mode":"gen","prompt":"...","output":"json"|"text"}。
- llm choose: {"id","type":"llm","mode":"choose","prompt":"...","options":[{"id","label","value"}]}。
- human: {"id","type":"human","prompt":"..."}，用于必须由人提供输入或确认的节点。
- agent: {"id","type":"agent","prompt":"...","system":"...","output":"json"|"text"}，仅 dsh 宿主可用。
- tool: {"id","type":"tool","tool":"已注册插件或工具名","args":表达式,"output":"json"|"text"}，确定性单次调用。
- script: {"id","type":"script","runtime":"bash|sh|powershell|pwsh|node|ts|python|python3","code":"脚本正文","args":["额外参数"],"cwd":"...","timeout_ms":60000,"output":"json"|"text"}，Cin 以 JSON 写入 stdin，stdout 作为 Cout。
- http: {"id","type":"http","method":"GET|POST|PUT|PATCH|DELETE|HEAD","url":"https://...","headers":{...},"body":表达式,"timeout_ms":30000,"output":"json"|"text"}。
- subflow: {"id","type":"subflow","definition":子IR} 内联一次性子流程；或 {"id","type":"subflow","ref":"已保存的定义名"|{"name","version"},"input":表达式,"workspace":"相对目录","fuel":100}。子流程最终 Cout 直接作为本节点 Cout；引用自身时必须设置 recursion:true，且受 RMS_FLOW_SUBFLOW_MAX_DEPTH 限制。
- 多层/递归需求优先只写第 1 层，把第 2..N 层收敛成一个 subflow.build 占位，由 Building 逐层生成；只有层数很少（<=2）且能保证逐层完整时，才一次性写出内联嵌套，且不得只在首层或末层写逻辑。更深层禁止内联进当前 IR，避免输出过大被截断。输出前按层自检节点数与行为是否一致，不要给出结构残缺的多层内联 IR。
- sequence: {"id","type":"sequence","steps":[节点...]}，上一节点 Cout 是下一节点 Cin。
- branch: {"id","type":"branch","condition":表达式,"then":节点,"else":节点}。
- fold: {"id","type":"fold","items":表达式,"initial":任意JSON,"body":节点}，body Cin 为 {acc,item,index}。
- loop: {"id","type":"loop","while":表达式,"max_iterations":数字,"body":节点}。
- or_else: {"id","type":"or_else","primary":节点,"fallback":节点}。
表达式只能用 JSON：{"var":"path"}、{"literal":value}、{"if":[c,a,b]}、{"and":[...]}、{"or":[...]}、{"coalesce":[...]}、{"==="|"!=="|">"|">="|"<"|"<=":[a,b]}、{"in":[a,b]}、{"+"|"-"|"*"|"/"|"%":[...]}、{"!":value}、{"cat":[...]}、{"length":value}、{"range":[start,end]}、{"join":[数组,分隔符]}、{"split":[字符串,分隔符]}。禁止 JavaScript。
不需要 LLM 的确定性工作流只使用 tool/script/http 节点；此时调用方可以直接执行，不经过规划器。
range 生成整数序列（start/end 含端点，最多 200000 项，可倒序）；join 把数组拼成字符串；split 按分隔符切分字符串；表达式只用于控制流条件（branch.condition、loop.while、items）等字段。
需要生成列表时用 script 节点输出 JSON（例如 node：process.stdout.write(JSON.stringify(Array.from({length:10000},(_,i)=>i+1)))），禁止用 fold/loop 逐项枚举。
新工作流的确定性计算、数据变换一律用 script 节点（runtime 选 node/ts/python），不要生成 det 节点；控制流条件和 sequence 串联仍用 JSON 表达式。
优先生成可由 gen/choose/human/script/http 组成的小而明确的流程；不要虚构未注册的工具名，涉及写入等副作用时按任务要求显式声明。
`.trim()

export const BUILD_PLACEHOLDER_GUIDE = `
规划阶段允许对暂时说不清实现的大节点留下「构建占位」，交给后续 Building 阶段逐节点实现：
- 占位写法：{"id":"唯一id","type":"subflow","label":"节点名","build":{"task":"该子流程要完成的完整任务","layers":剩余层数,"inputs":可选入口契约,"sample_input":可选示例输入,"workspace":可选相对目录}}
- layers 是必填整数：含义是“从这个占位开始还剩几层（含占位自己）”，必须满足 1 <= layers <= 根层预算-1（RMS_FLOW_BUILD_LAYERS，默认 10）；只能逐层递减，不允许写成运行时变量；缺 layers 或 layers 不小于当前层都会被拒绝。
- layers 的值形态：直接写具体整数。写占位时就把“下一层预算 = 具体数字”算好填进去，不要写 {"var":...}、模板字符串、“按输入递减”或“剩余的层数再减一”。
- 终止条件必须写进占位 build.task：预算为 1 时该层就是叶子，直接实现并返回结果（例如返回 1），不得再开占位；预算为 2 时下一层预算写 1。子会话只能靠 build.task 理解需求，缺终止条件就会无限向下开子会话。
- definition、ref、build 三选一；占位只能是 subflow 节点，且一旦使用占位，整个工作流在构建完成前不可执行。
- 落笔前先做分层划分：哪些部分在当前层直接实现，哪些放进占位的子工作流；当前层的实际逻辑必须由当前层承担，不能把当前层的活也塞进占位。
- 只对确实需要单独展开的复杂节点使用占位；能用 script/tool/http/llm 直接写清的就直接写，不要滥用。
- 占位节点的 id 必须是 ASCII 字母开头，常被用来生成子会话 id。
- 多层/递归需求不要一次展开全部层：你只规划第 1 层，把第 2..N 层收敛成一个 subflow.build 占位，后续层由 Building 的独立子会话逐层生成并回填。
- 占位 build.task 只传递信息与总结，不是“你要负责实现的内容”清单：按“如果由你独立实现这个子工作流，你需要知道什么”来写——目标、范围、还剩几层（具体数字）、下一层的递进规则、终止行为、输入输出契约、示例。子会话看不到本规划的完整上下文，build.task 是它唯一的任务依据。
- 交接必须保真：任务里的层数口径（总 N 层还是根外 N 层）、终止行为、每层递进规则要原样写进 build.task，不要改写成“不断向下展开”或只写“剩余层数递减”。
- 占位 build.task 里要明确要求子会话继续用 subflow.build 占位逐层实现，每层都写递减的具体整数 layers，预算到 1 时直接实现叶子并返回结果；禁止要求它用 subflow.definition 内联展开剩余层。
- 层数很少（<=2）且逻辑简单时可以直接写清，不强制使用占位。`.trim()

export function parseJson(text) {
  const source = String(text || '').trim()
  const candidates = [source]
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1))
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) } catch {}
  }
  throw new Error(`LLM 未返回合法 JSON：${source.slice(0, 120) || '空内容'}`)
}

function publicExperience(retrieval) {
  return {
    status: retrieval.status,
    query: retrieval.query,
    fallback: Boolean(retrieval.fallback),
    error: retrieval.error || null,
    items: retrieval.entries.map(entry => ({
      id: entry.id,
      title: entry.title,
      path: entry.path || null,
      snippet: entry.snippet || '',
    })),
  }
}

async function defaultRetrieveExperience({ query }) {
  try {
    const store = await import('../../rms-worklog/lib/store.mjs')
    let result = store.searchEntries({ query, limit: 5 })
    let fallback = false
    if (!result.items.length) {
      fallback = true
      result = store.searchEntries({ tags: ['pb-analysis'], limit: 5 })
    }
    const entries = result.items.slice(0, 3).map(item => {
      const full = store.getEntry(item.id)
      return {
        ...item,
        content: String(full?.content || item.snippet || '').slice(0, 4000),
      }
    })
    return { status: entries.length ? 'ok' : 'empty', query, fallback, entries }
  } catch (error) {
    return {
      status: 'degraded', query, fallback: false,
      error: error && error.message ? error.message : String(error), entries: [],
    }
  }
}

function plannerPayload(args, retrieval) {
  return {
    task: args.task,
    planning_instruction: args.instruction || null,
    clarifications: args.clarifications || [],
    assumptions: args.assumptions || [],
    required_acceptance_criteria: args.acceptance_criteria || [],
    current_status: args.current_status || null,
    current_definition: args.current_definition || null,
    default_input: hasOwn(args, 'input') ? args.input : null,
    workspace: args.workspace || null,
    experience: retrieval.entries.map(entry => ({
      id: entry.id, title: entry.title, content: entry.content,
    })),
  }
}

function publicMessages(clarifications) {
  return (clarifications || []).map(item => ({
    question: item.question,
    answer: item.answer,
  }))
}

export async function analyzeRequirement(args, dependencies = {}) {
  const task = String(args.task || '').trim()
  if (!task) throw new Error('task 不能为空')
  const llm = dependencies.llm || createLlmExecutor()
  const response = await llm.complete({
    system: `你是工作流总会话的需求分析员，只判断信息是否足够形成可执行工作流，不设计 IR、不执行业务。
${PLATFORM_GUIDE}
只输出 {"sufficient":true|false,"missing":["缺失信息"],"questions":["向用户追问的问题"],"assumptions":["信息不足但可先采用的假设"]}。
questions 最多 3 条，必须具体、可直接回答；sufficient=true 时 questions 必须为空。
如果给出 assumptions，也必须说明这些假设会在规划中显式写入验收标准。`,
    user: JSON.stringify({
      task,
      round: args.round || 0,
      max_rounds: args.max_rounds || 3,
      clarifications: publicMessages(args.clarifications),
      revision_instruction: args.instruction || null,
    }, null, 2),
  })
  const parsed = parseJson(response.content)
  if (!isObject(parsed) || typeof parsed.sufficient !== 'boolean') {
    throw new Error('需求分析结果缺少 sufficient')
  }
  const strings = value => Array.isArray(value)
    ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 5)
    : []
  return {
    sufficient: parsed.sufficient,
    missing: strings(parsed.missing),
    questions: strings(parsed.questions).slice(0, 3),
    assumptions: strings(parsed.assumptions),
  }
}

function evaluationSnapshot(run, criteria) {
  return {
    task: run.task || run.name,
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
}

export async function evaluateRun(run, criteria, dependencies = {}) {
  const llm = dependencies.llm || createLlmExecutor()
  const response = await llm.complete({
    system: `你是工作流总会话的验收评估员，只读运行事实与验收标准，不修改 Cin/Cout、不执行节点。
只输出 {"passed":true|false,"gaps":["未满足项"],"evidence":["依据"],"recommend":"accept"|"replan"}。
passed=true 时 gaps 必须为空且 recommend 必须为 accept；passed=false 时 recommend 必须为 replan。`,
    user: JSON.stringify(evaluationSnapshot(run, criteria), null, 2),
  })
  const parsed = parseJson(response.content)
  if (!isObject(parsed) || typeof parsed.passed !== 'boolean') {
    throw new Error('验收结果缺少 passed')
  }
  const strings = value => Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : []
  const passed = parsed.passed && run.status === 'completed'
  return {
    passed,
    gaps: passed ? [] : strings(parsed.gaps),
    evidence: strings(parsed.evidence),
    recommend: passed ? 'accept' : 'replan',
  }
}

export async function planDefinition(args, dependencies = {}) {
  const task = String(args.task || '').trim()
  if (!task) throw new Error('task 不能为空')
  const retrieve = dependencies.retrieveExperience || defaultRetrieveExperience
  const retrieval = await retrieve({ query: String(args.experience_query || task).trim(), task })
  const llm = dependencies.llm || createLlmExecutor()
  const system = `${PLATFORM_GUIDE}
你是工作流规划器，只设计 Workflow IR，不执行任务。历史经验仅是参考，不得把经验当作已发生的事实。
结合 clarifications、assumptions 与 required_acceptance_criteria 设计流程，并把可验证的验收标准写入 acceptance_criteria。
只输出 {"summary":"规划摘要","definition":WorkflowIR,"input":入口Cin,"acceptance_criteria":["验收标准"],"citations":["经验id"]} 的合法 JSON。
如果 definition 声明了 inputs，input 必须是满足契约的完整对象：补齐所有 required 字段；judge:"llm" 字段给出一个原始字符串示例，由流程内 llm/agent 节点解析。
${args.workspace ? `当前会话工作目录：${args.workspace}。脚本节点默认在该目录执行，相对 cwd 与文件读写都以它为根；不要在 IR 中写死机器相关的绝对路径。` : ''}
${BUILD_PLACEHOLDER_GUIDE}
${IR_GUIDE}`
  const payload = plannerPayload(args, retrieval)
  let lastError
  let previousOutput = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await llm.complete({
        system,
        user: JSON.stringify(attempt === 0 ? payload : {
          ...payload,
          repair_instruction: `上次输出未通过校验：${lastError}。请修复后只返回完整 JSON。`,
          previous_raw_output: previousOutput.slice(-4000) || null,
        }, null, 2),
      })
      previousOutput = String(response.content || '')
      const parsed = parseJson(response.content)
      if (!isObject(parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
        throw new Error('规划结果缺少 summary')
      }
      const definition = structuredClone(parsed.definition)
      validateDefinition(definition, { allowBuildPlaceholder: true })
      const input = validateInput(definition, hasOwn(parsed, 'input') ? parsed.input : args.input)
      const allowed = new Set(retrieval.entries.map(entry => entry.id))
      const citations = Array.isArray(parsed.citations) ? parsed.citations : []
      const citationIds = [...new Set(citations.map(item => String(isObject(item) ? item.id || '' : item)).filter(id => allowed.has(id)))]
      const criteria = (Array.isArray(parsed.acceptance_criteria) ? parsed.acceptance_criteria : [])
        .map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
      return {
        summary: parsed.summary.trim(),
        definition,
        input,
        acceptance_criteria: criteria.length ? criteria : (args.acceptance_criteria || []).slice(0, 8),
        citations: citationIds,
        retrieval: publicExperience(retrieval),
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error)
    }
  }
  throw new Error(`工作流规划失败：${lastError}`)
}

function compact(value, limit = 1800) {
  const text = JSON.stringify(value ?? null)
  return text.length <= limit ? value : `${text.slice(0, limit)}…[已截断]`
}

function supervisionSnapshot(run, instruction) {
  return {
    task: run.task || run.name,
    instruction: instruction || null,
    definition: run.definition,
    status: run.status,
    current: run.current,
    pending: run.pending,
    error: run.error,
    fuel: run.fuel,
    definition_version: run.definition_version || 1,
    recent_trace: (run.trace || []).slice(-12).map(step => ({
      node_id: step.node_id,
      path: step.path,
      kind: step.kind,
      status: step.status,
      input: compact(step.input),
      output: compact(step.output),
      error: step.error || null,
    })),
  }
}

export async function analyzeRun(run, instruction, dependencies = {}) {
  const snapshot = supervisionSnapshot(run, instruction)
  const system = `你是工作流总会话的监督分析员，不是业务执行器。只能读取轨迹并提出建议，不能修改 Cin/Cout 或直接执行控制。
只输出 {"conclusion":"监督结论","actions":[{"type":"pause|terminate|replan|insert_human","reason":"原因","instruction":"replan时必填的修改要求","prompt":"insert_human时的人工提示"}]}。
没有必要时 actions 返回 []。不要建议与当前状态无关的动作。`
  let content
  if (typeof dependencies.agentRunner === 'function') {
    const response = await dependencies.agentRunner({
      system: `${system}
你可以使用只读工具（read/grep/glob）核对仓库代码、插件实现与工作日志来验证判断；禁止修改任何文件。最终回复只输出要求的 JSON。`,
      prompt: '请阅读工作流运行快照，按需核对代码与经验记录，然后给出监督结论与动作。',
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
  if (!Array.isArray(parsed.actions)) throw new Error('监督结果 actions 必须是数组')
  const allowed = new Set(['pause', 'terminate', 'replan', 'insert_human'])
  const actions = parsed.actions.slice(0, 3).map(action => {
    if (!isObject(action) || !allowed.has(action.type)) throw new Error(`监督动作不支持：${action.type}`)
    return {
      type: action.type,
      reason: String(action.reason || parsed.conclusion).trim(),
      instruction: String(action.instruction || '').trim(),
      prompt: String(action.prompt || '').trim(),
    }
  })
  return { conclusion: parsed.conclusion.trim(), actions }
}
