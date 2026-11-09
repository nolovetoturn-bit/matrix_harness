import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { runMatrix } from '../lib/matrix/execute.mjs'
import { deriveState, inputRouting, recomputeAfterChildAccept, stateAfterPrebuild, STATES } from '../lib/matrix/state.mjs'
import { nextUnaccepted, breadcrumb, treeView } from '../lib/matrix/nav.mjs'
import { normalizeSkeleton, compileSkeleton, assertNoCycle, createMatrixRecord, readonlyDefinition } from '../lib/matrix/schema.mjs'
import { validateDefinition } from '../lib/runner.mjs'
import { loadAll, loadMatrix, loadRun, listMatrices, listRuns, matrixWorkDir, nodeDir, resolveDataDir, saveMatrix, updateMatrix, withMatrixLock } from '../lib/matrix/store.mjs'
import { accept, answer, answerTicket, answerUserQuestion, cancel, chat, confirmDagAction, evaluate, generateDag, get, intake, list, mail, nav, prebuild, recordAction, reopenDag, resume, retry, reviseNodeAction, rewindPoints, rewindSession, run, runArtifacts, submitInput, supervise, tree } from '../lib/matrix/service.mjs'
import { closeQuestion, saveQuestion } from '../lib/matrix/questions.mjs'
import { skeletonContractIssues, validateSkeletonContracts } from '../lib/matrix/contracts.mjs'
import { dagViewOf } from '../lib/matrix/prebuild.mjs'
import { startPanel } from '../lib/panel.mjs'
import { ensureProjectsMigrated, listProjects, loadProject, projectDataDir, projectWorkDir, saveProject } from '../lib/project/store.mjs'
import { projectArchive, projectChat, projectCreate, projectGet, projectGit, projectList, projectMemory, projectNav, projectOpen, projectRunRunnable, projectSummary, projectTree, projectUpdate } from '../lib/project/service.mjs'
import { archiveMatrix, moveMatrix } from '../lib/project/service.mjs'
import { projectRepoDir } from '../lib/project/git.mjs'
import { domainCreate, domainElementRemove, domainElementUpsert, domainExportCreate, domainExportGet, domainExportList, domainGet, domainImportApply, domainImportList, domainImportRemove, domainImportUpgrade, domainList, domainMatrixIntake, domainMemory, domainUpdate } from '../lib/domain/service.mjs'
import { assertDomainSkeleton, domainContextOf } from '../lib/domain/policy.mjs'
import { exportFile } from '../lib/domain/registry.mjs'
import { createRuntime } from '../lib/engine/runtime.mjs'

const makeMatrix = (overrides = {}) => ({
  ...createMatrixRecord({ task: 't', name: 'n', id: overrides.id || 'mx_test01', ...overrides }),
  ...overrides,
})

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `matrix-${label}-`))
}

/** Windows 上被杀进程的目录句柄可能延迟释放，删除时短暂重试。 */
async function removeDir(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 19) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

// 本地 bridge：Node pipeline 通过 HTTP 回调原来的 fake llm/agent/tool/subflow 依赖。
const bridgeContexts = new Map()
let bridgeServer = null
let bridgeUrl = ''

function registerBridge(dataDir, deps) {
  bridgeContexts.set(dataDir, deps)
}

function bridgeContextFor(runId, token) {
  for (const [dataDir, deps] of bridgeContexts) {
    const tokenFile = join(dataDir, 'runs', runId, 'state', 'bridge-token')
    if (!existsSync(tokenFile)) continue
    try {
      if (readFileSync(tokenFile, 'utf8').trim() !== token) continue
    } catch {
      continue
    }
    return { dataDir, deps, runDir: join(dataDir, 'runs', runId) }
  }
  return null
}

async function bridgeHandler(kind, body, context) {
  if (kind === 'llm') {
    const llm = context.deps.llm
    if (!llm || typeof llm.complete !== 'function') throw new Error('LLM 执行器不可用')
    const response = await llm.complete({
      system: body.system || 'workflow llm node',
      user: JSON.stringify({ prompt: body.prompt || '', input: body.input ?? null }, null, 2),
    })
    return { text: String(response && response.content !== undefined ? response.content : ''), session_id: `${context.runId}-llm` }
  }
  if (kind === 'agent') {
    if (typeof context.deps.agentRunner === 'function') {
      const response = await context.deps.agentRunner({
        system: body.system,
        prompt: body.prompt,
        input: body.input,
      })
      return { text: String(response && (response.text ?? response.content) || '') }
    }
    return bridgeHandler('llm', body, context)
  }
  if (kind === 'tool') {
    if (typeof context.deps.toolRunner !== 'function') throw new Error('toolRunner 不可用')
    const result = await context.deps.toolRunner({ name: body.tool, args: body.args, input: body.input })
    return result && typeof result === 'object' && 'value' in result ? result : { value: result }
  }
  if (kind === 'subflow') {
    if (!body.matrix_id) throw new Error('subflow inline definition 暂不支持')
    const parentRun = body.parent_run_id ? loadRun(context.dataDir, body.parent_run_id) : null
    return runMatrix(context.dataDir, body.matrix_id, {
      input: body.input,
      dependencies: context.deps,
      parentRun,
      parentNode: parentRun ? { id: body.node_id } : null,
      parentPath: body.path || null,
    })
  }
  throw new Error(`未知 bridge 类型：${kind}`)
}

before(async () => {
  bridgeServer = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }
    if (request.method !== 'POST') {
      send(404, { error: { code: 'BRIDGE_NOT_FOUND', message: 'Not Found' } })
      return
    }
    const match = String(request.url || '').match(/^\/api\/runs\/(run-[A-Za-z0-9_-]+)\/bridge\/(llm|agent|tool|subflow)$/)
    if (!match) {
      send(404, { error: { code: 'BRIDGE_NOT_FOUND', message: 'Not Found' } })
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let body = {}
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    } catch {
      send(400, { error: { code: 'BRIDGE_BAD_REQUEST', message: 'body 不是合法 JSON' } })
      return
    }
    const context = bridgeContextFor(match[1], String(request.headers['x-rms-run-token'] || ''))
    if (!context) {
      send(401, { error: { code: 'BRIDGE_UNAUTHORIZED', message: 'bridge token 校验失败' } })
      return
    }
    try {
      send(200, await bridgeHandler(match[2], body, { ...context, runId: match[1] }))
    } catch (error) {
      send(400, { error: { code: error.code || 'BRIDGE_FAILED', message: error.message || String(error) } })
    }
  })
  await new Promise((resolveListen, reject) => {
    bridgeServer.on('error', reject)
    bridgeServer.listen(0, '127.0.0.1', resolveListen)
  })
  bridgeUrl = `http://127.0.0.1:${bridgeServer.address().port}`
  process.env.RMS_BRIDGE_URL = bridgeUrl
})

after(async () => {
  if (bridgeServer) await new Promise(done => bridgeServer.close(done))
  delete process.env.RMS_BRIDGE_URL
})

function analysisResponse(sufficient, questions = []) {
  return JSON.stringify({ sufficient, missing: [], questions, assumptions: [], summary: sufficient ? '信息足够' : '需要澄清' })
}

const PARENT_SKELETON = {
  summary: '父流程拆成数据收集与一个独立子流程',
  skeleton: {
    entry: {
      id: 'root',
      label: '父流程',
      intent: '完成父任务',
      inputs: { query: 'string' },
      children: [
        {
          id: 'collect',
          type: 'script',
          label: '收集数据',
          intent: '产出初始数据',
          inputs: { query: 'string' },
          outputs: { rows: 'array' },
          complexity: 1,
        },
        {
          id: 'childflow',
          type: 'group',
          label: '独立子流程',
          intent: '独立交付的子流程',
          inputs: { rows: 'array' },
          outputs: { report: 'object' },
          complexity: 4,
        },
      ],
    },
  },
  acceptance_criteria: ['产出数据'],
  assumptions: [],
}

const CHILD_SKELETON = {
  summary: '子流程只含一个实现节点',
  skeleton: {
    entry: {
      id: 'root',
      label: '子流程',
      intent: '完成子任务',
      inputs: { rows: 'array' },
      children: [{
        id: 'substep',
        type: 'script',
        label: '子步骤',
        intent: '返回结果',
        inputs: { rows: 'array' },
        outputs: { result: 'object' },
        complexity: 1,
      }],
    },
  },
  acceptance_criteria: ['返回结果'],
  assumptions: [],
}

/** 离线伪 LLM：按提示词类型分派，覆盖需求分析/骨架/节点实现/验收。 */
function fakeLlm(state) {
  return {
    async complete({ system, user }) {
      state.systems.push(system)
      if (system.includes('需求分析员')) {
        state.analysisCalls += 1
        const sufficient = state.clarify ? state.analysisCalls > 1 : true
        return { content: analysisResponse(sufficient, sufficient ? [] : ['请补充目标']) }
      }
      if (system.includes('规划骨架')) {
        const payload = JSON.parse(user)
        return { content: JSON.stringify(payload.task.includes('【父 matrix】') ? CHILD_SKELETON : PARENT_SKELETON) }
      }
      if (system.includes('真实编码与验证')) {
        const payload = JSON.parse(user)
        state.implCalls += 1
        if (state.failFirst && state.implCalls === 1) throw new Error('模拟节点实现失败')
        // 按 DAG 锁定的类型返回实现；脚本输出固定 JSON，便于端到端断言
        const output = JSON.stringify({ node: payload.node.id })
        return {
          content: JSON.stringify({
            node: {
              id: payload.node.id,
              type: payload.node.type,
              runtime: 'node',
              code: `process.stdout.write(${JSON.stringify(output)})`,
            },
          }),
        }
      }
      if (system.includes('验收评估员')) {
        return { content: JSON.stringify({ passed: true, gaps: [], evidence: ['trace ok'], recommend: 'accept' }) }
      }
      if (system.includes('监督分析员')) {
        return { content: JSON.stringify({ conclusion: '运行正常，无阻塞', suggestions: ['保持现有骨架'], risks: [] }) }
      }
      throw new Error(`未预期的 LLM 调用：${system.slice(0, 30)}`)
    },
  }
}

function makeDeps(overrides = {}) {
  const state = { analysisCalls: 0, implCalls: 0, clarify: false, failFirst: false, systems: [] }
  return { deps: { llm: fakeLlm(state), ...overrides }, state }
}

test('P0 状态机：门禁态与非法转移', () => {
  const matrix = makeMatrix({ state: STATES.AWAITING_PREBUILD, prebuild_done: false })
  const empty = new Map([[matrix.id, matrix]])
  assert.equal(deriveState(matrix, empty), STATES.AWAITING_PREBUILD)
  // 未预构建完成，即使没有子矩阵也不能运行
  assert.equal(stateAfterPrebuild(matrix, empty), STATES.AWAITING_PREBUILD)
  assert.equal(inputRouting(STATES.CLARIFYING).target, 'answer')
  assert.equal(inputRouting(STATES.AWAITING_DAG).target, 'revise')

  const accepted = makeMatrix({ id: 'mx_parent01', prebuild_done: true })
  const child = makeMatrix({ id: 'mx_child01', parent_id: accepted.id, state: STATES.ACCEPTED })
  accepted.children = [{ node_id: 'g', node_path: 'entry/g', matrix_id: child.id }]
  const matrices = new Map([[accepted.id, accepted], [child.id, child]])
  assert.equal(deriveState(accepted, matrices), STATES.RUNNABLE)
  assert.equal(canAcceptThrough(accepted, matrices), true)

  child.state = STATES.RUNNABLE
  assert.equal(deriveState(accepted, matrices), STATES.AWAITING_CHILDREN)
  assert.equal(recomputeAfterChildAccept(accepted, matrices), false)
  child.state = STATES.ACCEPTED
  assert.equal(recomputeAfterChildAccept(accepted, matrices), true)
  assert.equal(accepted.state, STATES.RUNNABLE)
})

function canAcceptThrough(matrix, matrices) {
  const state = deriveState(matrix, matrices)
  return state === STATES.RUNNABLE
}

test('P0 骨架：归一化、校验与编译', () => {
  const skeleton = normalizeSkeleton(PARENT_SKELETON.skeleton)
  assert.equal(skeleton.entry.children.length, 2)
  assert.equal(skeleton.entry.children[0].type, 'script')
  assert.equal(skeleton.entry.children[1].type, 'group')
  assert.deepEqual(skeleton.entry.children[1].inputs, { rows: 'array' })
  assert.throws(() => normalizeSkeleton({ entry: { id: 'root', intent: 'x', children: [{ id: 'bad id', type: 'script', intent: 'x', inputs: {}, outputs: {} }] } }), /ASCII/)
  assert.throws(() => normalizeSkeleton({ entry: { id: 'root', intent: 'x', children: [{ id: 'a', type: 'step', intent: 'x', inputs: {}, outputs: {} }] } }), /type/)
  assert.throws(() => normalizeSkeleton({ entry: { id: 'root', intent: 'x', children: [{ id: 'a', type: 'script', intent: 'x', outputs: { x: 'string' } }] } }), /inputs/)
  assert.throws(() => normalizeSkeleton({ entry: { id: 'root', intent: 'x', children: [{ id: 'a', type: 'script', intent: 'x', inputs: { x: 'string' }, outputs: { y: 'string' }, children: [{ id: 'b' }] }] } }), /children/)

  const definition = compileSkeleton(skeleton, {
    implementations: {
      'entry/collect': { id: 'collect', type: 'script', runtime: 'node', code: 'process.stdout.write("{}")' },
    },
    childRefs: { childflow: { node_id: 'childflow', node_path: 'entry/childflow', matrix_id: 'mx_child02' } },
  })
  assert.equal(definition.entry.type, 'sequence')
  assert.equal(definition.entry.steps[1].matrix_id, 'mx_child02')
})

test('P0 导航：最深最左未验收与父链回退', () => {
  const root = makeMatrix({ id: 'mx_root01', state: STATES.AWAITING_CHILDREN, prebuild_done: true })
  const a = makeMatrix({ id: 'mx_a01', parent_id: root.id, state: STATES.ACCEPTED, prebuild_done: true })
  const a1 = makeMatrix({ id: 'mx_a1', parent_id: a.id, state: STATES.ACCEPTED })
  const b = makeMatrix({ id: 'mx_b01', parent_id: root.id, state: STATES.BUILDING, prebuild_done: true })
  const b1 = makeMatrix({ id: 'mx_b1', parent_id: b.id, state: STATES.RUNNABLE })
  const b2 = makeMatrix({ id: 'mx_b2', parent_id: b.id, state: STATES.AWAITING_DAG })
  root.children = [
    { node_id: 'a', node_path: 'entry/a', matrix_id: a.id },
    { node_id: 'b', node_path: 'entry/b', matrix_id: b.id },
  ]
  a.children = [{ node_id: 'a1', node_path: 'entry/a1', matrix_id: a1.id }]
  b.children = [
    { node_id: 'b1', node_path: 'entry/b1', matrix_id: b1.id },
    { node_id: 'b2', node_path: 'entry/b2', matrix_id: b2.id },
  ]
  const matrices = new Map([root, a, a1, b, b1, b2].map(m => [m.id, m]))

  assert.equal(nextUnaccepted({ currentId: root.id, matrices }).id, b1.id)
  // 已验收子树整体跳过，沿父链找兄弟分支
  assert.equal(nextUnaccepted({ currentId: a1.id, matrices }).id, b1.id)
  assert.equal(nextUnaccepted({ currentId: b1.id, matrices }).id, b2.id)
  assert.deepEqual(breadcrumb(b2.id, matrices).map(item => item.id), [root.id, b.id, b2.id])
  const view = treeView(root.id, matrices)
  assert.equal(view.children.length, 2)
  assert.equal(view.children_accepted, 1)
})

