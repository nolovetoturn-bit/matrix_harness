import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { collectBuildPlaceholders, replaceBuildPlaceholder, validateDefinition, validateInput } from './runner.mjs'
import { IR_GUIDE, parseJson } from './ai.mjs'

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
const ROLES = new Set(['llm', 'human', 'agent', 'tool', 'script', 'http', 'group'])
const SKELETON_MARKER = '工作流骨架拆解器'
const NODE_MARKER = '工作流节点构建器'

function limit(value, fallback, min, max) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

export function buildLimits(env = process.env) {
  return {
    complexity_max: limit(env.RMS_FLOW_BUILD_COMPLEXITY_MAX, 3, 1, 5),
    max_depth: limit(env.RMS_FLOW_BUILD_MAX_DEPTH, 8, 1, 8),
    max_nodes: limit(env.RMS_FLOW_BUILD_MAX_NODES, 40, 1, 500),
    max_sessions: limit(env.RMS_FLOW_BUILD_MAX_SESSIONS, 60, 1, 500),
  }
}

/** 根构建的层数预算：含自身层数的构建层上限，必须由任务在构建前一次性定死。 */
export function buildLayerBudget(env = process.env) {
  return limit(env.RMS_FLOW_BUILD_LAYERS, 10, 1, 32)
}

/** 当前构建自己的层数预算：context.layers 逐层传递，缺省回退到全局预算。 */
export function buildLayersOf(state) {
  const layers = Number(state?.context?.layers)
  return Number.isInteger(layers) && layers >= 1 && layers <= 32 ? layers : buildLayerBudget()
}

const OUTPUT_CONTRACT = {
  implement: { decision: 'implement', complexity: '1..5', node: '完整 IR 节点，id 必须与给定 id 一致' },
  decompose: { decision: 'decompose', complexity: '1..5', children: '[SIR 节点，1..6 个]' },
  need_human: {
    decision: 'need_human',
    question: '需要人确认的问题',
    options: ['可选答案'],
    suggested_zoom: 'in|out',
    reason: '为什么无法自行决定',
  },
}

const NODE_GUIDE = `你负责工作流中的一个节点，只产出这个节点需要的 JSON。
可用 decision：
1. implement：复杂度已在阈值内，直接给出完整可执行 IR 节点。
2. decompose：节点过大，拆成 1..6 个子节点（SIR），每个子节点声明 id/role/intent/inputs/outputs/complexity。
3. need_human：缺少关键信息或需要人决定分析角度/范围时请求人工，不要猜测。
4. implement 的 IR 里可以保留下一层 subflow.build 占位：多层/递归任务只实现当前层，更深层用一个占位表达，Building 会为每个占位创建独立子会话继续构建。占位必须写 build.layers（含自身的剩余层数），且必须小于 limits.layers；limits.layers=1 时不能再出现占位。
   limits.layers 是具体整数（本次请求直接给出），占位 layers 直接写 limits.layers-1 这个整数，不要引用 inputs、变量或“剩余层数递减”。
node 是单个节点对象，不是完整 workflow definition。subflow 节点必须三选一且只能选一个：definition（{"version":1,"entry":完整节点}）、ref、build；写不清时优先用 build 占位。
SIR 节点字段：{"id":"ASCII 字母开头的唯一 id","role":"llm|human|agent|tool|script|http|group","intent":"一句话目标","description":"可选补充","inputs":{契约},"outputs":{契约},"complexity":1到5}。
人工请求会支持 zoom：zoom_in 表示收紧范围、细化到可实现；zoom_out 表示放宽范围、重新划分边界与分析角度。人物给出的 scope/angle/guidance 优先级最高。`

const NODE_PLACEHOLDER_GUIDE = `多层、递归或重复结构的需求不要在一个节点里展开全部层：
- 先做分层划分再输出 IR：哪些部分在本层直接实现，哪些放进子工作流占位。当前层的实际逻辑必须由本层承担，不能把当前层的活也推给占位。
- 只实现当前层，把更深层或重复部分写成一个 subflow.build 占位，由 Building 为每个占位创建独立子会话继续构建，直到叶子层。
- 层数必须静态定死：每个占位都要写 build.layers，表示“从这个占位开始还剩多少层（含占位自己）”，必须是 1..当前 layers-1 的整数；当前层 layers=1 时禁止再出现占位，必须在本层直接实现。layers 只能逐层递减，不允许继承运行时输入或写成变量。
- 层数取值形态：本次请求的 limits.layers 是具体整数，占位 layers 直接写 limits.layers-1；不要写 {"var":...}、模板字符串或“剩余的层数再减一”。
- 占位 build.task 必须把交接要点写成具体值：本层是第几层、下一层预算是一个具体整数、预算为 1 时的终止行为（直接实现叶子并返回什么）。禁止写“remaining / 剩余层数递减 / 按变量推进”这类运行时表述。
- 交接保真：占位 build.task 里的目标、业务规则、层数口径、终止条件必须原样继承任务正文，不得压缩、改写或外推；子会话看不到父会话上下文，build.task 是它唯一的需求来源。
- 占位 build.task 只传递信息与总结，不是“你要负责实现的内容”清单：按“如果由你独立实现这个子工作流，你需要知道什么”来写——目标、范围、还剩几层（layers）、下一层的递进规则、输入输出契约、示例。子会话看不到父会话的完整上下文，build.task 是它唯一的任务依据。
- 占位写法：{"id":"下一层的唯一 id","type":"subflow","label":"下一层","build":{"task":"自包含任务","layers":2,"inputs":可选契约,"sample_input":可选示例输入}}
- 禁止用 subflow.definition 把更深层内联进当前节点的 IR；任务描述或上游要求“内联展开全部剩余层”时，以本节为准，改用 build 占位，避免输出过大被截断。
- 占位的子会话是独立的，构建深度上限只限制单次构建内的嵌套；不要为了绕开深度上限而内联剩余层。
- implement 结果必须是当前层的可执行 IR；不能只返回一个 build 占位，也不能让占位 id 等于当前节点 id。
- 当前层本身就是完整叶子实现时直接 implement，不要为了分层而滥用占位。`