test('P1 存储：原子读写、matrix 前缀与环检测', async () => {
  const dir = tempDir('store')
  try {
    assert.ok(resolveDataDir(dir).includes('matrix-store'))
    const matrix = makeMatrix({ id: 'mx_store01' })
    saveMatrix(dir, matrix)
    assert.equal(loadMatrix(dir, matrix.id).task, 't')
    assert.equal(listMatrices(dir).length, 1)
    assert.equal(loadAll(dir).size, 1)
    assert.equal(nodeDir(matrixWorkDir(dir, matrix.id), 'entry/collect'), join(matrixWorkDir(dir, matrix.id), '.nodes', 'collect'))
    await updateMatrix(dir, matrix.id, current => { current.name = '改名' })
    assert.equal(loadMatrix(dir, matrix.id).name, '改名')
    await withMatrixLock(dir, matrix.id, async () => {})

    const parent = makeMatrix({ id: 'mx_cycle01' })
    const child = makeMatrix({ id: 'mx_cycle02', parent_id: parent.id })
    parent.parent_id = child.id
    assert.throws(() => assertNoCycle(new Map([[parent.id, parent], [child.id, child]]), parent.id), /环/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 受理：澄清 → 回答 → 待生成 DAG', async () => {
  const dir = tempDir('clarify')
  const state = { analysisCalls: 0, implCalls: 0, clarify: true, failFirst: false, systems: [] }
  const deps = { llm: fakeLlm(state) }
  try {
    const created = await intake({ data_dir: dir, task: '需要澄清的任务' }, deps)
    assert.equal(created.state, STATES.CLARIFYING)
    // 输入统一交给绑定 agent，状态对应的确定性路由保留在 state_target
    assert.equal(created.routing.target, 'agent')
    assert.equal(created.routing.state_target, 'answer')
    assert.ok(created.messages.some(message => message.kind === 'chat'))
    assert.ok(created.messages.some(message => message.kind === 'agent'))

    const answered = await answer({ data_dir: dir, matrix_id: created.id, answer: '目标是产出报告' }, deps)
    assert.equal(answered.state, STATES.AWAITING_REQUIREMENT)
    assert.equal(answered.clarifications.length, 1)
    // 移植旧版角色提示词：需求分析必须锚定本平台，不得追问外部技术栈
    assert.ok(state.systems.some(system => system.includes('rms-flow-runner-v2') && system.includes('不要问')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2-P5 端到端：DAG → 预构建（创建子 matrix）→ 子验收 → 父可运行 → 运行/验收/评估', async () => {
  const dir = tempDir('e2e')
  const { deps, state } = makeDeps()
  registerBridge(dir, deps)
  try {
    const created = await intake({ data_dir: dir, task: '做一个父流程' }, deps)
    assert.equal(created.state, STATES.AWAITING_REQUIREMENT)

    const dag = await generateDag({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(dag.state, STATES.AWAITING_DAG)
    assert.equal(dag.skeleton.entry.children.length, 2)
    // DAG 确认阶段就应有只读定义：类型与 Cin/Cout 已锁定
    assert.ok(dag.dag, '生成 DAG 后必须立即产出只读 dag')
    assert.equal(dag.dag.nodes[0].type, 'script')
    assert.deepEqual(dag.dag.nodes[0].inputs, { query: 'string' })
    assert.equal(dag.dag.nodes[1].type, 'subflow')
    assert.equal(dag.dag.nodes[1].group, true)
    assert.equal(dag.definition, null, '未预构建前不能有可执行 definition')

    const confirmed = await confirmDagAction({ data_dir: dir, matrix_id: created.id })
    assert.equal(confirmed.state, STATES.AWAITING_PREBUILD)
    assert.ok(confirmed.dag_confirmed_at, '确认 DAG 应记录确认时间')

    const built = await prebuild({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(built.children.length, 1, 'group 节点应创建子 matrix')
    assert.equal(built.prebuild_done, true)
    assert.equal(built.definition.entry.type, 'sequence')
    assert.equal(built.state, STATES.AWAITING_CHILDREN, '子矩阵未验收时不能可运行')

    // 子 matrix 创建后应回填到父 DAG 的 subflow 节点
    const childId = built.children[0].matrix_id
    const groupNode = built.dag.nodes.find(node => node.group)
    assert.equal(groupNode.matrix_id, childId)
    assert.equal(built.dag.nodes.find(node => !node.group).type, 'script')
    assert.equal(built.progress.nodes['entry/childflow'].status, 'completed')
    await generateDag({ data_dir: dir, matrix_id: childId }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: childId })
    const childBuilt = await prebuild({ data_dir: dir, matrix_id: childId }, deps)
    assert.equal(childBuilt.state, STATES.RUNNABLE)

    const childAccepted = await accept({ data_dir: dir, matrix_id: childId })
    assert.equal(childAccepted.state, STATES.ACCEPTED)
    assert.ok(childAccepted.upgraded_parents.includes(created.id))

    const parent = await get({ data_dir: dir, matrix_id: created.id })
    assert.equal(parent.state, STATES.RUNNABLE, '子验收后父应自动升级为可运行')

    const executed = await run({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(executed.executed.status, 'completed')
    assert.deepEqual(executed.executed.output, { node: 'substep' }, '父运行应调用子 matrix 的运行并接收输出')
    const parentRun = executed.runs[0]
    assert.ok(parentRun, '父 matrix 应有自己的运行记录')

    // 子运行是独立记录
    const childDetail = await get({ data_dir: dir, matrix_id: childId })
    assert.equal(childDetail.run_ids.length, 1)

    const parentDetail = await get({ data_dir: dir, matrix_id: created.id })
    const runRecord = parentDetail.runs[0]
    assert.equal(runRecord.status, 'completed')

    const evaluated = await evaluate({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(evaluated.evaluation.passed, true)

    const supervised = await supervise({ data_dir: dir, matrix_id: created.id, instruction: '这次运行有什么风险？' }, deps)
    assert.equal(supervised.supervision.conclusion, '运行正常，无阻塞')
    assert.ok(state.systems.some(system => system.includes('监督分析员')))

    const accepted = await accept({ data_dir: dir, matrix_id: created.id })
    assert.equal(accepted.state, STATES.ACCEPTED)
    const treeData = tree({ data_dir: dir })
    assert.equal(treeData.roots.length, 1)
    assert.equal(treeData.roots[0].state, STATES.ACCEPTED)

    const listed = list({ data_dir: dir })
    assert.equal(listed.total, 2)
    const navInfo = nav({ data_dir: dir, matrix_id: created.id })
    assert.equal(navInfo.next, null)
    assert.deepEqual(navInfo.breadcrumb.map(item => item.id), [created.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P3 失败与重试：只重置失败节点', async () => {
  const dir = tempDir('retry')
  const state = { analysisCalls: 0, implCalls: 0, clarify: false, failFirst: true, systems: [] }
  const deps = { llm: fakeLlm(state) }
  try {
    const created = await intake({ data_dir: dir, task: '会失败一次的任务' }, deps)
    await generateDag({ data_dir: dir, matrix_id: created.id }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: created.id })
    const failed = await prebuild({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(failed.state, STATES.FAILED)
    assert.ok(failed.error.message.includes('模拟节点实现失败'))

    const retried = await retry({ data_dir: dir, matrix_id: created.id, instruction: '按原要求重试' }, deps)
    assert.equal(retried.state, STATES.AWAITING_CHILDREN, '失败重试只影响本 matrix，子矩阵仍需验收')
    assert.equal(retried.progress.nodes['entry/collect'].status, 'completed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P3 类型锁定：实现返回类型与 DAG 不符时失败', async () => {
  const dir = tempDir('typed')
  const state = { analysisCalls: 0, implCalls: 0, clarify: false, failFirst: false, systems: [] }
  const base = fakeLlm(state)
  const deps = {
    llm: {
      async complete(args) {
        if (String(args.system || '').includes('真实编码与验证')) {
          const payload = JSON.parse(args.user)
          return { content: JSON.stringify({ node: { id: payload.node.id, type: 'llm', mode: 'gen', prompt: '改写类型' } }) }
        }
        return base.complete(args)
      },
    },
  }
  try {
    const created = await intake({ data_dir: dir, task: '类型锁定任务' }, deps)
    await generateDag({ data_dir: dir, matrix_id: created.id }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: created.id })
    const failed = await prebuild({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(failed.state, STATES.FAILED)
    assert.ok(failed.error.message.includes('不得改变节点类型'), failed.error.message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('节点修复：直接替换 script code 并重跑（CommonJS require 可用）', async () => {
  const dir = tempDir('revise')
  const SKELETON = {
    summary: '单节点脚本',
    skeleton: {
      entry: {
        id: 'root',
        label: '根',
        intent: '执行脚本',
        inputs: { seed: 'string' },
        children: [{
          id: 'do_it',
          type: 'script',
          label: '执行',
          intent: '输出 JSON',
          inputs: { seed: 'string' },
          outputs: { ok: 'boolean' },
          complexity: 1,
        }],
      },
    },
    acceptance_criteria: ['输出 ok'],
    assumptions: [],
  }
  const deps = {
    llm: {
      async complete({ system, user }) {
        if (system.includes('需求分析员')) return { content: analysisResponse(true) }
        if (system.includes('规划骨架')) return { content: JSON.stringify(SKELETON) }
        if (system.includes('真实编码与验证')) {
          const payload = JSON.parse(user)
          return {
            content: JSON.stringify({
              node: {
                id: payload.node.id,
                type: 'script',
                runtime: 'node',
                code: 'process.stdout.write(JSON.stringify({ ok: true }))',
              },
            }),
          }
        }
        throw new Error(`未预期的 LLM 调用：${system.slice(0, 30)}`)
      },
    },
  }
  registerBridge(dir, deps)
  try {
    const created = await intake({ data_dir: dir, task: '脚本任务' }, deps)
    await generateDag({ data_dir: dir, matrix_id: created.id }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: created.id })
    const built = await prebuild({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(built.state, STATES.RUNNABLE)

    const code = 'const fs = require("fs");\nprocess.stdout.write(JSON.stringify({ ok: typeof fs.readFileSync === "function" }));'
    const revised = await reviseNodeAction({ data_dir: dir, matrix_id: created.id, node_path: 'entry/do_it', code }, deps)
    assert.equal(revised.state, STATES.RUNNABLE)
    assert.equal(revised.evaluation, null)
    const entry = revised.definition.entry
    const entryCode = entry.steps ? entry.steps[0].code : entry.code
    assert.ok(entryCode.includes('require("fs")'))

    const executed = await run({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(executed.executed.status, 'completed')
    assert.deepEqual(executed.executed.output, { ok: true }, 'CommonJS 脚本应能正常执行')

    // 运行产物：run.log + 节点 input/output 落盘，且可按路径读取
    const runId = executed.executed.run_id
    const artifacts = runArtifacts({ data_dir: dir, run_id: runId })
    assert.ok(existsSync(join(dir, 'runs', runId, 'run.log')), '应生成运行日志')
    const outputFile = artifacts.files.find(file => file.path.endsWith('output.json'))
    assert.ok(outputFile, '应生成节点 output.json 产物')
    const output = runArtifacts({ data_dir: dir, run_id: runId, path: outputFile.path })
    assert.deepEqual(JSON.parse(output.content), { ok: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Node 引擎：human 节点生成工单，答复后从缓存恢复', async () => {
  const dir = tempDir('human')
  const deps = {}
  registerBridge(dir, deps)
  const matrix = makeMatrix({
    id: 'mx_human01',
    name: 'human flow',
    state: STATES.RUNNABLE,
    prebuild_done: true,
  })
  matrix.definition = {
    version: 1,
    name: 'human flow',
    entry: {
      id: 'root',
      type: 'sequence',
      steps: [
        { id: 'ask', type: 'human', label: '人工确认', prompt: '请确认是否继续' },
        {
          id: 'after',
          type: 'script',
          label: '读取人工答复',
          runtime: 'node',
          code: "const fs = require('node:fs');\nconst input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'));\nfs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ approved: input.approved === true }));",
          output: 'json',
        },
      ],
    },
  }
  saveMatrix(dir, matrix)
  try {
    const executed = await run({ data_dir: dir, matrix_id: matrix.id }, deps)
    assert.equal(executed.executed.status, 'waiting_human')
    const runId = executed.executed.run_id
    const runDir = join(dir, 'runs', runId)
    assert.equal(executed.executed.pending.path, '/root/ask')
    const ticketId = executed.executed.pending.ticket_id
    assert.ok(ticketId)
    assert.ok(existsSync(join(runDir, 'tickets', `${ticketId}.json`)))
    assert.ok(existsSync(join(runDir, 'state', 'checkpoint.json')))

    const resumed = await resume({ data_dir: dir, matrix_id: matrix.id, run_id: runId, input: { approved: true } }, deps)
    assert.equal(resumed.resumed.status, 'completed')
    const saved = loadRun(dir, runId)
    assert.equal(saved.status, 'completed')
    assert.deepEqual(saved.output, { approved: true })
    const ticket = JSON.parse(readFileSync(join(runDir, 'tickets', `${ticketId}.json`), 'utf8'))
    assert.equal(ticket.status, 'answered')
    assert.ok(existsSync(join(runDir, 'nodes', 'root_ask', 'output.json')))
    assert.ok(existsSync(join(runDir, 'nodes', 'root_after', 'output.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Node 引擎：子 matrix 工单答复后自动冒泡恢复父运行', async () => {
  const dir = tempDir('subflow-bubble')
  const deps = {}
  registerBridge(dir, deps)
  const child = makeMatrix({
    id: 'mx_child01',
    name: 'child flow',
    state: STATES.RUNNABLE,
    prebuild_done: true,
  })
  child.definition = {
    version: 1,
    name: 'child flow',
    entry: {
      id: 'root',
      type: 'sequence',
      steps: [
        { id: 'ask', type: 'human', label: '子确认', prompt: '请确认子流程' },
        { id: 'done', type: 'det', op: 'literal', value: { child: 'ok' } },
      ],
    },
  }
  saveMatrix(dir, child)
  const parent = makeMatrix({
    id: 'mx_parent01',
    name: 'parent flow',
    state: STATES.RUNNABLE,
    prebuild_done: true,
  })
  parent.definition = {
    version: 1,
    name: 'parent flow',
    entry: {
      id: 'root',
      type: 'sequence',
      steps: [
        { id: 'seed', type: 'det', op: 'literal', value: { seed: 1 } },
        { id: 'child', type: 'subflow', label: '子流程', matrix_id: child.id },
        { id: 'after', type: 'det', op: 'expr', expr: { var: 'child' } },
      ],
    },
  }
  saveMatrix(dir, parent)
  try {
    const executed = await run({ data_dir: dir, matrix_id: parent.id }, deps)
    assert.equal(executed.executed.status, 'waiting_human')
    const parentRunId = executed.executed.run_id
    const parentRun = loadRun(dir, parentRunId)
    assert.equal(parentRun.pending.path, '/root/child')
    assert.equal(parentRun.pending.kind, 'subflow')
    const childRunId = parentRun.pending.subflow_run_id
    assert.ok(childRunId, '父运行 pending 应记录子 run id')

    const childRun = loadRun(dir, childRunId)
    assert.equal(childRun.status, 'waiting_human')
    assert.equal(childRun.parent_run_id, parentRunId)
    assert.equal(childRun.parent_path, '/root/child')
    const ticketId = childRun.pending.ticket_id
    assert.ok(ticketId)
    // 父 run 不应再生成一份重复的子流程工单
    assert.ok(!existsSync(join(dir, 'runs', parentRunId, 'tickets', `${ticketId}.json`)))

    await answerTicket({ data_dir: dir, matrix_id: child.id, ticket_id: ticketId, answer: { approved: true } }, deps)

    const childAfter = loadRun(dir, childRunId)
    assert.equal(childAfter.status, 'completed')
    const parentAfter = loadRun(dir, parentRunId)
    assert.equal(parentAfter.status, 'completed', '子运行完成后应自动恢复父运行')
    assert.equal(parentAfter.output, 'ok')
    assert.ok(existsSync(join(dir, 'runs', parentRunId, 'nodes', 'root_child', 'output.json')))
    assert.ok(existsSync(join(dir, 'runs', parentRunId, 'nodes', 'root_after', 'output.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('取消运行会终止 pipeline 子进程并释放 run 会话', async () => {
  const dir = tempDir('cancel-run')
  const disposed = []
  const deps = { disposeRunAgents: async runId => { disposed.push(runId) } }
  registerBridge(dir, deps)
  const matrix = makeMatrix({
    id: 'mx_cancel01',
    name: 'cancel flow',
    state: STATES.RUNNABLE,
    prebuild_done: true,
  })
  matrix.definition = {
    version: 1,
    name: 'cancel flow',
    entry: {
      id: 'root',
      type: 'script',
      label: '长时间运行',
      runtime: 'node',
      output: 'json',
      code: "const fs = require('node:fs');\nsetTimeout(() => {\n  fs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ done: true }));\n}, 3000);",
    },
  }
  saveMatrix(dir, matrix)
  try {
    const pending = run({ data_dir: dir, matrix_id: matrix.id }, deps)
    await new Promise(resolve => setTimeout(resolve, 500))
    const activeRun = listRuns(dir, matrix.id).find(item => item.status === 'running')
    assert.ok(activeRun, '运行应按已启动')
    const started = Date.now()
    await cancel({ data_dir: dir, matrix_id: matrix.id, reason: 'test cancel' }, deps)
    const executed = await pending
    assert.equal(executed.executed.status, 'cancelled')
    assert.ok(Date.now() - started < 2500, '取消应立即终止子进程，而不是等脚本自己结束')
    const saved = loadRun(dir, activeRun.id)
    assert.equal(saved.status, 'cancelled')
    assert.ok(saved.completed_at)
    assert.ok(disposed.includes(activeRun.id), '运行终态后应释放该 run 的 dsh 会话')
  } finally {
    await removeDir(dir)
  }
})

test('DAG 返工：runnable 可退回 awaiting_dag 并作废旧预构建结果', async () => {
  const dir = tempDir('reopen-dag')
  const matrix = makeMatrix({
    id: 'mx_reopen01',
    name: 'reopen flow',
    state: STATES.RUNNABLE,
    prebuild_done: true,
  })
  matrix.skeleton = {
    entry: { id: 'root', label: 'demo', children: [{ id: 'step_a', type: 'script', label: 'A', intent: 'x' }] },
  }
  matrix.dag = {
    version: 1, name: 'demo', readonly: true,
    entry: { id: 'step_a', type: 'script', readonly: true, build_status: 'planned' },
    nodes: [{ id: 'step_a', path: 'entry/step_a', type: 'script', readonly: true, build_status: 'planned' }],
  }
  matrix.definition = {
    version: 1, name: 'demo',
    entry: { id: 'root', type: 'sequence', steps: [{ id: 'step_a', type: 'script', runtime: 'node', code: 'return 1' }] },
  }
  matrix.progress = {
    current_node: null,
    nodes: {
      'entry/step_a': {
        status: 'completed', node_id: 'step_a', path: 'entry/step_a',
        implementation: { id: 'step_a', type: 'script', runtime: 'node', code: 'return 1' },
      },
    },
  }
  matrix.evaluation = { passed: true }
  matrix.accepted_at = new Date().toISOString()
  saveMatrix(dir, matrix)
  try {
    const detail = await reopenDag({ data_dir: dir, matrix_id: matrix.id }, {})
    assert.equal(detail.state, STATES.AWAITING_DAG)
    assert.equal(detail.prebuild_done, false)
    assert.equal(detail.definition, null)
    assert.deepEqual(detail.progress.nodes, {})
    assert.equal(detail.evaluation, null)
    assert.ok(detail.actions.includes('confirm-dag'))
    assert.ok(!detail.actions.includes('run'))

    const saved = loadMatrix(dir, matrix.id)
    assert.equal(saved.state, STATES.AWAITING_DAG)
    assert.equal(saved.definition, null)
    assert.equal(saved.prebuild_done, false)
    assert.deepEqual(saved.progress.nodes, {})
    assert.equal(saved.dag_confirmed_at, null)
    assert.equal(saved.evaluation, null)
    assert.ok(!('accepted_at' in saved))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dsh 提问：detail 暴露 ask_user_question，面板答案回传给宿主', async () => {
  const dir = tempDir('user-question')
  const matrix = makeMatrix({ id: 'mx_question01', name: 'question flow', state: STATES.AWAITING_DAG })
  saveMatrix(dir, matrix)
  try {
    saveQuestion(dir, {
      version: 1,
      id: 'uq_test01',
      matrix_id: matrix.id,
      session_id: matrix.id,
      questions: [{
        id: 'choice',
        header: '选择模式',
        question: '要使用哪种运行模式？',
        options: [{ label: 'files', description: '文件式 I/O' }, { label: 'inline' }],
      }],
      status: 'open',
      created_at: new Date().toISOString(),
    })

    const detail = await get({ data_dir: dir, matrix_id: matrix.id }, {})
    assert.equal(detail.questions.length, 1)
    assert.equal(detail.questions[0].questions[0].id, 'choice')

    let received = null
    const dependencies = {
      answerUserQuestion: async payload => { received = payload },
    }
    await answerUserQuestion({
      data_dir: dir,
      matrix_id: matrix.id,
      question_id: 'uq_test01',
      answers: [{ id: 'choice', selected: ['files'] }],
    }, dependencies)
    assert.equal(received.question_id, 'uq_test01')
    assert.deepEqual(received.answers, [{ id: 'choice', selected: ['files'] }])

    closeQuestion(dir, 'uq_test01', 'answered', received.answers)
    const refreshed = await get({ data_dir: dir, matrix_id: matrix.id }, {})
    assert.equal(refreshed.questions.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('确认 DAG 会关闭等待中的 ask_user_question', async () => {
  const dir = tempDir('confirm-cancel-question')
  const matrix = makeMatrix({ id: 'mx_confirmq01', state: STATES.AWAITING_DAG })
  matrix.skeleton = {
    entry: { id: 'root', label: 'demo', children: [{ id: 'step_a', type: 'script', label: 'A', intent: 'x' }] },
  }
  saveMatrix(dir, matrix)
  try {
    const cancelled = []
    const detail = await confirmDagAction({ data_dir: dir, matrix_id: matrix.id }, {
      cancelUserQuestions: payload => { cancelled.push(payload) },
    })
    assert.equal(detail.state, STATES.AWAITING_PREBUILD)
    assert.equal(cancelled.length, 1)
    assert.equal(cancelled[0].matrix_id, matrix.id)
    assert.ok(cancelled[0].reason.includes('确认 DAG'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('骨架契约：下游需要上游未透传的字段时校验失败', () => {
  const skeleton = {
    entry: {
      id: 'root',
      inputs: null,
      children: [
        { id: 'add_one_sub', type: 'group', inputs: { value: 'number' }, outputs: { result: 'number' } },
        { id: 'verify', type: 'script', inputs: { value: 'number', result: 'number' }, outputs: { verified: 'boolean' } },
      ],
    },
  }
  const result = validateSkeletonContracts(skeleton)
  assert.equal(result.ok, false)
  assert.ok(result.errors[0].includes('value'))
  assert.ok(result.errors[0].includes('上游只提供'))

  const aligned = {
    entry: {
      id: 'root',
      inputs: { value: 'number' },
      children: [
        { id: 'add_one_sub', type: 'group', inputs: { value: 'number' }, outputs: { value: 'number', result: 'number' } },
        { id: 'verify', type: 'script', inputs: { value: 'number', result: 'number' }, outputs: { verified: 'boolean' } },
      ],
    },
  }
  assert.equal(validateSkeletonContracts(aligned).ok, true)
})

test('DAG 视图：标注根输入与契约缺失字段', () => {
  const matrix = makeMatrix({ id: 'mx_view01', name: 'view flow' })
  matrix.skeleton = {
    entry: {
      id: 'root',
      label: 'view',
      inputs: null,
      children: [
        { id: 'add_one_sub', type: 'group', label: '加一', inputs: { value: 'number' }, outputs: { result: 'number' } },
        { id: 'verify', type: 'script', label: '校验', inputs: { value: 'number', result: 'number' }, outputs: { verified: 'boolean' } },
      ],
    },
  }
  const view = dagViewOf(matrix)
  assert.equal(view.root_inputs, null)
  assert.equal(view.contract_ok, false)
  assert.ok(view.contract_errors.length >= 1)
  assert.deepEqual(view.nodes.find(node => node.id === 'verify').contract_missing, ['value'])
})

test('编译契约：schema 形式的根输入写入 definition.inputs', () => {
  const definition = compileSkeleton({
    entry: {
      id: 'root',
      label: 'typed flow',
      inputs: { value: { type: 'number', required: true, description: '运行时输入' } },
      children: [{ id: 'sub', type: 'group', label: '子流程', inputs: { value: 'number' }, outputs: { result: 'number' } }],
    },
  }, {
    childRefs: { sub: { matrix_id: 'mx_childview', node_path: 'entry/sub' } },
  })
  assert.equal(definition.inputs.value.type, 'number')
  assert.equal(definition.inputs.value.required, true)
  assert.equal(definition.entry.type, 'subflow')
  assert.equal(definition.entry.matrix_id, 'mx_childview')
})

const FANOUT_SKELETON_RAW = {
  summary: '同一输入分发给加一与保留原值，再汇合并校验',
  skeleton: {
    entry: {
      id: 'root',
      label: '并行加一',
      intent: '验证 fanout/merge',
      inputs: { value: { type: 'number', required: true, description: '运行时输入' } },
      children: [
        {
          id: 'calc',
          type: 'fanout',
          label: '并行计算',
          intent: '同一输入分发给加一分支并带上原值',
          inputs: { value: 'number' },
          outputs: { plus_one: 'object', value: 'number' },
          carry: ['value'],
          collect: 'keyed',
          complexity: 3,
          children: [
            { id: 'plus_one', type: 'script', label: '加一', intent: '返回 value+1', inputs: { value: 'number' }, outputs: { result: 'number' }, complexity: 1 },
          ],
        },
        {
          id: 'join',
          type: 'merge',
          label: '汇合',
          intent: '把分支结果整理成下游契约',
          inputs: { plus_one: 'object', value: 'number' },
          outputs: { value: 'number', result: 'number' },
          mapping: { value: { var: 'value' }, result: { var: 'plus_one.result' } },
          complexity: 1,
        },
        {
          id: 'verify',
          type: 'script',
          label: '校验',
          intent: '断言 result=value+1',
          inputs: { value: 'number', result: 'number' },
          outputs: { value: 'number', result: 'number', expected: 'number', verified: 'boolean' },
          complexity: 1,
        },
      ],
    },
  },
  acceptance_criteria: ['输出 verified=true'],
  assumptions: [],
}

const BRANCH_SKELETON_RAW = {
  summary: '按正负条件分流',
  skeleton: {
    entry: {
      id: 'root',
      label: '条件分支',
      intent: '验证 branch',
      inputs: { value: { type: 'number', required: true, description: '运行时输入' } },
      children: [{
        id: 'route',
        type: 'branch',
        label: '按正负分流',
        intent: 'value >= 0 走 then，否则走 else',
        inputs: { value: 'number' },
        outputs: { result: 'string' },
        condition: { '>=': [{ var: 'value' }, 0] },
        complexity: 2,
        then: { id: 'positive', type: 'script', label: '非负处理', intent: '返回非负结果', inputs: { value: 'number' }, outputs: { result: 'string' }, complexity: 1 },
        else: { id: 'negative', type: 'script', label: '负数处理', intent: '返回负数结果', inputs: { value: 'number' }, outputs: { result: 'string' }, complexity: 1 },
      }],
    },
  },
  acceptance_criteria: ['条件分流正确'],
  assumptions: [],
}

const BRANCH_IMPL = {
  positive: "const fs = require('node:fs');\nconst input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'));\nfs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ result: input.value >= 0 ? 'non-negative' : 'unexpected' }));",
  negative: "const fs = require('node:fs');\nconst input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'));\nfs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ result: input.value < 0 ? 'negative' : 'unexpected' }));",
}

const FANOUT_IMPL = {
  plus_one: "const fs = require('node:fs');\nconst input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'));\nfs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ result: input.value + 1 }));",
  keep: "const fs = require('node:fs');\nconst input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'));\nfs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ value: input.value }));",
  verify: "const fs = require('node:fs');\nconst input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'));\nconst expected = input.value + 1;\nfs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ value: input.value, result: input.result, expected, verified: input.result === expected }));",
}

test('骨架 fanout/merge：归一化、契约校验、只读视图与编译', () => {
  const skeleton = normalizeSkeleton(FANOUT_SKELETON_RAW.skeleton)
  const fanout = skeleton.entry.children[0]
  assert.equal(fanout.type, 'fanout')
  assert.equal(fanout.collect, 'keyed')
  assert.deepEqual(fanout.carry, ['value'])
  assert.deepEqual(fanout.children.map(branch => branch.id), ['plus_one'])
  assert.equal(skeleton.entry.children[1].mapping.value.var, 'value')

  const issues = skeletonContractIssues(skeleton)
  assert.equal(issues.ok, true, issues.errors.join('\n'))

  const view = readonlyDefinition(skeleton)
  const calcView = view.nodes.find(node => node.id === 'calc')
  assert.equal(calcView.type, 'fanout')
  assert.deepEqual(calcView.carry, ['value'])
  assert.deepEqual(calcView.branches.map(branch => branch.path), ['entry/calc/plus_one'])
  assert.ok(view.nodes.some(node => node.id === 'plus_one' && node.branch_of === 'calc'))
  assert.equal(view.nodes.find(node => node.id === 'join').type, 'merge')

  const definition = compileSkeleton(skeleton, {
    implementations: {
      'entry/calc/plus_one': { id: 'plus_one', type: 'script', runtime: 'node', code: FANOUT_IMPL.plus_one },
      'entry/verify': { id: 'verify', type: 'script', runtime: 'node', code: FANOUT_IMPL.verify },
    },
  })
  validateDefinition(definition)
  assert.equal(definition.entry.type, 'sequence')
  assert.equal(definition.entry.steps[0].type, 'fanout')
  assert.deepEqual(definition.entry.steps[0].branches.map(branch => branch.id), ['plus_one'])
  assert.deepEqual(definition.entry.steps[0].carry, ['value'])
  assert.equal(definition.entry.steps[1].type, 'merge')
  assert.deepEqual(definition.entry.steps[1].mapping, { value: { var: 'value' }, result: { var: 'plus_one.result' } })
})

test('骨架 fanout/merge：分支缺字段、mapping 越界与非法分支被拒绝', () => {
  const branchMissing = {
    entry: {
      id: 'root',
      inputs: { value: 'number' },
      children: [{
        id: 'calc',
        type: 'fanout',
        inputs: { value: 'number' },
        outputs: { plus_one: 'object', keep: 'object' },
        children: [
          { id: 'plus_one', type: 'script', inputs: { value: 'number' }, outputs: { result: 'number' } },
          { id: 'keep', type: 'script', inputs: { source: 'number' }, outputs: { value: 'number' } },
        ],
      }],
    },
  }
  const missing = validateSkeletonContracts(branchMissing)
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some(message => message.includes('分支') && message.includes('source')))

  const mergeMissing = {
    entry: {
      id: 'root',
      inputs: { value: 'number' },
      children: [
        {
          id: 'calc',
          type: 'fanout',
          inputs: { value: 'number' },
          outputs: { plus_one: 'object' },
          children: [{ id: 'plus_one', type: 'script', inputs: { value: 'number' }, outputs: { result: 'number' } }],
        },
        {
          id: 'join',
          type: 'merge',
          inputs: { plus_one: 'object' },
          outputs: { value: 'number' },
          mapping: { value: { var: 'keep.value' } },
        },
      ],
    },
  }
  const mapping = validateSkeletonContracts(mergeMissing)
  assert.equal(mapping.ok, false)
  assert.ok(mapping.errors.some(message => message.includes('mapping') && message.includes('keep')))

  assert.throws(
    () => normalizeSkeleton({
      entry: { id: 'root', intent: 'x', children: [{ id: 'a', type: 'fanout', intent: 'x', inputs: { value: 'number' }, outputs: { keep: 'object' }, children: [{ id: 'b', type: 'script', intent: 'x', inputs: { value: 'number' }, outputs: { value: 'number' } }, { id: 'keep', type: 'script', intent: 'x', inputs: { value: 'number' }, outputs: { value: 'number' } }] }] },
    }),
    /缺少 b/,
  )
  assert.throws(
    () => normalizeSkeleton({
      entry: { id: 'root', intent: 'x', children: [{ id: 'a', type: 'fanout', intent: 'x', inputs: { value: 'number' }, outputs: { b: 'object' }, children: [{ id: 'b', type: 'fanout', intent: 'x', inputs: { value: 'number' }, outputs: { c: 'object' }, children: [{ id: 'c', type: 'script', intent: 'x', inputs: { value: 'number' }, outputs: { value: 'number' } }] }] }] },
    }),
    /不能嵌套/,
  )

  assert.throws(
    () => normalizeSkeleton({ entry: { id: 'root', intent: 'x', children: [{ id: 'a', type: 'fanout', intent: 'x', inputs: { value: 'number' }, outputs: { b: 'object' }, carry: ['missing'], children: [{ id: 'b', type: 'script', intent: 'x', inputs: { value: 'number' }, outputs: { value: 'number' } }] }] } }),
    /carry 字段不在输入中/,
  )
  assert.throws(
    () => normalizeSkeleton({ entry: { id: 'root', intent: 'x', children: [{ id: 'a', type: 'fanout', intent: 'x', inputs: { value: 'number', b: 'object' }, outputs: { b: 'object', value: 'number' }, carry: ['b'], children: [{ id: 'b', type: 'script', intent: 'x', inputs: { value: 'number', b: 'object' }, outputs: { value: 'number' } }] }] } }),
    /不能与分支 id 重名/,
  )
  assert.throws(
    () => normalizeSkeleton({ entry: { id: 'root', intent: 'x', children: [{ id: 'a', type: 'fanout', intent: 'x', inputs: { value: 'number' }, outputs: { b: 'object' }, carry: ['value'], collect: 'array', children: [{ id: 'b', type: 'script', intent: 'x', inputs: { value: 'number' }, outputs: { value: 'number' } }] }] } }),
    /carry 只支持 collect=keyed/,
  )

  const carryMissingOutput = {
    entry: {
      id: 'root',
      inputs: { value: 'number' },
      children: [{
        id: 'calc',
        type: 'fanout',
        inputs: { value: 'number' },
        outputs: { plus_one: 'object' },
        carry: ['value'],
        children: [{ id: 'plus_one', type: 'script', inputs: { value: 'number' }, outputs: { result: 'number' } }],
      }],
    },
  }
  const carryIssues = validateSkeletonContracts(carryMissingOutput)
  assert.equal(carryIssues.ok, false)
  assert.ok(carryIssues.errors.some(message => message.includes('value') && message.includes('carry')))
})

test('P2-P5 端到端：fanout 分支预构建、merge 合成与真实运行', async () => {
  const dir = tempDir('fanout-e2e')
  const deps = {
    llm: {
      async complete({ system, user }) {
        if (system.includes('需求分析员')) return { content: analysisResponse(true) }
        if (system.includes('规划骨架')) return { content: JSON.stringify(FANOUT_SKELETON_RAW) }
        if (system.includes('真实编码与验证')) {
          const payload = JSON.parse(user)
          const code = FANOUT_IMPL[payload.node.id]
          if (!code) throw new Error(`未预期的节点实现：${payload.node.id}`)
          return {
            content: JSON.stringify({
              node: { id: payload.node.id, type: payload.node.type, runtime: 'node', code },
            }),
          }
        }
        throw new Error(`未预期的 LLM 调用：${system.slice(0, 30)}`)
      },
    },
  }
  registerBridge(dir, deps)
  try {
    const created = await intake({ data_dir: dir, task: '并行加一' }, deps)
    await generateDag({ data_dir: dir, matrix_id: created.id }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: created.id })
    const built = await prebuild({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(built.state, STATES.RUNNABLE)
    assert.equal(built.definition.entry.steps[0].type, 'fanout')
    assert.equal(built.definition.entry.steps[1].type, 'merge')
    assert.equal(built.progress.nodes['entry/calc/plus_one'].status, 'completed')
    assert.ok(!built.progress.nodes['entry/calc/keep'], 'carry 方案不应再生成透传分支')
    // fanout/merge 是控制节点，不进入预构建实现与进度
    assert.ok(!built.progress.nodes['entry/calc'])
    assert.ok(!built.progress.nodes['entry/join'])
    assert.ok(built.dag.nodes.find(node => node.id === 'calc').branches.length === 1)
    assert.ok(built.dag.nodes.find(node => node.id === 'plus_one'))

    const executed = await run({ data_dir: dir, matrix_id: created.id, input: { value: 77 } }, deps)
    assert.equal(executed.executed.status, 'completed')
    assert.deepEqual(executed.executed.output, { value: 77, result: 78, expected: 78, verified: true })

    // 运行轨迹只包含真正执行的节点，fanout/merge 不产生 trace
    const runRecord = loadRun(dir, executed.executed.run_id)
    assert.deepEqual(
      runRecord.trace.map(step => step.node_id).sort(),
      ['plus_one', 'verify'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('骨架 branch：归一化、契约校验、只读视图与编译', () => {
  const skeleton = normalizeSkeleton(BRANCH_SKELETON_RAW.skeleton)
  const route = skeleton.entry.children[0]
  assert.equal(route.type, 'branch')
  assert.deepEqual(route.condition, { '>=': [{ var: 'value' }, 0] })
  assert.equal(route.then.id, 'positive')
  assert.equal(route.else.id, 'negative')

  const issues = skeletonContractIssues(skeleton)
  assert.equal(issues.ok, true, issues.errors.join('\n'))

  const view = readonlyDefinition(skeleton)
  const routeView = view.nodes.find(node => node.id === 'route')
  assert.equal(routeView.type, 'branch')
  assert.equal(routeView.then.id, 'positive')
  assert.equal(routeView.else.id, 'negative')
  assert.ok(view.nodes.some(node => node.id === 'positive' && node.branch_role === 'then'))
  assert.ok(view.nodes.some(node => node.id === 'negative' && node.branch_role === 'else'))

  const definition = compileSkeleton(skeleton, {
    implementations: {
      'entry/route/positive': { id: 'positive', type: 'script', runtime: 'node', code: BRANCH_IMPL.positive },
      'entry/route/negative': { id: 'negative', type: 'script', runtime: 'node', code: BRANCH_IMPL.negative },
    },
  })
  validateDefinition(definition)
  assert.equal(definition.entry.type, 'branch')
  assert.deepEqual(definition.entry.condition, { '>=': [{ var: 'value' }, 0] })
  assert.equal(definition.entry.then.id, 'positive')
  assert.equal(definition.entry.else.id, 'negative')
})

test('骨架 branch：缺少 condition、嵌套控制流与契约越界被拒绝', () => {
  assert.throws(
    () => normalizeSkeleton({
      entry: { id: 'root', intent: 'x', children: [{ id: 'route', type: 'branch', intent: 'x', inputs: { value: 'number' }, outputs: { result: 'string' }, then: { id: 'a', type: 'script', intent: 'x', inputs: { value: 'number' }, outputs: { result: 'string' } } }] },
    }),
    /condition/,
  )
  assert.throws(
    () => normalizeSkeleton({
      entry: { id: 'root', intent: 'x', children: [{ id: 'route', type: 'branch', intent: 'x', inputs: { value: 'number' }, outputs: { result: 'string' }, condition: { '>=': [{ var: 'value' }, 0] }, then: { id: 'a', type: 'fanout', intent: 'x', inputs: { value: 'number' }, outputs: { result: 'string' }, children: [{ id: 'b', type: 'script', intent: 'x', inputs: { value: 'number' }, outputs: { result: 'string' } }] } }] },
    }),
    /不能嵌套 fanout/,
  )

  const missingCin = {
    entry: {
      id: 'root',
      inputs: { value: 'number' },
      children: [{
        id: 'route',
        type: 'branch',
        inputs: { value: 'number' },
        outputs: { result: 'string' },
        condition: { '>=': [{ var: 'value' }, 0] },
        then: { id: 'positive', type: 'script', inputs: { value: 'number', source: 'string' }, outputs: { result: 'string' } },
        else: { id: 'negative', type: 'script', inputs: { value: 'number' }, outputs: { result: 'string' } },
      }],
    },
  }
  const cinIssues = validateSkeletonContracts(missingCin)
  assert.equal(cinIssues.ok, false)
  assert.ok(cinIssues.errors.some(message => message.includes('source')))

  const missingCout = {
    entry: {
      id: 'root',
      inputs: { value: 'number' },
      children: [{
        id: 'route',
        type: 'branch',
        inputs: { value: 'number' },
        outputs: { result: 'string' },
        condition: { '>=': [{ var: 'value' }, 0] },
        then: { id: 'positive', type: 'script', inputs: { value: 'number' }, outputs: { result: 'string' } },
        else: { id: 'negative', type: 'script', inputs: { value: 'number' }, outputs: { other: 'string' } },
      }],
    },
  }
  const coutIssues = validateSkeletonContracts(missingCout)
  assert.equal(coutIssues.ok, false)
  assert.ok(coutIssues.errors.some(message => message.includes('result')))
})

test('P2-P5 端到端：branch 按条件执行 then/else', async () => {
  const dir = tempDir('branch-e2e')
  const deps = {
    llm: {
      async complete({ system, user }) {
        if (system.includes('需求分析员')) return { content: analysisResponse(true) }
        if (system.includes('规划骨架')) return { content: JSON.stringify(BRANCH_SKELETON_RAW) }
        if (system.includes('真实编码与验证')) {
          const payload = JSON.parse(user)
          const code = BRANCH_IMPL[payload.node.id]
          if (!code) throw new Error(`未预期的节点实现：${payload.node.id}`)
          return {
            content: JSON.stringify({
              node: { id: payload.node.id, type: payload.node.type, runtime: 'node', code },
            }),
          }
        }
        throw new Error(`未预期的 LLM 调用：${system.slice(0, 30)}`)
      },
    },
  }
  registerBridge(dir, deps)
  try {
    const created = await intake({ data_dir: dir, task: '条件分流' }, deps)
    await generateDag({ data_dir: dir, matrix_id: created.id }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: created.id })
    const built = await prebuild({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(built.definition.entry.type, 'branch')
    assert.equal(built.progress.nodes['entry/route/positive'].status, 'completed')
    assert.equal(built.progress.nodes['entry/route/negative'].status, 'completed')
    assert.ok(!built.progress.nodes['entry/route'], 'branch 是控制节点，不进入预构建进度')
    assert.ok(built.dag.nodes.find(node => node.id === 'route').then)

    const positiveRun = await run({ data_dir: dir, matrix_id: created.id, input: { value: 5 } }, deps)
    assert.equal(positiveRun.executed.status, 'completed')
    assert.deepEqual(positiveRun.executed.output, { result: 'non-negative' })
    const positiveTrace = loadRun(dir, positiveRun.executed.run_id).trace.map(step => step.node_id)
    assert.deepEqual(positiveTrace, ['positive'])

    const negativeRun = await run({ data_dir: dir, matrix_id: created.id, input: { value: -5 } }, deps)
    assert.equal(negativeRun.executed.status, 'completed')
    assert.deepEqual(negativeRun.executed.output, { result: 'negative' })
    const negativeTrace = loadRun(dir, negativeRun.executed.run_id).trace.map(step => step.node_id)
    assert.deepEqual(negativeTrace, ['negative'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话撤回：从已完成轮次分叉并把时间线回退到该轮', async () => {
  const dir = tempDir('rewind')
  const matrix = makeMatrix({
    id: 'mx_rewind01',
    name: 'rewind flow',
    state: STATES.AWAITING_DAG,
    dsh_session_id: 'mx_rewind01',
  })
  matrix.archive = [
    { id: 'a1', seq: 1, type: 'event', source: 'matrix', at: '2026-11-02T01:00:00.000Z', text: '保留的上下文' },
    { id: 'a2', seq: 2, type: 'message', source: 'panel', at: '2026-11-02T02:00:00.000Z', text: '问得不好的问题' },
    { id: 'a3', seq: 3, type: 'event', source: 'dsh', at: '2026-11-02T02:05:00.000Z', text: '要撤掉的回复' },
  ]
  matrix.messages = [
    { id: 'm1', seq: 1, kind: 'agent', role: 'system', at: '2026-11-02T01:00:00.000Z', text: '保留的上下文' },
    { id: 'm2', seq: 2, kind: 'chat', role: 'user', at: '2026-11-02T02:00:00.000Z', text: '问得不好的问题' },
  ]
  matrix.archive_seq = 3
  matrix.message_seq = 2
  saveMatrix(dir, matrix)
  try {
    const calls = []
    const dependencies = {
      forkMatrixSession: async payload => {
        calls.push(payload)
        return { session_id: 'mx_rewind01-r1', at_seq: payload.atSeq, at: '2026-11-02T01:30:00.000Z' }
      },
    }
    const detail = await rewindSession({ data_dir: dir, matrix_id: matrix.id, at_seq: 11 }, dependencies)
    assert.equal(detail.dsh_session_id, 'mx_rewind01-r1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].sessionId, 'mx_rewind01')
    assert.equal(calls[0].atSeq, 11)

    const saved = loadMatrix(dir, matrix.id)
    assert.equal(saved.dsh_session_id, 'mx_rewind01-r1')
    assert.equal(saved.dsh_event_seq, 12)
    assert.deepEqual(saved.archive.filter(entry => entry.source === 'panel').map(entry => entry.text), [])
    assert.ok(saved.archive.some(entry => entry.text === '保留的上下文'))
    assert.ok(!saved.archive.some(entry => entry.text === '问得不好的问题'))
    assert.ok(!saved.messages.some(message => message.text === '问得不好的问题'))
    assert.equal(saved.rewind_history.length, 1)
    assert.equal(saved.dsh_mirror_seq, saved.archive_seq)

    const points = await rewindPoints({ data_dir: dir, matrix_id: matrix.id }, {
      rewindPoints: async () => ({ session_id: 'mx_rewind01-r1', points: [{ at_seq: 11, turn: 3 }], running: false }),
    })
    assert.equal(points.points.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话归档：dsh 事件增量归档进 matrix，重复轮询不重复写入', async () => {
  const dir = tempDir('archive')
  const state = { analysisCalls: 0, implCalls: 0, clarify: false, failFirst: false, systems: [] }
  const events = []
  const mirrored = []
  const deps = {
    llm: fakeLlm(state),
    sessionMirror: async ({ sessionId }) => ({ session_id: sessionId, path: 'C:/tmp/matrix' }),
    sessionEvents: async ({ sinceSeq }) => ({ events: events.filter(event => event.seq >= sinceSeq), cursor: events.length }),
    sessionAppend: async ({ entries }) => { mirrored.push(...entries.map(entry => entry.text)); return { appended: true } },
  }
  try {
    const created = await intake({ data_dir: dir, task: '归档任务' }, deps)
    assert.ok(mirrored.some(text => text.includes('受理任务')), 'matrix 侧事件应回灌 dsh 会话')
    // 模拟绑定 agent 在 dsh 会话里的输出与工具调用
    events.push({ type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'text', text: '已了解需求' }] } } })
    events.push({ type: 'tool/call', seq: 1, data: { name: 'matrix_get', callId: 'call-1', arguments: '{}' } })

    const detail = await get({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(detail.messages[detail.messages.length - 1].text, '已了解需求')
    assert.ok(detail.archive.some(entry => entry.type === 'tool' && entry.text === 'matrix_get'))
    assert.equal(loadMatrix(dir, created.id).dsh_event_seq, 2)

    const total = detail.messages.length
    const again = await get({ data_dir: dir, matrix_id: created.id }, deps)
    assert.equal(again.messages.length, total, '没有新事件时重复轮询不得重复归档')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板输入：交给绑定 agent，并可按会话自动解析 matrix_id', async () => {
  const dir = tempDir('chat')
  const state = { analysisCalls: 0, implCalls: 0, clarify: false, failFirst: false, systems: [] }
  const chats = []
  const deps = {
    llm: fakeLlm(state),
    sessionMirror: async ({ sessionId }) => ({ session_id: sessionId, path: 'C:/tmp/matrix' }),
    matrixChat: async payload => { chats.push(payload) },
  }
  try {
    const created = await intake({ data_dir: dir, task: '对话任务' }, deps)
    const text = '把验收标准改成必须返回 report 字段'
    const detail = await chat({ data_dir: dir, matrix_id: created.id, text }, deps)
    assert.equal(chats.length, 1, '面板输入应交给绑定 agent')
    assert.equal(chats[0].sessionId, created.id)
    assert.equal(chats[0].text, text)
    assert.ok(detail.messages.some(message => message.kind === 'chat' && message.role === 'user' && message.text === text))
    assert.ok(detail.archive.some(entry => entry.type === 'action' && entry.source === 'panel'))

    // 绑定会话内不传 matrix_id：按会话 id 自动解析
    const auto = await get({ data_dir: dir }, deps, { sessionId: created.id })
    assert.equal(auto.id, created.id)

    await recordAction({ data_dir: dir, matrix_id: created.id, action: 'confirm-dag', ok: true })
    const actions = loadMatrix(dir, created.id).archive.filter(entry => entry.type === 'action')
    assert.ok(actions.some(entry => entry.text === 'confirm-dag'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话树：子 matrix 使用根 workspace 且挂到父会话', async () => {
  const dir = tempDir('tree')
  const state = { analysisCalls: 0, implCalls: 0, clarify: false, failFirst: false, systems: [] }
  const mirrors = []
  const deps = {
    llm: fakeLlm(state),
    sessionMirror: async args => {
      mirrors.push(args)
      return { session_id: args.sessionId, path: args.workspace }
    },
  }
  try {
    const parent = await intake({ data_dir: dir, task: '父 matrix' }, deps)
    const child = await intake({ data_dir: dir, task: '子 matrix', parent_id: parent.id }, deps)
    assert.equal(mirrors.length, 2)
    assert.equal(mirrors[0].parentSessionId, null)
    assert.equal(mirrors[1].parentSessionId, parent.id)
    // dsh 侧栏按 workspace 分组，组内才按 parentSession 嵌套：同一项目的会话必须共用一个 workspace
    assert.equal(mirrors[0].workspace, mirrors[1].workspace)
    assert.ok(mirrors[0].workspace.includes('projects'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4/P5 信箱：跨 matrix 发送、收件与回复', async () => {
  const dir = tempDir('mail')
  const { deps } = makeDeps()
  try {
    const parent = await intake({ data_dir: dir, task: '父任务' }, deps)
    const child = await intake({ data_dir: dir, task: '子任务', parent_id: parent.id }, deps)
    const sent = await mail({
      data_dir: dir,
      matrix_id: parent.id,
      action: 'send',
      to_matrix: child.id,
      kind: 'question',
      subject: '契约确认',
      body: '子流程输出需要包含什么？',
    })
    assert.equal(sent.to, child.id)

    const inbox = await mail({ data_dir: dir, matrix_id: child.id, action: 'inbox' })
    assert.equal(inbox.unread, 1)
    const replied = await mail({ data_dir: dir, matrix_id: child.id, action: 'reply', mail_id: sent.id, body: '需要返回 node 字段' })
    assert.equal(replied.mail.resolved, true)
    const parentInbox = await mail({ data_dir: dir, matrix_id: parent.id, action: 'inbox' })
    assert.ok(parentInbox.mails.some(item => item.kind === 'answer'))

    // 跨项目通信被拒绝
    const other = await intake({ data_dir: dir, task: '另一个项目' }, deps)
    await assert.rejects(mail({ data_dir: dir, matrix_id: other.id, action: 'send', to_matrix: child.id, body: 'x' }), /同一个项目/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('输入路由与终止', async () => {
  const dir = tempDir('routing')
  const { deps } = makeDeps()
  try {
    const created = await intake({ data_dir: dir, task: '输入路由任务' }, deps)
    await generateDag({ data_dir: dir, matrix_id: created.id }, deps)
    const routed = await submitInput({ data_dir: dir, matrix_id: created.id, text: '把收集节点拆细一点' }, deps)
    assert.equal(routed.state, STATES.AWAITING_DAG)
    assert.ok(routed.messages.some(message => message.kind === 'chat' && message.text.includes('拆细')))
    const cancelled = await cancel({ data_dir: dir, matrix_id: created.id, reason: '不再需要' })
    assert.equal(cancelled.state, STATES.CANCELLED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板冒烟：health / tree / detail', async () => {
  const dir = tempDir('panel')
  const { deps } = makeDeps()
  let panel
  try {
    const created = await intake({ data_dir: dir, task: '面板任务' }, deps)
    panel = await startPanel({ data_dir: dir, port: 0 }, deps)
    const health = await fetch(`${panel.url}api/health`).then(response => response.json())
    assert.equal(health.service, 'rms-flow-runner-v2')
    const treeBody = await fetch(`${panel.url}api/matrix/tree`).then(response => response.json())
    assert.equal(treeBody.roots.length, 1)
    const detail = await fetch(`${panel.url}api/matrix/${created.id}`).then(response => response.json())
    assert.equal(detail.id, created.id)
    const html = await fetch(panel.url).then(response => response.text())
    assert.ok(html.includes('Flow Runner V2'))
  } finally {
    if (panel) await panel.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目 P1：历史根 matrix 迁移为同名项目并回填子树 project_id', () => {
  const dir = tempDir('project-migrate')
  try {
    const root = makeMatrix({ id: 'mx_legacy01', name: '旧项目', state: STATES.RUNNABLE, prebuild_done: true })
    const child = makeMatrix({ id: 'mx_legacy02', parent_id: root.id })
    root.children = [{ node_id: 'g', node_path: 'entry/g', matrix_id: child.id }]
    saveMatrix(dir, root)
    saveMatrix(dir, child)

    const created = ensureProjectsMigrated(dir)
    assert.equal(created.length, 1)
    const projects = listProjects(dir)
    assert.equal(projects.length, 1)
    assert.equal(projects[0].name, '旧项目')
    assert.deepEqual(projects[0].root_matrix_ids, [root.id])
    // 老项目 cwd 复用原根 matrix 的 work，历史会话分组不变
    assert.equal(projects[0].cwd, matrixWorkDir(dir, root.id))

    assert.equal(loadMatrix(dir, root.id).project_id, projects[0].id)
    assert.equal(loadMatrix(dir, child.id).project_id, projects[0].id)
    // 幂等：再跑一次不会重复建项目
    assert.deepEqual(ensureProjectsMigrated(dir), [])
    assert.equal(listProjects(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目 P2-P3：CRUD、项目会话、记忆落盘与 PROJECT_MEMORY.md 注入', async () => {
  const dir = tempDir('project-crud')
  const mirrors = []
  const chats = []
  const deps = {
    sessionMirror: async args => {
      mirrors.push(args)
      return { session_id: args.sessionId, path: args.workspace }
    },
    matrixChat: async payload => { chats.push(payload) },
  }
  try {
    const created = await projectCreate({ data_dir: dir, name: '项目 A', brief: '交付一个报告' }, deps)
    assert.equal(created.state, 'active')
    assert.ok(created.oplog.some(entry => entry.action === 'project_create'), '创建项目应写入操作日志')
    assert.equal(created.dsh_session_id, created.id)
    assert.equal(created.cwd, projectWorkDir(dir, created.id))
    assert.equal(mirrors.length, 1)
    assert.equal(mirrors[0].parentSessionId, null, '项目会话是顶层会话')
    assert.ok(mirrors[0].brief.includes('project_id'), '项目会话语境应包含 project_id')

    const listed = projectList({ data_dir: dir })
    assert.equal(listed.total, 1)
    assert.equal(listed.projects[0].roots, 0)

    const added = await projectMemory({ data_dir: dir, project_id: created.id, action: 'add', text: '统一使用 files 运行模式' })
    assert.equal(added.entries.length, 1)
    assert.ok((await projectGet({ data_dir: dir, project_id: created.id }, deps)).oplog.some(entry => entry.action === 'memory_add'))
    assert.ok(existsSync(join(created.cwd, 'PROJECT_MEMORY.md')), '记忆应同步落 PROJECT_MEMORY.md')
    assert.ok(readFileSync(join(created.cwd, 'PROJECT_MEMORY.md'), 'utf8').includes('files 运行模式'))

    const chatted = await projectChat({ data_dir: dir, project_id: created.id, text: '项目现在有什么？' }, deps)
    assert.equal(chats.length, 1)
    assert.equal(chats[0].sessionId, created.id)
    assert.ok(chats[0].brief.includes('files 运行模式'), '项目记忆注入项目会话语境')
    assert.ok(chatted.messages.some(message => message.kind === 'chat' && message.text === '项目现在有什么？'))

    await projectUpdate({ data_dir: dir, project_id: created.id, name: '项目 A2' }, deps)
    assert.equal(loadProject(dir, created.id).name, '项目 A2')
    assert.ok(loadProject(dir, created.id).oplog.some(entry => entry.action === 'project_update'))

    const archived = await projectArchive({ data_dir: dir, project_id: created.id }, deps)
    assert.equal(archived.state, 'archived')
    assert.equal(projectList({ data_dir: dir }).total, 0, '默认列表不显示归档项目')
    assert.equal(projectList({ data_dir: dir, include_archived: true }).total, 1)

    await projectMemory({ data_dir: dir, project_id: created.id, action: 'remove', entry_id: added.entries[0].id })
    const refreshed = await projectGet({ data_dir: dir, project_id: created.id }, deps)
    assert.equal(refreshed.memory.entries.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const PROJECT_ROOT_SKELETON = {
  summary: '项目根 matrix 只含一个脚本节点',
  skeleton: {
    entry: {
      id: 'root',
      label: '项目根流程',
      intent: '完成项目的一个独立目标',
      inputs: { seed: 'string' },
      children: [{
        id: 'only',
        type: 'script',
        label: '执行',
        intent: '输出 ok',
        inputs: { seed: 'string' },
        outputs: { ok: 'boolean' },
        complexity: 1,
      }],
    },
  },
  acceptance_criteria: ['输出 ok'],
  assumptions: [],
}

test('项目 P3/P5：根 matrix 挂项目、项目汇总/树/导航与批量运行', async () => {
  const dir = tempDir('project-matrix')
  const deps = {
    llm: {
      async complete({ system, user }) {
        if (system.includes('需求分析员')) return { content: analysisResponse(true) }
        if (system.includes('规划骨架')) return { content: JSON.stringify(PROJECT_ROOT_SKELETON) }
        if (system.includes('真实编码与验证')) {
          const payload = JSON.parse(user)
          return {
            content: JSON.stringify({
              node: {
                id: payload.node.id,
                type: payload.node.type,
                runtime: 'node',
                code: 'process.stdout.write(JSON.stringify({ ok: true }))',
              },
            }),
          }
        }
        throw new Error(`未预期的 LLM 调用：${system.slice(0, 30)}`)
      },
    },
  }
  registerBridge(dir, deps)
  try {
    const project = await projectCreate({ data_dir: dir, name: '交付项目' }, deps)
    const root = await intake({ data_dir: dir, task: '项目根任务', project_id: project.id }, deps)
    assert.equal(root.project_id, project.id)
    assert.deepEqual(loadProject(dir, project.id).root_matrix_ids, [root.id])

    await generateDag({ data_dir: dir, matrix_id: root.id }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: root.id })
    const built = await prebuild({ data_dir: dir, matrix_id: root.id }, deps)
    assert.equal(built.state, STATES.RUNNABLE)

    const summary = projectSummary({ data_dir: dir, project_id: project.id })
    assert.equal(summary.roots.length, 1)
    assert.deepEqual(summary.runnable_roots, [root.id])
    assert.equal(summary.matrices, 1)

    const projectTreeData = projectTree({ data_dir: dir, project_id: project.id })
    assert.equal(projectTreeData.roots.length, 1)
    assert.equal(projectTreeData.roots[0].id, root.id)

    const navInfo = projectNav({ data_dir: dir, project_id: project.id })
    assert.equal(navInfo.next.id, root.id)

    const matrixList = list({ data_dir: dir, project_id: project.id })
    assert.equal(matrixList.total, 1)
    assert.deepEqual(tree({ data_dir: dir, project_id: project.id }).roots.map(item => item.id), [root.id])

    const ran = await projectRunRunnable({ data_dir: dir, project_id: project.id }, deps)
    assert.equal(ran.ran, 1)
    assert.equal(ran.results[0].ok, true)
    assert.equal(ran.results[0].run.status, 'completed')

    const detail = await projectGet({ data_dir: dir, project_id: project.id }, deps)
    assert.ok(detail.runs.some(run => run.status === 'completed'), '项目汇总应包含根 matrix 的运行')
    // 面板确定性动作也写入项目操作日志
    await recordAction({ data_dir: dir, matrix_id: root.id, action: 'run', ok: true })
    const withOplog = await projectGet({ data_dir: dir, project_id: project.id }, deps)
    assert.ok(withOplog.oplog.some(entry => entry.action === 'matrix_run'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目面板接口：列表、详情、记忆与项目树', async () => {
  const dir = tempDir('project-panel')
  const deps = { sessionMirror: async args => ({ session_id: args.sessionId, path: args.workspace }) }
  let panel
  try {
    const project = await projectCreate({ data_dir: dir, name: '面板项目' }, deps)
    const root = await intake({ data_dir: dir, task: '面板根任务', project_id: project.id }, deps)
    panel = await startPanel({ data_dir: dir, port: 0 }, deps)

    const listBody = await fetch(`${panel.url}api/projects`).then(response => response.json())
    assert.equal(listBody.total, 1)
    assert.equal(listBody.projects[0].roots, 1)

    const detail = await fetch(`${panel.url}api/projects/${project.id}`).then(response => response.json())
    assert.equal(detail.id, project.id)
    assert.equal(detail.roots.length, 1)
    assert.equal(detail.roots[0].id, root.id)

    await fetch(`${panel.url}api/projects/${project.id}/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', text: '面板写入的记忆' }),
    })
    const memoryBody = await fetch(`${panel.url}api/projects/${project.id}/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
    }).then(response => response.json())
    assert.equal(memoryBody.entries.length, 1)

    const treeBody = await fetch(`${panel.url}api/matrix/tree?project_id=${project.id}`).then(response => response.json())
    assert.equal(treeBody.roots.length, 1)

    const domain = await domainCreate({ data_dir: dir, project_id: project.id, name: '面板领域' }, deps)
    const domainListBody = await fetch(`${panel.url}api/projects/${project.id}/domains`).then(response => response.json())
    assert.equal(domainListBody.total, 1)
    const domainDetail = await fetch(`${panel.url}api/domains/${domain.id}`).then(response => response.json())
    assert.equal(domainDetail.id, domain.id)
    await fetch(`${panel.url}api/domains/${domain.id}/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'model', element: { name: 'PanelModel', kind: 'entity' } }),
    })
    const withModel = await fetch(`${panel.url}api/domains/${domain.id}`).then(response => response.json())
    assert.equal(withModel.models.length, 1)
  } finally {
    if (panel) await panel.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目 Git checkpoint：快照含会话、关键操作自动提交与回滚', async () => {
  const dir = tempDir('project-git')
  const { deps: base } = makeDeps()
  const seeded = []
  const deps = {
    ...base,
    sessionMirror: async args => ({ session_id: args.sessionId, path: args.workspace }),
    matrixChat: async () => {},
    sessionEvents: async ({ sessionId }) => ({
      events: [{
        seq: 0,
        type: 'user/message',
        time: Date.now(),
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `hello ${sessionId}` }] },
      }],
      cursor: 1,
    }),
    sessionSeed: async ({ sessionId, events }) => {
      const id = `${sessionId}-ck`
      seeded.push({ id, count: events.length })
      return { session_id: id }
    },
  }
  try {
    const project = await projectCreate({ data_dir: dir, name: 'Git 项目' }, deps)
    const root = await intake({ data_dir: dir, task: 'git 根任务', project_id: project.id }, deps)
    const work = matrixWorkDir(dir, root.id)
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'note.txt'), 'v1', 'utf8')

    const initialized = await projectGit({ data_dir: dir, project_id: project.id, action: 'init' }, deps)
    assert.equal(initialized.status.enabled, true)
    const first = await projectGit({ data_dir: dir, project_id: project.id, action: 'commit', message: 'checkpoint one' }, deps)
    assert.ok(first.result.commit, '首次提交应生成 commit')

    const repo = projectRepoDir(dir, project.id)
    assert.ok(existsSync(join(repo, 'state', 'project.json')), '快照应包含项目元数据')
    assert.ok(existsSync(join(repo, 'state', 'matrices', `${root.id}.json`)), '快照应包含 matrix 记录')
    assert.ok(existsSync(join(repo, 'state', 'matrices', root.id, 'work', 'note.txt')), '快照应包含 matrix work')
    assert.ok(existsSync(join(repo, 'state', 'sessions', `${project.id}.json`)), '快照应包含项目 dsh 会话事件')
    const projectSession = JSON.parse(readFileSync(join(repo, 'state', 'sessions', `${project.id}.json`), 'utf8'))
    assert.equal(projectSession.event_count, 1)

    // 关键操作自动提交
    await projectUpdate({ data_dir: dir, project_id: project.id, name: 'Git 项目改名' }, deps)
    const afterUpdate = await projectGit({ data_dir: dir, project_id: project.id, action: 'log' }, deps)
    assert.equal(afterUpdate.log[0].subject, '更新项目')

    // 修改工作区后回滚到第一个 checkpoint
    writeFileSync(join(work, 'note.txt'), 'v2', 'utf8')
    const restored = await projectGit({ data_dir: dir, project_id: project.id, action: 'restore', commit: first.result.commit }, deps)
    assert.equal(loadProject(dir, project.id).name, 'Git 项目', '项目名应回到快照值')
    assert.equal(readFileSync(join(work, 'note.txt'), 'utf8'), 'v1', 'matrix work 应回到快照内容')
    assert.ok(loadProject(dir, project.id).dsh_session_id.endsWith('-ck'), '项目会话应由快照重建')
    assert.ok(loadMatrix(dir, root.id).dsh_session_id.endsWith('-ck'), 'matrix 会话应由快照重建')
    assert.ok(seeded.length >= 2, '项目与 matrix 会话都应从快照重建')
    assert.ok(loadProject(dir, project.id).oplog.some(entry => entry.action === 'git_restore'))
    assert.ok(restored.log[0].subject.startsWith('restore checkpoint'), '恢复后应自动生成 restore checkpoint')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('领域 P1-P3：领域/元素/记忆、会话层级与元素唯一根 matrix', async () => {
  const dir = tempDir('domain-core')
  const { deps: base } = makeDeps()
  const mirrors = []
  const deps = {
    ...base,
    sessionMirror: async args => {
      mirrors.push(args)
      return { session_id: args.sessionId, path: args.workspace }
    },
    matrixChat: async () => {},
  }
  try {
    const project = await projectCreate({ data_dir: dir, name: '领域项目' }, deps)
    const domain = await domainCreate({
      data_dir: dir,
      project_id: project.id,
      name: '订单履约',
      brief: '管理订单与库存预留',
      ubiquitous_language: ['订单', '库存预留'],
    }, deps)
    assert.ok(loadProject(dir, project.id).domain_ids.includes(domain.id))
    const projectMirror = mirrors.find(item => item.sessionId === project.id)
    const domainMirror = mirrors.find(item => item.sessionId === domain.id)
    assert.equal(domainMirror.parentSessionId, project.id, '领域会话应挂到项目会话下')
    assert.equal(domainMirror.workspace, projectMirror.workspace, '同属一个 workspace 才能嵌套')
    assert.ok(domainMirror.brief.includes('限界上下文'))
    assert.equal(domainList({ data_dir: dir, project_id: project.id }).total, 1)

    await domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'model',
      element: {
        name: 'Order',
        type: 'persistence',
        kind: 'entity',
        description: '订单持久化模型',
        attributes: [{ name: 'orderId', type: 'string', required: true }],
        invariants: ['金额必须大于 0'],
      },
    }, deps)
    await domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'model',
      element: { name: 'PlaceOrderRequest', type: 'request', kind: 'entity' },
    }, deps)
    await domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'model',
      element: { name: 'OrderResponse', type: 'response' },
    }, deps)
    let withElements = await domainGet({ data_dir: dir, domain_id: domain.id }, deps)
    const persistenceModel = withElements.models.find(item => item.name === 'Order')
    const model = withElements.models.find(item => item.name === 'PlaceOrderRequest')
    const responseModel = withElements.models.find(item => item.name === 'OrderResponse')
    assert.equal(model.kind, 'dto', 'request/response 的 kind 必须固定为 dto')
    assert.equal(responseModel.kind, 'dto')

    await assert.rejects(domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'stub',
      element: {
        name: 'InvalidInventoryPort',
        operations: [{ name: 'reserve', request_model_ids: [persistenceModel.id], response_model_ids: [] }],
      },
    }, deps), /只能引用 type=request/)
    await domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'stub',
      element: {
        name: 'InventoryPort',
        kind: 'domain_service',
        description: '库存预留端口',
        operations: [{ name: 'reserve', request_model_ids: [model.id], response_model_ids: [responseModel.id] }],
      },
    }, deps)
    withElements = await domainGet({ data_dir: dir, domain_id: domain.id }, deps)
    const stub = withElements.stubs[0]

    await assert.rejects(domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'interact',
      element: { name: 'PlaceOrder', request_model_ids: ['mdl_missing'], stub_ids: [stub.id] },
    }, deps), /不存在的 model/)
    await assert.rejects(domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'interact',
      element: { name: 'PlaceOrder', request_model_ids: [persistenceModel.id], stub_ids: [stub.id] },
    }, deps), /禁止 persistence/)

    await domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'interact',
      element: {
        name: 'PlaceOrder',
        kind: 'use_case',
        actors: ['Customer'],
        request_model_ids: [model.id],
        response_model_ids: [responseModel.id],
        stub_ids: [stub.id],
        preconditions: ['购物车非空'],
        main_flow: ['校验订单', '创建订单', '预留库存'],
      },
    }, deps)
    const withInteract = await domainGet({ data_dir: dir, domain_id: domain.id }, deps)
    assert.equal(withInteract.interacts.length, 1)
    const interact = withInteract.interacts[0]
    assert.deepEqual(interact.contract_errors, [])

    const created = await domainMatrixIntake({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'interact',
      element_id: interact.id,
    }, deps)
    const matrixId = created.created_matrix_id
    assert.ok(matrixId)
    const matrix = loadMatrix(dir, matrixId)
    assert.deepEqual(matrix.domain_binding, { domain_id: domain.id, element_type: 'interact', element_id: interact.id })
    assert.ok(mirrors.some(item => item.sessionId === matrixId && item.parentSessionId === domain.id), '元素根 matrix 会话应挂到领域会话下')
    const after = await domainGet({ data_dir: dir, domain_id: domain.id }, deps)
    assert.equal(after.interacts[0].matrix_id, matrixId)
    assert.equal(after.interacts[0].matrix.id, matrixId)

    await assert.rejects(domainMatrixIntake({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'interact',
      element_id: interact.id,
    }, deps), /已有根 matrix/)
    await assert.rejects(domainElementRemove({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'model',
      element_id: model.id,
    }, deps), /引用/)

    await domainMemory({ data_dir: dir, domain_id: domain.id, action: 'add', text: '库存预留必须幂等' }, deps)
    const withMemory = await domainGet({ data_dir: dir, domain_id: domain.id }, deps)
    assert.equal(withMemory.memory.entries.length, 1)
    assert.ok(existsSync(withMemory.memory.file), '领域记忆应落 DOMAIN_MEMORY.md')
    assert.ok(readFileSync(withMemory.memory.file, 'utf8').includes('幂等'))

    await domainUpdate({ data_dir: dir, domain_id: domain.id, name: '订单履约领域' }, deps)
    assert.equal((await domainGet({ data_dir: dir, domain_id: domain.id }, deps)).name, '订单履约领域')

    // 移动 matrix 出项目时解除领域绑定
    const other = await projectCreate({ data_dir: dir, name: '其它项目' }, deps)
    await moveMatrix({ data_dir: dir, matrix_id: matrixId, target_project_id: other.id }, deps)
    assert.equal((await domainGet({ data_dir: dir, domain_id: domain.id }, deps)).interacts[0].matrix_id, null)
    assert.equal(loadMatrix(dir, matrixId).domain_binding, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('领域语义 P1：旧模型与交互惰性迁移，非法旧契约标记且阻断新 matrix', async () => {
  const dir = tempDir('domain-semantics')
  const { deps } = makeDeps()
  try {
    const project = await projectCreate({ data_dir: dir, name: '迁移项目' }, deps)
    const domain = await domainCreate({ data_dir: dir, project_id: project.id, name: '旧领域' }, deps)
    const file = join(dir, `domain-${domain.id}.json`)
    const record = JSON.parse(readFileSync(file, 'utf8'))
    record.models = [
      { id: 'mdl_old01', name: 'LegacyOrder', kind: 'aggregate', attributes: [], relations: [], invariants: [] },
      { id: 'mdl_req01', name: 'LegacyRequest', type: 'request', kind: 'entity', attributes: [], relations: [], invariants: [] },
    ]
    record.stubs = [{
      id: 'stb_old01', name: 'LegacyPort', kind: 'domain_service', matrix_id: null,
      operations: [{ name: 'reserve', input: { orderId: 'string' }, output: { ok: 'boolean' } }],
    }]
    record.interacts = [{
      id: 'itx_old01', name: 'LegacyPlaceOrder', kind: 'use_case', actors: [],
      model_ids: ['mdl_old01'], stub_ids: ['stb_old01'], matrix_id: null,
    }]
    writeFileSync(file, JSON.stringify(record), 'utf8')

    const migrated = await domainGet({ data_dir: dir, domain_id: domain.id }, deps)
    assert.equal(migrated.models[0].type, 'persistence')
    assert.equal(migrated.models[0].kind, 'entity', 'aggregate 应迁移为 persistence entity')
    assert.equal(migrated.models[1].kind, 'dto')
    assert.deepEqual(migrated.stubs[0].operations[0].request_model_ids, [])
    assert.deepEqual(migrated.stubs[0].operations[0].response_model_ids, [])
    assert.deepEqual(migrated.interacts[0].request_model_ids, ['mdl_old01'])
    assert.equal(migrated.interacts[0].model_ids, undefined)
    assert.match(migrated.interacts[0].contract_errors.join('；'), /persistence/)

    await assert.rejects(domainMatrixIntake({
      data_dir: dir, domain_id: domain.id, kind: 'interact', element_id: 'itx_old01',
    }, deps), /persistence/)
    await assert.rejects(domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'interact',
      element: { id: 'itx_old01', name: 'LegacyPlaceOrder', request_model_ids: ['mdl_old01'], stub_ids: ['stb_old01'] },
    }, deps), /禁止 persistence/)

    // 旧契约待修复不应阻断其它元素的新增与后续惰性落盘。
    await domainElementUpsert({
      data_dir: dir,
      domain_id: domain.id,
      kind: 'model',
      element: { name: 'NewResponse', type: 'response' },
    }, deps)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.models[0].type, 'persistence')
    assert.equal(saved.interacts[0].model_ids, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('领域 P2：persist/stub 策略、生成拒绝与 stub 依赖解析', async () => {
  const dir = tempDir('domain-policy')
  const { deps: base } = makeDeps()
  const deps = {
    ...base,
    sessionMirror: async args => ({ session_id: args.sessionId, path: args.workspace }),
    matrixChat: async () => {},
  }
  let planned = null
  const plannerSystems = []
  deps.skeletonPlanner = async ({ system }) => {
    plannerSystems.push(system)
    return JSON.stringify(planned)
  }
  try {
    const project = await projectCreate({ data_dir: dir, name: '策略项目' }, deps)
    const domain = await domainCreate({ data_dir: dir, project_id: project.id, name: '库存领域' }, deps)
    const element = async (kind, payload) => {
      await domainElementUpsert({ data_dir: dir, domain_id: domain.id, kind, element: payload }, deps)
      return (await domainGet({ data_dir: dir, domain_id: domain.id }, deps))[`${kind}s`]
        .find(item => item.name === payload.name)
    }
    const persistence = await element('model', { name: 'Order', type: 'persistence', kind: 'entity' })
    const request = await element('model', { name: 'OrderRequest', type: 'request' })
    const response = await element('model', { name: 'OrderResponse', type: 'response' })
    const stub = await element('stub', {
      name: 'InventoryPort',
      operations: [{ name: 'reserve', request_model_ids: [request.id], response_model_ids: [response.id] }],
    })
    await element('interact', {
      name: 'PlaceOrder',
      request_model_ids: [request.id],
      response_model_ids: [response.id],
      stub_ids: [stub.id],
    })
    const fresh = await domainGet({ data_dir: dir, domain_id: domain.id }, deps)
    const interact = fresh.interacts[0]

    const matrixOf = async (kind, elementId) => (await domainMatrixIntake({
      data_dir: dir, domain_id: domain.id, kind, element_id: elementId,
    }, deps)).created_matrix_id
    const persistenceMatrix = await matrixOf('model', persistence.id)
    const requestMatrix = await matrixOf('model', request.id)
    const stubMatrix = await matrixOf('stub', stub.id)
    const interactMatrix = await matrixOf('interact', interact.id)

    const skeletonOf = child => normalizeSkeleton({
      entry: { id: 'root', label: 'root', intent: '完成订单', inputs: { orderId: { type: 'string' } }, children: [child] },
    })
    const persistNode = {
      id: 'save_order', type: 'persist', label: '保存订单', intent: '保存订单',
      model_id: persistence.id, operation: 'create',
      inputs: { orderId: 'string' }, outputs: { orderId: 'string', saved: 'boolean' },
    }
    const stubNode = {
      id: 'reserve', type: 'stub', label: '预留库存', intent: '调用库存预留',
      stub_id: stub.id, operation: 'reserve',
      request_model_ids: [request.id], response_model_ids: [response.id],
      inputs: { orderId: 'string' }, outputs: { reserved: 'boolean' },
    }

    assert.throws(() => normalizeSkeleton({
      entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: 'string' }, children: [{ ...persistNode, model_id: 'bad' }] },
    }), /model_id/)
    assert.throws(() => normalizeSkeleton({
      entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: 'string' }, children: [{ ...stubNode, stub_id: 'bad' }] },
    }), /stub_id/)
    const readonly = readonlyDefinition(skeletonOf(stubNode))
    assert.equal(readonly.nodes[0].build_status, 'direct')
    assert.equal(readonly.nodes[0].stub_id, stub.id)

    const contextOf = matrixId => domainContextOf(dir, loadMatrix(dir, matrixId))
    assertDomainSkeleton(contextOf(interactMatrix), skeletonOf(stubNode))
    assertDomainSkeleton(contextOf(stubMatrix), skeletonOf(persistNode))
    assertDomainSkeleton(contextOf(persistenceMatrix), skeletonOf(persistNode))
    assert.throws(() => assertDomainSkeleton(contextOf(interactMatrix), skeletonOf(persistNode)), /不允许在/)
    assert.throws(() => assertDomainSkeleton(contextOf(requestMatrix), skeletonOf(persistNode)), /不允许在/)

    // 生成阶段：interact 根 matrix 出现 persist 被拒绝，合法 stub 通过
    planned = { summary: '持久化订单', skeleton: { entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: { type: 'string' } }, children: [persistNode] } } }
    await assert.rejects(generateDag({ data_dir: dir, matrix_id: interactMatrix }, deps), /不允许在/)
    assert.equal(loadMatrix(dir, interactMatrix).state, STATES.AWAITING_REQUIREMENT)

    // 绕过生成直接写入非法骨架：确认与预构建两个入口同样拒绝
    const invalidSkeleton = normalizeSkeleton({
      entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: 'string' }, children: [persistNode] },
    })
    await updateMatrix(dir, requestMatrix, current => {
      current.skeleton = invalidSkeleton
      current.state = STATES.AWAITING_DAG
    })
    await assert.rejects(confirmDagAction({ data_dir: dir, matrix_id: requestMatrix }, deps), /不允许在/)
    await updateMatrix(dir, requestMatrix, current => { current.state = STATES.AWAITING_PREBUILD })
    await prebuild({ data_dir: dir, matrix_id: requestMatrix }, deps)
    assert.match(String(loadMatrix(dir, requestMatrix).error?.message || ''), /不允许在/)

    planned = { summary: '调用库存能力', skeleton: { entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: { type: 'string' } }, children: [stubNode] } } }
    await generateDag({ data_dir: dir, matrix_id: interactMatrix }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: interactMatrix }, deps)
    await prebuild({ data_dir: dir, matrix_id: interactMatrix }, deps)
    const built = loadMatrix(dir, interactMatrix)
    assert.deepEqual(built.domain_dependencies, [stubMatrix])
    assert.deepEqual(built.stub_refs, { [stub.id]: stubMatrix })
    assert.equal(built.definition.entry.type, 'stub')
    assert.equal(built.definition.entry.matrix_id, stubMatrix)
    assert.equal(built.dag.nodes.find(node => node.id === 'reserve').matrix_id, stubMatrix)

    // persistence model 根 matrix 允许 persist，并直接编译为运行时节点
    planned = { summary: '写入订单', skeleton: { entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: { type: 'string' } }, children: [persistNode] } } }
    await generateDag({ data_dir: dir, matrix_id: persistenceMatrix }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: persistenceMatrix }, deps)
    await prebuild({ data_dir: dir, matrix_id: persistenceMatrix }, deps)
    const persistBuilt = loadMatrix(dir, persistenceMatrix)
    assert.equal(persistBuilt.definition.entry.type, 'persist')
    assert.equal(persistBuilt.definition.entry.model_id, persistence.id)
    assert.equal(persistBuilt.progress.nodes['entry/save_order'], undefined, 'persist 不应进入编码节点')

    assert.ok(plannerSystems.some(system => system.includes('领域绑定上下文')), '骨架提示词应注入领域上下文')
    assert.ok(plannerSystems.some(system => system.includes('persist / stub')), '骨架提示词应说明领域节点类型')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('领域 P3：persist CRUD、stub 执行与 domain_dependencies 门禁', async () => {
  const dir = tempDir('domain-runtime')
  const { deps: base } = makeDeps()
  const deps = {
    ...base,
    sessionMirror: async args => ({ session_id: args.sessionId, path: args.workspace }),
    matrixChat: async () => {},
  }
  let planned = null
  deps.skeletonPlanner = async () => JSON.stringify(planned)
  registerBridge(dir, deps)
  try {
    const project = await projectCreate({ data_dir: dir, name: '运行项目' }, deps)
    const domain = await domainCreate({ data_dir: dir, project_id: project.id, name: '库存领域' }, deps)
    const element = async (kind, payload) => {
      await domainElementUpsert({ data_dir: dir, domain_id: domain.id, kind, element: payload }, deps)
      return (await domainGet({ data_dir: dir, domain_id: domain.id }, deps))[`${kind}s`]
        .find(item => item.name === payload.name)
    }
    const persistence = await element('model', { name: 'Order', type: 'persistence', kind: 'entity' })
    const audit = await element('model', { name: 'OrderAudit', type: 'persistence', kind: 'entity' })
    const request = await element('model', { name: 'OrderRequest', type: 'request' })
    const response = await element('model', { name: 'OrderResponse', type: 'response' })
    const stub = await element('stub', {
      name: 'InventoryPort',
      operations: [{ name: 'reserve', request_model_ids: [request.id], response_model_ids: [response.id] }],
    })
    await element('interact', {
      name: 'PlaceOrder',
      request_model_ids: [request.id],
      response_model_ids: [response.id],
      stub_ids: [stub.id],
    })
    const interact = (await domainGet({ data_dir: dir, domain_id: domain.id }, deps)).interacts[0]
    const matrixOf = async (kind, elementId) => (await domainMatrixIntake({
      data_dir: dir, domain_id: domain.id, kind, element_id: elementId,
    }, deps)).created_matrix_id
    const persistenceMatrix = await matrixOf('model', persistence.id)
    const stubMatrix = await matrixOf('stub', stub.id)
    const interactMatrix = await matrixOf('interact', interact.id)

    const stubNode = {
      id: 'reserve', type: 'stub', label: '预留库存', intent: '调用库存预留',
      stub_id: stub.id, operation: 'reserve',
      request_model_ids: [request.id], response_model_ids: [response.id],
      inputs: { orderId: 'string' }, outputs: { reserved: 'boolean' },
    }
    planned = { summary: '调用库存能力', skeleton: { entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: { type: 'string' } }, children: [stubNode] } } }
    await generateDag({ data_dir: dir, matrix_id: interactMatrix }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: interactMatrix }, deps)
    await prebuild({ data_dir: dir, matrix_id: interactMatrix }, deps)
    assert.equal((await get({ data_dir: dir, matrix_id: interactMatrix }, deps)).state, STATES.AWAITING_CHILDREN)
    await assert.rejects(run({ data_dir: dir, matrix_id: interactMatrix, input: { orderId: 'A1' } }, deps), /awaiting_children/)

    // stub 根 matrix：实现并验收后，依赖它的 interact 才会升级为 runnable
    const stubStep = {
      id: 'reserve_step', type: 'script', label: '预留', intent: '返回预留成功',
      inputs: { orderId: 'string' }, outputs: { reserved: 'boolean' }, complexity: 1,
    }
    planned = { summary: '库存预留实现', skeleton: { entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: { type: 'string' } }, children: [stubStep] } } }
    await generateDag({ data_dir: dir, matrix_id: stubMatrix }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: stubMatrix }, deps)
    await prebuild({ data_dir: dir, matrix_id: stubMatrix }, deps)
    const accepted = await accept({ data_dir: dir, matrix_id: stubMatrix }, deps)
    assert.ok(accepted.upgraded_dependents.includes(interactMatrix))
    assert.equal((await get({ data_dir: dir, matrix_id: interactMatrix }, deps)).state, STATES.RUNNABLE)

    const executed = await run({ data_dir: dir, matrix_id: interactMatrix, input: { orderId: 'A1' } }, deps)
    assert.equal(executed.executed.status, 'completed')
    assert.deepEqual(executed.executed.output, { node: 'reserve_step' })
    assert.ok(loadMatrix(dir, stubMatrix).run_ids.length >= 1, 'stub 根 matrix 应产生子运行')

    // persist：create → get 串联，数据落盘后被后续节点读取
    const saveNode = {
      id: 'save_order', type: 'persist', label: '保存订单', intent: '写入订单',
      model_id: persistence.id, operation: 'create', key: 'orderId',
      inputs: { orderId: 'string', amount: 'number' }, outputs: { orderId: 'string', amount: 'number' },
    }
    const loadNode = {
      id: 'load_order', type: 'persist', label: '读取订单', intent: '读回订单',
      model_id: persistence.id, operation: 'get', key: 'orderId',
      inputs: { orderId: 'string', amount: 'number' }, outputs: { orderId: 'string', amount: 'number' },
    }
    planned = {
      summary: '写入并读取订单',
      skeleton: {
        entry: {
          id: 'root', label: 'root', intent: 'x',
          inputs: { orderId: { type: 'string' }, amount: { type: 'number' } },
          children: [saveNode, loadNode],
        },
      },
    }
    await generateDag({ data_dir: dir, matrix_id: persistenceMatrix }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: persistenceMatrix }, deps)
    await prebuild({ data_dir: dir, matrix_id: persistenceMatrix }, deps)
    const persisted = await run({ data_dir: dir, matrix_id: persistenceMatrix, input: { orderId: 'A1', amount: 10 } }, deps)
    assert.equal(persisted.executed.status, 'completed')
    assert.deepEqual(persisted.executed.output, { orderId: 'A1', amount: 10 })
    const dataFile = join(projectDataDir(dir, project.id), `${persistence.id}.json`)
    const stored = JSON.parse(readFileSync(dataFile, 'utf8'))
    assert.equal(stored.records.length, 1)
    assert.equal(stored.records[0].amount, 10)
    assert.equal(loadMatrix(dir, persistenceMatrix).progress.nodes['entry/save_order'], undefined, 'persist 不进入编码节点')

    // persist 有副作用：同一输入重跑不能被缓存复用，应触发重复键错误
    const duplicated = await run({ data_dir: dir, matrix_id: persistenceMatrix, input: { orderId: 'A1', amount: 10 } }, deps)
    assert.equal(duplicated.executed.status, 'failed')
    assert.match(String(duplicated.executed.error?.message || ''), /记录已存在/)

    // 直接驱动运行时验证 update / list / delete
    const runDir = join(dir, 'persist-runtime')
    mkdirSync(runDir, { recursive: true })
    const nodes = {}
    for (const operation of ['create', 'update', 'get', 'list', 'delete']) {
      nodes[`/${operation}`] = {
        node_id: operation,
        id: operation,
        type: 'persist',
        model_id: audit.id,
        project_id: project.id,
        operation,
        key: 'orderId',
        inputs: { orderId: 'string' },
        outputs: { orderId: 'string' },
      }
    }
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
      version: 1,
      engine: 'node',
      run_id: 'run-persist01',
      matrix_id: 'mx_persist01',
      data_dir: dir,
      project_id: project.id,
      workspace: 'workspace',
      nodes,
    }), 'utf8')
    const runtime = await createRuntime({ runDir })
    assert.equal((await runtime.step('/create', { orderId: 'B1', amount: 20 })).amount, 20)
    await assert.rejects(runtime.step('/create', { orderId: 'B1', amount: 21 }), /记录已存在/)
    assert.equal((await runtime.step('/update', { orderId: 'B1', amount: 30 })).amount, 30)
    assert.equal((await runtime.step('/get', { orderId: 'B1' })).amount, 30)
    assert.equal((await runtime.step('/list', null)).total, 1)
    assert.equal((await runtime.step('/list', { where: { amount: 20 } })).total, 0)
    assert.equal((await runtime.step('/delete', { orderId: 'B1' })).deleted, true)
    assert.equal(await runtime.step('/get', { orderId: 'B1' }), null)
    const auditFile = join(projectDataDir(dir, project.id), `${audit.id}.json`)
    assert.deepEqual(JSON.parse(readFileSync(auditFile, 'utf8')).records, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('领域 P4：导出边界、导入只读、引用保护与版本升级', async () => {
  const dir = tempDir('domain-export')
  const { deps: base } = makeDeps()
  const deps = {
    ...base,
    sessionMirror: async args => ({ session_id: args.sessionId, path: args.workspace }),
    matrixChat: async () => {},
  }
  let planned = null
  deps.skeletonPlanner = async () => JSON.stringify(planned)
  try {
    const project = await projectCreate({ data_dir: dir, name: '能力项目' }, deps)
    const provider = await domainCreate({ data_dir: dir, project_id: project.id, name: '订单能力', brief: '订单与库存' }, deps)
    const consumer = await domainCreate({ data_dir: dir, project_id: project.id, name: '履约能力' }, deps)
    const element = async (domainId, kind, payload) => {
      await domainElementUpsert({ data_dir: dir, domain_id: domainId, kind, element: payload }, deps)
      return (await domainGet({ data_dir: dir, domain_id: domainId }, deps))[`${kind}s`]
        .find(item => item.name === payload.name)
    }
    const providerPersistence = await element(provider.id, 'model', { name: 'Order', type: 'persistence', kind: 'entity' })
    const providerRequest = await element(provider.id, 'model', { name: 'PlaceOrderRequest', type: 'request', attributes: [{ name: 'orderId', type: 'string', required: true }] })
    const providerResponse = await element(provider.id, 'model', { name: 'PlaceOrderResponse', type: 'response' })
    const providerStub = await element(provider.id, 'stub', {
      name: 'InventoryPort',
      operations: [{ name: 'reserve', request_model_ids: [providerRequest.id], response_model_ids: [providerResponse.id] }],
    })
    const providerInteract = await element(provider.id, 'interact', {
      name: 'PlaceOrder',
      request_model_ids: [providerRequest.id],
      response_model_ids: [providerResponse.id],
      stub_ids: [providerStub.id],
    })

    const exported = await domainExportCreate({ data_dir: dir, domain_id: provider.id, name: '订单履约能力' }, deps)
    const pkg1 = exported.export
    assert.equal(pkg1.version, 1)
    assert.equal(pkg1.models.length, 2)
    assert.ok(pkg1.models.every(model => ['request', 'response'].includes(model.type)))
    assert.ok(!pkg1.models.some(model => model.id === providerPersistence.id), '导出不能包含 persistence model')
    assert.equal(pkg1.stubs.length, 1)
    assert.equal(pkg1.interacts, undefined, '导出不能包含 interact')
    assert.equal(pkg1.models[0].matrix_id, undefined, '导出不能包含 matrix 定义')
    assert.equal((await domainExportGet({ data_dir: dir, export_id: pkg1.export_id })).checksum, pkg1.checksum)
    assert.equal(domainExportList({ data_dir: dir, domain_id: provider.id }, deps).exports.length, 1)

    const imported = await domainImportApply({ data_dir: dir, domain_id: consumer.id, export_id: pkg1.export_id }, deps)
    const record = imported.imports[0]
    assert.equal(imported.imports.length, 1)
    const localModels = imported.models.filter(model => model.readonly)
    const localStubs = imported.stubs.filter(stub => stub.readonly)
    assert.equal(localModels.length, 2)
    assert.equal(localStubs.length, 1)
    assert.ok(localModels.every(model => model.origin.export_id === pkg1.export_id && model.origin.version === 1))
    assert.notEqual(localModels[0].id, pkg1.models[0].id, '导入应生成本地 id')
    const localRequest = imported.models.find(model => model.name === 'PlaceOrderRequest')
    const localResponse = imported.models.find(model => model.name === 'PlaceOrderResponse')
    const localStub = imported.stubs.find(stub => stub.name === 'InventoryPort')
    assert.deepEqual(localStub.operations[0].request_model_ids, [localRequest.id])
    assert.deepEqual(localStub.operations[0].response_model_ids, [localResponse.id])

    await assert.rejects(domainElementUpsert({
      data_dir: dir,
      domain_id: consumer.id,
      kind: 'model',
      element: { id: localRequest.id, name: 'PlaceOrderRequest', type: 'request', attributes: [] },
    }, deps), /只读/)
    await assert.rejects(domainElementRemove({
      data_dir: dir, domain_id: consumer.id, kind: 'stub', element_id: localStub.id,
    }, deps), /只读/)

    // 导入后本地 interact 可以直接使用导入 stub
    await domainElementUpsert({
      data_dir: dir,
      domain_id: consumer.id,
      kind: 'interact',
      element: {
        name: 'FulfillOrder',
        request_model_ids: [localRequest.id],
        response_model_ids: [localResponse.id],
        stub_ids: [localStub.id],
      },
    }, deps)
    const localInteract = (await domainGet({ data_dir: dir, domain_id: consumer.id }, deps)).interacts[0]
    const adapterMatrix = (await domainMatrixIntake({
      data_dir: dir, domain_id: consumer.id, kind: 'stub', element_id: localStub.id,
    }, deps)).created_matrix_id
    const interactMatrix = (await domainMatrixIntake({
      data_dir: dir, domain_id: consumer.id, kind: 'interact', element_id: localInteract.id,
    }, deps)).created_matrix_id
    const stubNode = {
      id: 'reserve', type: 'stub', label: '预留库存', intent: '调用导入库存能力',
      stub_id: localStub.id, operation: 'reserve',
      request_model_ids: [localRequest.id], response_model_ids: [localResponse.id],
      inputs: { orderId: 'string' }, outputs: { reserved: 'boolean' },
    }
    planned = { summary: '使用导入能力', skeleton: { entry: { id: 'root', label: 'root', intent: 'x', inputs: { orderId: { type: 'string' } }, children: [stubNode] } } }
    await generateDag({ data_dir: dir, matrix_id: interactMatrix }, deps)
    await confirmDagAction({ data_dir: dir, matrix_id: interactMatrix }, deps)
    await prebuild({ data_dir: dir, matrix_id: interactMatrix }, deps)
    const built = loadMatrix(dir, interactMatrix)
    assert.deepEqual(built.domain_dependencies, [adapterMatrix])
    assert.equal(built.stub_refs[localStub.id], adapterMatrix)

    // 被本地 interact 引用时，移除导入被拒绝
    await assert.rejects(domainImportRemove({
      data_dir: dir, domain_id: consumer.id, import_id: record.id,
    }, deps), /引用|matrix/)

    // provider 升级：新增 operation 并补充 model 属性
    await domainElementUpsert({
      data_dir: dir,
      domain_id: provider.id,
      kind: 'model',
      element: {
        id: providerRequest.id,
        name: 'PlaceOrderRequest',
        type: 'request',
        attributes: [
          { name: 'orderId', type: 'string', required: true },
          { name: 'note', type: 'string' },
        ],
      },
    }, deps)
    await domainElementUpsert({
      data_dir: dir,
      domain_id: provider.id,
      kind: 'stub',
      element: {
        id: providerStub.id,
        name: 'InventoryPort',
        operations: [
          { name: 'reserve', request_model_ids: [providerRequest.id], response_model_ids: [providerResponse.id] },
          { name: 'release', request_model_ids: [providerRequest.id], response_model_ids: [providerResponse.id] },
        ],
      },
    }, deps)
    const pkg2 = (await domainExportCreate({ data_dir: dir, domain_id: provider.id }, deps)).export
    assert.equal(pkg2.version, 2)
    const upgraded = await domainImportUpgrade({ data_dir: dir, domain_id: consumer.id, import_id: record.id }, deps)
    assert.equal(upgraded.upgrade_diff.version_from, 1)
    assert.equal(upgraded.upgrade_diff.version_to, 2)
    assert.ok(upgraded.upgrade_diff.changed_stubs.includes('InventoryPort'))
    assert.ok(upgraded.upgrade_diff.changed_models.includes('PlaceOrderRequest'))
    const localStubAfter = upgraded.stubs.find(stub => stub.name === 'InventoryPort')
    assert.equal(localStubAfter.id, localStub.id, '升级必须保留本地 id')
    assert.equal(localStubAfter.operations.length, 2)
    const localRequestAfter = upgraded.models.find(model => model.name === 'PlaceOrderRequest')
    assert.equal(localRequestAfter.id, localRequest.id)
    assert.equal(localRequestAfter.attributes.length, 2)
    assert.equal(upgraded.imports[0].version, 2)

    // 新版本移除仍被引用的 Stub → 升级被拒绝
    await domainElementRemove({ data_dir: dir, domain_id: provider.id, kind: 'interact', element_id: providerInteract.id }, deps)
    await domainElementRemove({ data_dir: dir, domain_id: provider.id, kind: 'stub', element_id: providerStub.id }, deps)
    const pkg3 = (await domainExportCreate({ data_dir: dir, domain_id: provider.id }, deps)).export
    assert.equal(pkg3.version, 3)
    await assert.rejects(domainImportUpgrade({ data_dir: dir, domain_id: consumer.id, import_id: record.id }, deps), /适配 matrix|仍被引用/)

    // 无引用的导入可以正常移除
    const temp = await domainCreate({ data_dir: dir, project_id: project.id, name: '临时域' }, deps)
    const tempImport = await domainImportApply({ data_dir: dir, domain_id: temp.id, export_id: pkg1.export_id }, deps)
    assert.equal(domainImportList({ data_dir: dir, domain_id: temp.id }, deps).imports.length, 1)
    const removed = await domainImportRemove({ data_dir: dir, domain_id: temp.id, import_id: tempImport.imports[0].id }, deps)
    assert.equal(removed.imports.length, 0)
    assert.equal(removed.models.length, 0)
    assert.equal(removed.stubs.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目 Git checkpoint：导出/导入包随快照恢复', async () => {
  const dir = tempDir('project-git-capability')
  const { deps } = makeDeps()
  try {
    const project = await projectCreate({ data_dir: dir, name: '能力快照项目' }, deps)
    const provider = await domainCreate({ data_dir: dir, project_id: project.id, name: '订单能力' }, deps)
    const consumer = await domainCreate({ data_dir: dir, project_id: project.id, name: '履约能力' }, deps)
    await domainElementUpsert({
      data_dir: dir, domain_id: provider.id, kind: 'model',
      element: { name: 'OrderRequest', type: 'request' },
    }, deps)
    await domainElementUpsert({
      data_dir: dir, domain_id: provider.id, kind: 'stub',
      element: { name: 'InventoryPort', operations: [{ name: 'reserve', request_model_ids: [ (await domainGet({ data_dir: dir, domain_id: provider.id }, deps)).models[0].id ], response_model_ids: [] }] },
    }, deps)
    const pkg = (await domainExportCreate({ data_dir: dir, domain_id: provider.id }, deps)).export
    const imported = await domainImportApply({ data_dir: dir, domain_id: consumer.id, export_id: pkg.export_id }, deps)

    await projectGit({ data_dir: dir, project_id: project.id, action: 'init' }, deps)
    const first = await projectGit({ data_dir: dir, project_id: project.id, action: 'commit', message: 'capability checkpoint' }, deps)
    assert.ok(existsSync(join(projectRepoDir(dir, project.id), 'state', 'exports', `${pkg.export_id}.json`)))
    assert.ok(existsSync(join(projectRepoDir(dir, project.id), 'state', 'imports', `${pkg.export_id}.json`)))

    rmSync(join(dir, 'registry', 'domain-exports', `${pkg.export_id}.json`), { force: true })
    await projectGit({ data_dir: dir, project_id: project.id, action: 'restore', commit: first.result.commit }, deps)
    assert.ok(existsSync(exportFile(dir, pkg.export_id)), '恢复后 registry 导出包应存在')
    assert.equal((await domainGet({ data_dir: dir, domain_id: consumer.id }, deps)).imports.length, 1)
    assert.ok(imported.imports[0].model_map, '导入关系应保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目 Git checkpoint：persist 数据随 state/data 快照恢复', async () => {
  const dir = tempDir('project-git-data')
  const { deps } = makeDeps()
  try {
    const project = await projectCreate({ data_dir: dir, name: '数据快照项目' }, deps)
    const dataDir = projectDataDir(dir, project.id)
    mkdirSync(dataDir, { recursive: true })
    const file = join(dataDir, 'mdl_snapshot01.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      model_id: 'mdl_snapshot01',
      records: [{ orderId: 'C1', amount: 10 }],
    }), 'utf8')

    await projectGit({ data_dir: dir, project_id: project.id, action: 'init' }, deps)
    const first = await projectGit({ data_dir: dir, project_id: project.id, action: 'commit', message: 'data checkpoint' }, deps)
    assert.ok(existsSync(join(projectRepoDir(dir, project.id), 'state', 'data', 'mdl_snapshot01.json')), '快照应包含 state/data')

    writeFileSync(file, JSON.stringify({
      version: 1,
      model_id: 'mdl_snapshot01',
      records: [{ orderId: 'C1', amount: 99 }],
    }), 'utf8')
    await projectGit({ data_dir: dir, project_id: project.id, action: 'restore', commit: first.result.commit }, deps)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).records[0].amount, 10, 'persist 数据应随快照恢复')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目 Git checkpoint：领域记录、领域会话与 DOMAIN_MEMORY.md 随快照恢复', async () => {
  const dir = tempDir('project-git-domain')
  const { deps: base } = makeDeps()
  const deps = {
    ...base,
    sessionMirror: async args => ({ session_id: args.sessionId, path: args.workspace }),
    matrixChat: async () => {},
    sessionEvents: async ({ sessionId }) => ({
      events: [{
        seq: 0,
        type: 'user/message',
        time: Date.now(),
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `hello ${sessionId}` }] },
      }],
      cursor: 1,
    }),
    sessionSeed: async ({ sessionId }) => ({ session_id: `${sessionId}-ck` }),
  }
  try {
    const project = await projectCreate({ data_dir: dir, name: '领域 Git 项目' }, deps)
    const domain = await domainCreate({ data_dir: dir, project_id: project.id, name: '原始领域', brief: '领域目标' }, deps)
    await domainMemory({ data_dir: dir, domain_id: domain.id, action: 'add', text: '核心不变量：金额 > 0' }, deps)

    await projectGit({ data_dir: dir, project_id: project.id, action: 'init' }, deps)
    const first = await projectGit({ data_dir: dir, project_id: project.id, action: 'commit', message: 'domain checkpoint' }, deps)
    assert.ok(first.result.commit)

    const repo = projectRepoDir(dir, project.id)
    assert.ok(existsSync(join(repo, 'state', 'domains', `${domain.id}.json`)), '快照应包含领域记录')
    assert.ok(existsSync(join(repo, 'state', 'sessions', `${domain.id}.json`)), '快照应包含领域会话事件')

    await domainUpdate({ data_dir: dir, project_id: project.id, domain_id: domain.id, name: '改名领域' }, deps)
    const restored = await projectGit({ data_dir: dir, project_id: project.id, action: 'restore', commit: first.result.commit }, deps)
    const after = await domainGet({ data_dir: dir, domain_id: domain.id }, deps)
    assert.equal(after.name, '原始领域', '领域记录应回到快照值')
    assert.ok(after.dsh_session_id.endsWith('-ck'), '领域会话应由快照重建')
    assert.equal(after.parent_session_id, loadProject(dir, project.id).dsh_session_id, '领域会话应挂到恢复后的项目会话')
    assert.ok(existsSync(after.memory.file), 'DOMAIN_MEMORY.md 应随 work 恢复')
    assert.ok(readFileSync(after.memory.file, 'utf8').includes('金额 > 0'))
    assert.equal(restored.result.domains, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目排序：按最近打开时间倒序', async () => {
  const dir = tempDir('project-order')
  const deps = { sessionMirror: async args => ({ session_id: args.sessionId, path: args.workspace }) }
  try {
    const first = await projectCreate({ data_dir: dir, name: '项目一' }, deps)
    const second = await projectCreate({ data_dir: dir, name: '项目二' }, deps)
    // 固定时间，避免同毫秒创建造成的排序抖动
    const one = loadProject(dir, first.id)
    one.last_opened_at = '2026-01-01T00:00:00.000Z'
    saveProject(dir, one)
    const two = loadProject(dir, second.id)
    two.last_opened_at = '2026-02-01T00:00:00.000Z'
    saveProject(dir, two)
    assert.deepEqual(projectList({ data_dir: dir }).projects.map(project => project.id), [second.id, first.id])

    const opened = await projectOpen({ data_dir: dir, project_id: first.id }, deps)
    assert.ok(opened.last_opened_at > '2026-02-01', '打开项目应刷新最近打开时间')
    assert.deepEqual(projectList({ data_dir: dir }).projects.map(project => project.id), [first.id, second.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目 P6：根 matrix 移动与归档（子树跟随、活跃视图过滤）', async () => {
  const dir = tempDir('project-move-archive')
  const { deps } = makeDeps()
  try {
    const source = await projectCreate({ data_dir: dir, name: '源项目' }, deps)
    const target = await projectCreate({ data_dir: dir, name: '目标项目' }, deps)
    const root = await intake({ data_dir: dir, task: '移动用根 matrix', project_id: source.id }, deps)
    const child = await intake({ data_dir: dir, task: '移动用子 matrix', parent_id: root.id }, deps)

    const moved = await moveMatrix({ data_dir: dir, matrix_id: root.id, target_project_id: target.id }, deps)
    assert.equal(moved.from_project_id, source.id)
    assert.equal(moved.to_project_id, target.id)
    assert.deepEqual(loadProject(dir, source.id).root_matrix_ids, [])
    assert.deepEqual(loadProject(dir, target.id).root_matrix_ids, [root.id])
    assert.equal(loadMatrix(dir, root.id).project_id, target.id)
    assert.equal(loadMatrix(dir, child.id).project_id, target.id, '子树应跟随根一起移动')
    assert.ok(loadProject(dir, source.id).oplog.some(entry => entry.action === 'matrix_move'))
    assert.ok(loadProject(dir, target.id).oplog.some(entry => entry.action === 'matrix_move_in'))
    assert.equal(projectTree({ data_dir: dir, project_id: source.id }).roots.length, 0)
    assert.equal(projectTree({ data_dir: dir, project_id: target.id }).roots.length, 1)

    // 子 matrix 不能单独移动
    await assert.rejects(
      moveMatrix({ data_dir: dir, matrix_id: child.id, target_project_id: source.id }, deps),
      /根 matrix/,
    )

    await archiveMatrix({ data_dir: dir, matrix_id: root.id })
    assert.ok(loadProject(dir, target.id).oplog.some(entry => entry.action === 'matrix_archive'))
    const archivedDetail = await projectGet({ data_dir: dir, project_id: target.id }, deps)
    assert.equal(archivedDetail.roots.length, 0)
    assert.equal(archivedDetail.archived_roots.length, 1)
    assert.equal(archivedDetail.stats.archived_roots, 1)
    // 活跃视图默认不显示归档树
    assert.equal(tree({ data_dir: dir, project_id: target.id }).roots.length, 0)
    assert.equal(tree({ data_dir: dir, project_id: target.id, include_archived: true }).roots.length, 1)
    assert.equal(list({ data_dir: dir, project_id: target.id }).total, 0)
    assert.equal(list({ data_dir: dir, project_id: target.id, include_archived: true }).total, 2)
    assert.equal(projectNav({ data_dir: dir, project_id: target.id }).next, null)
    assert.equal((await projectRunRunnable({ data_dir: dir, project_id: target.id }, deps)).ran, 0)

    // 恢复后回到活跃视图
    await archiveMatrix({ data_dir: dir, matrix_id: root.id, archived: false })
    assert.equal((await projectGet({ data_dir: dir, project_id: target.id }, deps)).roots.length, 1)
    assert.equal(tree({ data_dir: dir, project_id: target.id }).roots.length, 1)
    assert.equal(list({ data_dir: dir, project_id: target.id }).total, 2)

    // 移动到已归档项目会被拒绝
    await projectArchive({ data_dir: dir, project_id: source.id }, deps)
    await assert.rejects(
      moveMatrix({ data_dir: dir, matrix_id: root.id, target_project_id: source.id }, deps),
      /已归档/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