const NODE_CODING_GUIDE = `你负责工作流中的一个节点，并在给定工作区内完成真实编码。
当前工作目录是本节点专属目录，脚本直接写在这里；只允许读写本节点目录内的文件。
不要读取、复用或推测其它节点/其它层留下的文件与产物；节点之间只能通过 Cin/Cout 契约传递数据，不共享中间文件。
如果 decision 为 implement 且节点是 script：必须使用写文件工具把脚本写入本节点目录，再使用命令执行工具以本节点目录为 cwd 做语法检查和可行的试运行；失败要先修复再试。不得只把未经尝试的代码贴出来。
必须在当前会话中亲自同步完成编码和验证；不得使用 subagent 或后台任务，不得回复正在等待。全部验证结束后，最终消息只输出 {"decision":"implement","complexity":1,"node":{...}} 形式的本节点 JSON，不要输出完整 workflow definition、Markdown 或进度说明。node.code 必须包含验证后的完整脚本正文，不能只给文件路径。不要修改工作区以外的文件，不要执行与工作流无关的命令。
可用 decision：
1. implement：复杂度已在阈值内，直接给出完整可执行 IR 节点。
2. decompose：节点过大，拆成 1..6 个子节点（SIR），每个子节点声明 id/role/intent/inputs/outputs/complexity。
3. need_human：缺少关键信息或需要人决定分析角度/范围时请求人工，不要猜测。
4. implement 的 IR 里可以保留下一层 subflow.build 占位：多层/递归任务只实现当前层，更深层用一个占位表达，Building 会为每个占位创建独立子会话继续构建。占位必须写 build.layers（含自身的剩余层数），且必须小于 limits.layers；limits.layers=1 时不能再出现占位。
   limits.layers 是具体整数（本次请求直接给出），占位 layers 直接写 limits.layers-1 这个整数，不要引用 inputs、变量或“剩余层数递减”。
node 是单个节点对象，不是完整 workflow definition。subflow 节点必须三选一且只能选一个：definition（{"version":1,"entry":完整节点}）、ref、build；写不清时优先用 build 占位。`

const SKELETON_GUIDE = `你只做工作流骨架拆解，不写任何节点实现细节。
只输出 {"name":"工作流名","summary":"拆解摘要","inputs":{入口契约},"input":{入口Cin},"children":[SIR节点...]} 的合法 JSON。
SIR 节点字段：{"id":"ASCII 字母开头的唯一 id","role":"llm|human|agent|tool|script|http|group","intent":"一句话目标","description":"可选补充","inputs":{契约},"outputs":{契约},"complexity":1到5}。
要求：
- children 只放顶层节点，1..8 个；大的节点用 role:"group" 并给出 complexity。
- complexity 1..5，>=4 表示后续必须继续拆解。
- inputs/outputs 用 JSON 描述字段（可参考 IR 的 inputs 契约写法），它决定节点之间如何对齐。
- 若声明了 inputs，input 必须给出满足契约的完整启动输入。
- 多层/递归任务只拆当前层，更深层收敛成一个 group 子节点，由它的节点会话继续产出下一层占位，不要一次拆出所有层。
- 多层任务的节点 intent 必须写成具体口径：本层预算 limits.layers 是几、下一层预算具体是几、预算为 1 时直接产出什么结果；不要用“剩余层数递减 / remaining”这类运行时表述。
- 若 payload.revision 存在，这是对上一版 DAG 的修订：必须按 revision.instruction 真正修改结构（节点类型、层级、终止行为等），在 summary 里写明改了什么；payload.previous_definition 是上一版只读 DAG，禁止原样重生成。
- id 只用 ASCII 字母、数字、下划线、连字符。`

function sanitizeId(raw, path) {
  const id = String(raw || '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error(`${path} 节点 id 不合法：${id || '空'}`)
  return id
}

function normalizeContract(raw) {
  return isObject(raw) && Object.keys(raw).length ? clone(raw) : null
}

function normalizeSkeletonNode(raw, path, depth) {
  if (!isObject(raw)) throw new Error(`${path} 必须是对象`)
  const role = String(raw.role || '').trim()
  if (!ROLES.has(role)) throw new Error(`${path}.role 不支持：${role || '空'}`)
  const intent = String(raw.intent || '').trim()
  if (!intent) throw new Error(`${path}.intent 不能为空`)
  const complexity = Number(raw.complexity)
  return {
    id: sanitizeId(raw.id, path),
    path,
    depth,
    role,
    intent,
    description: String(raw.description || '').trim(),
    inputs: normalizeContract(raw.inputs),
    outputs: normalizeContract(raw.outputs),
    complexity: Number.isInteger(complexity) ? Math.min(5, Math.max(1, complexity)) : null,
    status: 'pending',
    zoom: 'normal',
    angle: null,
    scope: null,
    guidance: [],
    ir: null,
    children: [],
  }
}

function normalizeChildren(raw, parentPath, depth, maxDepth, maxCount = 6) {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${parentPath} 拆解结果缺少 children`)
  if (raw.length > maxCount) throw new Error(`${parentPath} 子节点不能超过 ${maxCount} 个`)
  const seen = new Set()
  return raw.map((item, index) => {
    const path = `${parentPath}/${index}`
    const node = normalizeSkeletonNode(item, path, depth + 1)
    if (seen.has(node.id)) throw new Error(`${parentPath} 子节点 id 重复：${node.id}`)
    seen.add(node.id)
    return node
  })
}

function nodeByPath(root, path) {
  if (!path) return root
  const parts = String(path).split('/').filter(Boolean).map(Number)
  let current = root
  for (const index of parts) {
    if (!current || !Array.isArray(current.children) || !current.children[index]) return null
    current = current.children[index]
  }
  return current
}

function allNodes(node, out = []) {
  out.push(node)
  for (const child of node.children || []) allNodes(child, out)
  return out
}

function countNodes(state) {
  return allNodes(state.root).length - 1
}

function parentOf(root, path) {
  if (!path || !String(path).includes('/')) return null
  return nodeByPath(root, String(path).split('/').slice(0, -1).join('/'))
}

function siblingsOf(root, path) {
  const parent = parentOf(root, path)
  const list = parent ? parent.children : root.children
  return (list || []).filter(node => node.path !== path)
}

function normalizeIrNode(raw, sire) {
  if (!isObject(raw)) throw new Error(`${sire.path} implement 结果缺少 node`)
  const node = clone(raw)
  node.id = sire.id
  if (!node.label) node.label = sire.intent.slice(0, 40)
  validateDefinition({ version: 1, entry: node }, { allowBuildPlaceholder: true })
  return node
}

/**
 * 校验每个构建占位声明的 layers（含自身的剩余层数）。
 * 规则：必须是 1..parentLayers-1 的整数；parentLayers=1 时禁止再出现占位。
 * 这样层数在构建期就静态收敛，不依赖运行时输入，避免无限往深处创会话。
 */
export function assertPlaceholderLayers(placeholders, parentLayers, path = '') {
  const where = path ? `${path} ` : ''
  if (parentLayers <= 1) {
    throw new Error(`${where}当前层已是最后一层（layers=1），不能再保留 subflow.build 占位；请在本层直接实现`)
  }
  for (const item of placeholders) {
    const layers = item.build?.layers
    if (!Number.isInteger(layers) || layers < 1) {
      throw new Error(`${where}占位 ${item.node_id} 的 build.layers 必须是 1..${parentLayers - 1} 的整数（含自身的剩余层数）`)
    }
    if (layers >= parentLayers) {
      throw new Error(`${where}占位 ${item.node_id} 的 build.layers=${layers} 必须小于当前层 layers=${parentLayers}，否则层数不会收敛`)
    }
  }
}

function interpretResult(parsed, sire, limits, state) {
  if (!isObject(parsed)) throw new Error(`${sire.path} 构建结果必须是对象`)
  const decision = String(parsed.decision || '').trim()
  const complexity = Number.isInteger(Number(parsed.complexity))
    ? Math.min(5, Math.max(1, Number(parsed.complexity)))
    : null
  if (decision === 'implement') {
    const node = normalizeIrNode(parsed.node, sire)
    const selfPlaceholder = node.type === 'subflow'
      && node.build !== undefined && node.definition === undefined && node.ref === undefined
    if (selfPlaceholder) {
      throw new Error(`${sire.path} 的 implement 结果不能只是把当前节点再包一层 build 占位；请直接实现当前层，只有更深层才使用占位`)
    }
    const placeholders = collectBuildPlaceholders({ version: 1, entry: node })
    if (placeholders.length) {
      if (placeholders.some(item => item.node_id === sire.id)) {
        throw new Error(`${sire.path} 的占位 id 不能与当前节点 id（${sire.id}）相同，避免把当前层递归成自己`)
      }
      assertPlaceholderLayers(placeholders, buildLayersOf(state), sire.path)
      if (sire.depth + 1 > limits.max_depth) {
        throw new Error(`${sire.path} 已达构建深度上限 ${limits.max_depth}，不能再保留 subflow.build 占位`)
      }
      if (countNodes(state) + placeholders.length > limits.max_nodes) {
        throw new Error(`构建节点数超过上限 ${limits.max_nodes}（RMS_FLOW_BUILD_MAX_NODES）`)
      }
    }
    return { decision, complexity, node }
  }
  if (decision === 'decompose') {
    if (sire.depth >= limits.max_depth) {
      throw new Error(`${sire.path} 已达构建深度上限 ${limits.max_depth}，不能继续拆解`)
    }
    return { decision, complexity, children: normalizeChildren(parsed.children, sire.path, sire.depth, limits.max_depth) }
  }
  if (decision === 'need_human') {
    const question = String(parsed.question || '').trim()
    if (!question) throw new Error(`${sire.path} need_human 缺少 question`)
    const suggested = String(parsed.suggested_zoom || '').trim()
    return {
      decision,
      question,
      options: (Array.isArray(parsed.options) ? parsed.options : []).map(String).filter(Boolean).slice(0, 6),
      suggested_zoom: ['in', 'out'].includes(suggested) ? suggested : null,
      reason: String(parsed.reason || '').trim(),
    }
  }
  throw new Error(`${sire.path} 不支持的 decision：${decision || '空'}`)
}

async function completeSession({ system, payload, workspace, cwd, runner, prompt, sessionId, parentSessionId }, dependencies) {
  const agent = runner || dependencies.agentRunner
  if (typeof agent === 'function') {
    const response = await agent({
      system,
      prompt: prompt || '按系统要求只输出 JSON，不要执行任务。',
      input: payload,
      workspace: workspace || undefined,
      cwd: cwd || undefined,
      sessionId,
      parentSessionId,
    })
    return {
      content: response?.text ?? response?.content ?? response,
      session: isObject(response) ? response : null,
    }
  }
  const { createLlmExecutor } = await import('./llm.mjs')
  const llm = dependencies.llm || createLlmExecutor()
  return {
    content: (await llm.complete({ system, user: JSON.stringify(payload, null, 2) })).content,
    session: null,
  }
}

function makeSessionTrace({ path, nodeId, decision, status, attempt, completion, requestedSessionId, parentSessionId, workspace, workspaceId, complexity, error }) {
  const session = completion?.session
  return {
    path,
    node_id: nodeId,
    decision,
    status,
    attempt,
    ...(complexity !== undefined ? { complexity } : {}),
    session_id: session?.session_id || null,
    requested_session_id: requestedSessionId || null,
    parent_session_id: session?.parent_session_id || parentSessionId || null,
    workspace: session?.workspace || workspace || null,
    workspace_id: session?.workspace_id || workspaceId || null,
    mode: session?.mode || null,
    ...(error ? { error } : {}),
    at: new Date().toISOString(),
  }
}

function nodePayload(state, sire) {
  const parent = parentOf(state.root, sire.path)
  return {
    task: state.task,
    workflow_name: state.name,
    node: {
      path: sire.path,
      id: sire.id,
      role: sire.role,
      intent: sire.intent,
      description: sire.description,
      inputs: sire.inputs,
      outputs: sire.outputs,
      complexity: sire.complexity,
      zoom: sire.zoom,
      angle: sire.angle,
      scope: sire.scope,
      guidance: sire.guidance.slice(-3),
    },
    parent: parent ? { id: parent.id, intent: parent.intent, inputs: parent.inputs, outputs: parent.outputs } : null,
    siblings: siblingsOf(state.root, sire.path).map(item => ({ id: item.id, intent: item.intent, role: item.role })),
    limits: {
      complexity_max: state.limits.complexity_max,
      max_depth: state.limits.max_depth,
      depth: sire.depth,
      remaining_depth: state.limits.max_depth - sire.depth,
      remaining_nodes: state.limits.max_nodes - countNodes(state),
      layers: buildLayersOf(state),
    },
    context: state.context || null,
    mailbox: (state.mailbox || []).slice(-5),
    output_contract: OUTPUT_CONTRACT,
  }
}

export const HANDOFF_TAG = '【构建交接契约（系统生成）】'

/**
 * 把层数预算与终止条件写成交接需求的一部分：数值形态固定为具体整数，
 * 避免父子会话之间把“剩余层数”当成运行时变量继续外推、导致层数失控。
 */
export function handoffTask(task, layers) {
  const text = String(task || '').trim()
  if (text.includes(HANDOFF_TAG)) return text
  const budget = Number.isInteger(layers) && layers >= 1 ? layers : buildLayerBudget()
  const next = Math.max(0, budget - 1)
  const rule = budget === 1
    ? '- 终止条件（本层已触发）：layers = 1，本层就是叶子层，必须在本层直接实现完整可执行 IR，禁止再出现 subflow.build 占位，按任务要求直接返回结果（例如返回 1）。'
    : `- 递进规则：本层最多留 1 个 subflow.build 占位，其 build.layers 必须写具体整数 ${next}（= 当前预算 ${budget} - 1）；不得写成变量、表达式或“剩余层数”。`
  return `${text}
${HANDOFF_TAG}
- 当前层预算 layers = ${budget}。取值来源：本次请求的 limits.layers / context.layers，是具体整数，不是运行时变量，也不能由输入推导。
- 含义：包含本层在内，向下最多还能展开 ${budget} 层。总层数口径在根层一次定死，每层沿用同一口径，不要重新解释“嵌套 N 层”。
${rule}
- 值形态：写占位时 build.layers 直接写整数；禁止 {"var":...}、模板字符串、“剩余的层数再减一”等运行时表述。
- 交接保真：给下一层写 build.task 时，必须原样保留任务正文的目标、业务规则、层数口径与终止行为，并把“下一层预算 = ${next}”写成具体整数；不得压缩、改写或外推。
- 任务正文与本节冲突时，层数与终止行为以本节的具体数字为准。`
}

export async function createBuildState(args, dependencies = {}) {
  const task = String(args.task || '').trim()
  if (!task) throw new Error('task 不能为空')
  const buildId = `build-${randomUUID().slice(0, 8)}`
  const limits = args.limits || buildLimits()
  const sessions = []
  const system = `${SKELETON_MARKER}
${SKELETON_GUIDE}
${IR_GUIDE}`
  const payload = {
    task,
    workspace: args.workspace || null,
    revision: args.revision || null,
    previous_definition: args.previous_definition || null,
    context: args.context || null,
    mailbox: (args.mailbox || []).slice(-5),
    limits,
    output_contract: { name: 'string', summary: 'string', inputs: '可选对象', input: '可选对象', children: '[SIR 节点]' },
  }
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestedSessionId = `${buildId}-skeleton-${attempt + 1}`
    let completion = null
    try {
      completion = await completeSession({
        system,
        payload,
        workspace: args.workspace,
        sessionId: requestedSessionId,
        parentSessionId: args.dsh_session_id || null,
      }, dependencies)
      const parsed = parseJson(completion.content)
      if (!isObject(parsed)) throw new Error('骨架结果必须是对象')
      const children = normalizeChildren(parsed.children, '', 0, limits.max_depth, 8)
      const name = String(parsed.name || '').trim() || task.slice(0, 48)
      const inputs = normalizeContract(parsed.inputs)
      const root = {
        id: 'root',
        path: '',
        depth: 0,
        role: 'group',
        intent: task,
        description: '',
        inputs,
        outputs: null,
        complexity: null,
        status: 'decomposed',
        zoom: 'normal',
        angle: null,
        scope: null,
        guidance: [],
        ir: null,
        children,
      }
      sessions.push(makeSessionTrace({
        path: 'root', nodeId: 'root', decision: 'skeleton', status: 'completed', attempt: attempt + 1,
        completion, requestedSessionId, parentSessionId: args.dsh_session_id,
        workspace: args.workspace, workspaceId: args.workspace_id,
      }))
      return {
        version: 1,
        id: buildId,
        session_id: String(args.session_id),
        origin: args.origin || null,
        context: args.context || null,
        mailbox: (args.mailbox || []).slice(-5),
        mail_reply_to: args.mail_reply_to || null,
        workspace: args.workspace || null,
        workspace_id: args.workspace_id || null,
        dsh_session_id: args.dsh_session_id || null,
        task,
        name,
        summary: String(parsed.summary || '').trim(),
        limits,
        // 子会话与父会话一样先停在 DAG 确认：骨架生成后等人工确认再开始预构建
        status: args.pause_after_skeleton ? 'awaiting_dag' : 'building',
        inputs,
        input: hasOwn(parsed, 'input') ? clone(parsed.input) : null,
        root,
        queue: children.map(node => node.path),
        current_node: null,
        sessions,
        human: null,
        human_mail_id: null,
        history: [],
        definition: null,
        run_id: null,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error)
      sessions.push(makeSessionTrace({
        path: 'root', nodeId: 'root', decision: 'skeleton', status: 'failed', attempt: attempt + 1,
        completion, requestedSessionId, parentSessionId: args.dsh_session_id,
        workspace: args.workspace, workspaceId: args.workspace_id, error: lastError,
      }))
      payload.repair_instruction = `上次输出未通过校验：${lastError}。请修复后只返回完整 JSON。`
    }
  }
  throw new Error(`骨架拆解失败：${lastError}`)
}

export function findBuildNode(state, { path, node_id } = {}) {
  if (path) {
    const node = nodeByPath(state.root, path)
    if (node) return node
  }
  if (node_id) {
    const node = allNodes(state.root).find(item => item.id === node_id)
    if (node) return node
  }
  if (state.human?.path) {
    const node = nodeByPath(state.root, state.human.path)
    if (node) return node
  }
  const last = [...(state.sessions || [])].reverse().find(item => item.path && item.path !== 'root')
  return last ? nodeByPath(state.root, last.path) : null
}

export function nextBuildTarget(state) {
  while (state.queue.length) {
    const path = state.queue.shift()
    const node = nodeByPath(state.root, path)
    if (node && node.status === 'pending') return node
  }
  return null
}

const execFileAsync = promisify(execFile)

async function preflightNode(node) {
  if (node?.type !== 'script' || node.runtime !== 'node') return
  const dir = await mkdtemp(join(tmpdir(), 'rms-flow-build-check-'))
  const file = join(dir, 'main.mjs')
  try {
    await writeFile(file, node.code, 'utf8')
    await execFileAsync(process.execPath, ['--check', file], { timeout: 15000 })
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim()
    throw new Error(`script 节点 ${node.id} 语法预检失败：${detail.slice(0, 1200)}`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// 每个节点会话使用独立工作目录：同棵树的其它节点产物不可见，节点间只通过 Cin/Cout 契约交互
async function nodeWorkspace(state, sire) {
  if (!state.workspace) return null
  const safeId = String(sire.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'node'
  const tag = createHash('sha1').update(`${sire.path}:${sire.id}`).digest('hex').slice(0, 8)
  const dir = join(state.workspace, '.flow-nodes', `${safeId}-${tag}`)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function runNodeSession(state, sire, dependencies = {}) {
  const forceImplement = sire.depth >= state.limits.max_depth
  const coding = typeof dependencies.codingAgentRunner === 'function'
  const system = `${NODE_MARKER}
${coding ? NODE_CODING_GUIDE : NODE_GUIDE}
${forceImplement ? '当前节点已达到最大构建深度，本次只能返回 decision:"implement"，且 IR 中不能再保留 subflow.build 占位。' : NODE_PLACEHOLDER_GUIDE}
${IR_GUIDE}`
  const payload = nodePayload(state, sire)
  if (forceImplement) payload.force_implement = true
  const nodeCwd = await nodeWorkspace(state, sire)
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestedSessionId = `${state.id}-node-${sire.id}-${state.sessions.length + 1}`
    let completion = null
    try {
      completion = await completeSession({
        system,
        payload,
        workspace: state.workspace,
        cwd: nodeCwd || undefined,
        runner: coding ? dependencies.codingAgentRunner : dependencies.agentRunner,
        prompt: coding
          ? '请在工作区完成该节点的真实编码和验证。最终只输出要求的 JSON IR，不要输出执行日志。'
          : undefined,
        sessionId: requestedSessionId,
        parentSessionId: state.dsh_session_id || null,
      }, dependencies)
      const parsed = parseJson(completion.content)
      const result = interpretResult(parsed, sire, state.limits, state)
      if (forceImplement && result.decision === 'decompose') {
        throw new Error(`${sire.path} 已到深度上限，必须 implement`)
      }
      if (result.decision === 'implement') await preflightNode(result.node)
      state.sessions.push(makeSessionTrace({
        path: sire.path, nodeId: sire.id, decision: result.decision, status: 'completed', attempt: attempt + 1,
        completion, requestedSessionId, parentSessionId: state.dsh_session_id,
        workspace: state.workspace, workspaceId: state.workspace_id, complexity: result.complexity ?? sire.complexity,
      }))
      return result
    } catch (error) {
      lastError = error && error.message ? error.message : String(error)
      state.sessions.push(makeSessionTrace({
        path: sire.path, nodeId: sire.id, decision: 'node', status: 'failed', attempt: attempt + 1,
        completion, requestedSessionId, parentSessionId: state.dsh_session_id,
        workspace: state.workspace, workspaceId: state.workspace_id, error: lastError,
      }))
      payload.repair_instruction = `上次输出未通过校验：${lastError}。请修复后只返回完整 JSON。`
    }
  }
  throw new Error(`节点构建失败（${sire.path}）：${lastError}`)
}

function definitionNode(definition, nodeId) {
  let found = null
  const visit = node => {
    if (!node || found) return
    if (node.id === nodeId) {
      found = node
      return
    }
    if (node.type === 'sequence') (node.steps || []).forEach(visit)
    else if (node.type === 'branch') { visit(node.then); visit(node.else) }
    else if (node.type === 'fold' || node.type === 'loop') visit(node.body)
    else if (node.type === 'or_else') { visit(node.primary); visit(node.fallback) }
  }
  visit(definition?.entry)
  return found
}

function replaceDefinitionNode(definition, nodeId, replacement) {
  let replaced = false
  const visit = node => {
    if (!node) return node
    if (node.id === nodeId) {
      replaced = true
      return clone(replacement)
    }
    const next = { ...node }
    if (node.type === 'sequence') next.steps = (node.steps || []).map(visit)
    else if (node.type === 'branch') {
      next.then = visit(node.then)
      next.else = visit(node.else)
    } else if (node.type === 'fold' || node.type === 'loop') next.body = visit(node.body)
    else if (node.type === 'or_else') {
      next.primary = visit(node.primary)
      next.fallback = visit(node.fallback)
    }
    return next
  }
  const next = { ...clone(definition), entry: visit(definition.entry) }
  if (!replaced) throw new Error(`找不到失败节点 ${nodeId}，无法局部修复`)
  validateDefinition(next)
  return next
}

/** 将一次运行失败回灌给节点修复会话，只替换失败节点的 IR。 */
export async function repairFailedNode(args, dependencies = {}) {
  const original = definitionNode(args.definition, args.node_id)
  if (!original) throw new Error(`找不到失败节点 ${args.node_id}，无法局部修复`)
  const system = `工作流节点修复器
你只修复一个失败节点，不重新规划整个工作流。根据错误、节点 Cin 和原 IR 生成可直接执行的替换节点。
只输出 {"node":完整 IR 节点} 的合法 JSON；node.id 必须保持为 ${args.node_id}，不要改变其他节点。
优先做最小修复。node 脚本使用 .mjs 时是 ESM，不能使用 require；需要模块时请使用 import 或动态 import。
${IR_GUIDE}`
  const payload = {
    task: '修复运行失败节点并输出局部替换 IR',
    node_id: args.node_id,
    path: args.path || null,
    node: original,
    cin: args.input === undefined ? null : args.input,
    error: args.error || null,
    attempt: args.attempt || 1,
    workspace: args.workspace || null,
    output_contract: { node: '完整替换节点，id 不变' },
  }
  const runner = dependencies.codingAgentRunner || dependencies.agentRunner
  const completion = await completeSession({
    system,
    payload,
    workspace: args.workspace,
    runner,
    prompt: runner === dependencies.codingAgentRunner
      ? '请分析失败原因；如需验证可在给定工作区写临时脚本并运行。修复后只输出完整替换节点 JSON。'
      : undefined,
    sessionId: args.sessionId,
    parentSessionId: args.parentSessionId || null,
  }, dependencies)
  const parsed = parseJson(completion.content)
  if (!isObject(parsed) || !isObject(parsed.node)) throw new Error('修复结果缺少 node')
  const replacement = clone(parsed.node)
  replacement.id = original.id
  if (!replacement.label) replacement.label = original.label || original.id
  validateDefinition({ version: 1, entry: replacement })
  return {
    definition: replaceDefinitionNode(args.definition, args.node_id, replacement),
    node: replacement,
    session: makeSessionTrace({
      path: args.path || null, nodeId: args.node_id, decision: 'repair', status: 'completed',
      attempt: args.attempt || 1, completion, requestedSessionId: args.sessionId,
      parentSessionId: args.parentSessionId, workspace: args.workspace, workspaceId: args.workspace_id,
    }),
  }
}

export function applyBuildResult(state, sire, result) {
  if (result.decision === 'implement') {
    const placeholders = collectBuildPlaceholders({ version: 1, entry: result.node })
    sire.ir = result.node
    if (result.complexity) sire.complexity = result.complexity
    if (placeholders.length) {
      // 嵌套占位不在构建内递归：节点挂起等待，由共享构建栈逐个开独立子会话构建后回填
      sire.status = 'waiting_children'
      sire.pending_children = placeholders.map(item => ({
        node_id: item.node_id,
        label: item.label,
        task: item.build.task,
        build: clone(item.build),
        status: 'pending',
      }))
      return { kind: 'waiting_children', placeholders }
    }
    sire.status = 'implemented'
    return { kind: 'implemented' }
  }
  if (result.decision === 'decompose') {
    if (countNodes(state) + result.children.length > state.limits.max_nodes) {
      throw new Error(`构建节点数超过上限 ${state.limits.max_nodes}（RMS_FLOW_BUILD_MAX_NODES）`)
    }
    sire.role = 'group'
    sire.status = 'decomposed'
    sire.children = result.children
    if (result.complexity) sire.complexity = result.complexity
    state.queue = [...result.children.map(node => node.path), ...state.queue]
    return { kind: 'decomposed', children: result.children.length }
  }
  sire.status = 'waiting_human'
  state.human = {
    request_id: `req-${randomUUID().slice(0, 8)}`,
    path: sire.path,
    node_id: sire.id,
    question: result.question,
    options: result.options,
    suggested_zoom: result.suggested_zoom,
    reason: result.reason,
    created_at: new Date().toISOString(),
  }
  return {
    kind: 'need_human',
    request: state.human,
  }
}

export function backfillBuildChild(state, parentPath, placeholderNodeId, definition) {
  const node = parentPath ? nodeByPath(state.root, parentPath) : state.root
  if (!node) throw new Error(`父节点不存在：${parentPath || 'root'}`)
  const pending = node.pending_children || []
  const child = pending.find(item => item.node_id === placeholderNodeId && item.status !== 'done')
  if (!child) throw new Error(`父节点 ${node.path || 'root'} 没有等待构建的占位：${placeholderNodeId}`)
  const replaced = replaceBuildPlaceholder({ version: 1, entry: node.ir }, placeholderNodeId, definition)
  node.ir = replaced.entry
  child.status = 'done'
  if (pending.every(item => item.status === 'done')) {
    node.status = 'implemented'
    node.pending_children = []
  }
  const waiting = allNodes(state.root).some(item => item.status === 'waiting_children')
  if (!waiting && state.status === 'waiting_children') state.status = 'building'
  return node
}

export function pendingChildPlaceholders(state) {
  const found = []
  for (const node of allNodes(state.root)) {
    for (const child of node.pending_children || []) {
      if (child.status === 'done') continue
      found.push({ parent_path: node.path, parent_id: node.id, ...child })
    }
  }
  return found
}

export function resetNodeForRebuild(state, sire, action) {
  const zoom = action.action === 'zoom_in' ? 'in' : action.action === 'zoom_out' ? 'out' : null
  if (zoom) sire.zoom = zoom
  if (action.angle) sire.angle = String(action.angle).trim()
  if (action.scope) sire.scope = String(action.scope).trim()
  const note = String(action.answer || '').trim()
  if (note) sire.guidance.push({ note, angle: sire.angle, scope: sire.scope, action: action.action, at: new Date().toISOString() })
  sire.status = 'pending'
  sire.ir = null
  sire.children = []
  sire.pending_children = []
  state.queue = state.queue.filter(path => path !== sire.path && !path.startsWith(`${sire.path}/`))
  state.queue.unshift(sire.path)
  state.human = null
  state.human_mail_id = null
  state.status = 'building'
  state.history.push({
    path: sire.path,
    action: action.action,
    answer: note || null,
    angle: sire.angle,
    scope: sire.scope,
    at: new Date().toISOString(),
  })
}

function compilePlaceholders(ir, node) {
  const children = node.children || []
  let index = 0
  const visit = value => {
    if (!isObject(value)) return value
    if (value.type === 'subflow' && value.build !== undefined && value.definition === undefined && value.ref === undefined) {
      const child = children[index]
      index += 1
      if (!child) throw new Error(`节点 ${node.path || 'root'} 的子流程占位 ${value.id} 尚未构建完成`)
      return compileNode(child)
    }
    const copy = { ...value }
    if (Array.isArray(value.steps)) copy.steps = value.steps.map(visit)
    if (isObject(value.then)) copy.then = visit(value.then)
    if (isObject(value.else)) copy.else = visit(value.else)
    if (isObject(value.body)) copy.body = visit(value.body)
    if (isObject(value.primary)) copy.primary = visit(value.primary)
    if (isObject(value.fallback)) copy.fallback = visit(value.fallback)
    if (isObject(value.definition?.entry)) copy.definition = { ...value.definition, entry: visit(value.definition.entry) }
    return copy
  }
  const compiled = visit(clone(ir))
  if (index !== children.length) {
    throw new Error(`节点 ${node.path || 'root'} 有 ${children.length} 个构建子节点，但 IR 中只有 ${index} 个占位`)
  }
  return compiled
}

function compileNode(node) {
  if (node.status === 'implemented') {
    return (node.children || []).length ? compilePlaceholders(node.ir, node) : clone(node.ir)
  }
  if (node.status === 'decomposed' && node.children.length) {
    const steps = node.children.map(compileNode)
    const entry = steps.length === 1 ? steps[0] : { id: `${node.id}_seq`, type: 'sequence', steps }
    const definition = { version: 1, entry }
    if (node.inputs) definition.inputs = clone(node.inputs)
    return { id: node.id, type: 'subflow', label: node.intent.slice(0, 40), definition }
  }
  throw new Error(`节点 ${node.path || 'root'} 尚未构建完成`)
}

export function compileBuildDefinition(state) {
  const steps = (state.root.children || []).map(compileNode)
  if (!steps.length) throw new Error('构建结果没有可执行节点')
  const entry = steps.length === 1 ? steps[0] : { id: 'root_seq', type: 'sequence', steps }
  const definition = { version: 1, name: state.name, fuel: 100, entry }
  if (state.inputs) definition.inputs = clone(state.inputs)
  validateDefinition(definition)
  if (state.input !== null && state.input !== undefined) validateInput(definition, state.input)
  return definition
}

export function buildProgress(state) {
  const nodes = allNodes(state.root).slice(1)
  const terminal = nodes.filter(node => ['implemented', 'decomposed'].includes(node.status)).length
  return {
    nodes: nodes.length,
    implemented: nodes.filter(node => node.status === 'implemented').length,
    decomposed: nodes.filter(node => node.status === 'decomposed').length,
    building: nodes.filter(node => node.status === 'building').length,
    waiting_children: nodes.filter(node => node.status === 'waiting_children').length,
    waiting_human: nodes.filter(node => node.status === 'waiting_human').length,
    failed: nodes.filter(node => node.status === 'failed').length,
    pending: nodes.filter(node => node.status === 'pending').length,
    completed: terminal,
    percent: nodes.length ? Math.round(terminal / nodes.length * 100) : 0,
    queued: state.queue.length,
    sessions: state.sessions.length,
  }
}

function publicTree(node) {
  return {
    path: node.path || 'root',
    id: node.id,
    role: node.role,
    intent: node.intent,
    status: node.status,
    complexity: node.complexity,
    zoom: node.zoom,
    angle: node.angle,
    scope: node.scope,
    guidance: node.guidance.slice(-3),
    ir: node.ir,
    pending_children: (node.pending_children || []).map(child => ({
      node_id: child.node_id,
      label: child.label,
      status: child.status,
    })),
    children: (node.children || []).map(publicTree),
  }
}

/**
 * 用骨架树合成只读 DAG：已实现节点直接用 node.ir；未实现节点按骨架里声明的 role
 * 渲染成对应类型的灰节点（script/llm/human/...），只有 group 才显示为待子构建的 subflow 占位，
 * 避免把“待实现的脚本节点”误显示成子流程。
 */
export function readonlyEntry(node) {
  if (!node) return null
  if (node.status === 'implemented' && node.ir) return clone(node.ir)
  if (node.children?.length) {
    const steps = node.children.map(readonlyEntry).filter(Boolean)
    if (steps.length === 1) return steps[0]
    if (steps.length) return { id: `${node.id}_seq`, type: 'sequence', steps }
  }
  const role = String(node.role || '').trim()
  return {
    id: node.id,
    type: role === 'group' ? 'subflow' : (role || 'subflow'),
    label: node.intent ? node.intent.slice(0, 40) : node.id,
    readonly: true,
    build_status: node.status,
    build: { task: node.intent, readonly: true },
  }
}

function readonlyDefinition(state) {
  const steps = (state.root.children || []).map(readonlyEntry).filter(Boolean)
  if (!steps.length) return null
  const entry = steps.length === 1 ? steps[0] : { id: 'root_seq', type: 'sequence', steps }
  return { version: 1, name: state.name, entry }
}

export function describeBuild(state) {
  return {
    build_id: state.id,
    session_id: state.session_id,
    origin: state.origin || null,
    context: state.context || null,
    layers: buildLayersOf(state),
    mailbox: state.mailbox || [],
    status: state.status,
    name: state.name,
    task: state.task,
    summary: state.summary || '',
    workspace: state.workspace,
    workspace_id: state.workspace_id || null,
    dsh_session_id: state.dsh_session_id || null,
    limits: state.limits,
    progress: buildProgress(state),
    current_node: state.current_node || null,
    sessions: state.sessions || [],
    human: state.human,
    human_mail_id: state.human_mail_id || null,
    history: state.history,
    definition: ['awaiting_confirm', 'awaiting_accept', 'accepted'].includes(state.status) ? state.definition : null,
    readonly_definition: readonlyDefinition(state),
    run_id: state.run_id,
    error: state.error,
    tree: publicTree(state.root),
    created_at: state.created_at,
    updated_at: state.updated_at,
  }
}
