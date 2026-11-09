import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptBuild, answerBuild, answerFlow, configureWorkspace, confirmBuildDag, confirmFlow, defineFlow, evaluateFlow, getBuild, getFlow, getSession,
  getSessionRuns, inboxMail, instructFlow, intakeFlow, invokeFlow, listDefinitions, listFlow, listSessionGroups,
  listSessionTree, planFlow, prebuildFlow, replyMail, resumeFlow, retryBuild, reviseFlow, runBuild, sendMail, sessionMail, startBuild, startBuildSession, startFlow,
  stepBuild,
} from '../lib/service.mjs'
import { planDefinition } from '../lib/ai.mjs'
import { createLlmExecutor } from '../lib/llm.mjs'
import { loadBuild, loadBuildStack } from '../lib/store.mjs'
import { createPanelHandler, startPanel, stopPanel } from '../lib/panel.mjs'
import { configure as configureHost } from '../plugin.mjs'
import { apply as applyDshHost, inject as dshHostInject } from '../dsh/host.mjs'

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rms-flow-runner-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// 人工门禁：逐个确认启动 awaiting_start、确认骨架 DAG awaiting_dag、确认验收 awaiting_accept，直到没有门禁为止
async function passBuildGates(dataDir, deps, rootSessionId) {
  for (let guard = 0; guard < 60; guard += 1) {
    // 按构建文件的实际状态找门禁：awaiting_confirm 只有子条目需要验收，根条目到该状态即结束
    const liveStatus = (entry) => {
      const build = entry.session_id ? loadBuild(dataDir, entry.session_id) : null
      return build ? build.status : entry.status
    }
    const gate = (loadBuildStack(dataDir, rootSessionId)?.entries || [])
      .map(entry => ({ entry, status: liveStatus(entry) }))
      .find(({ entry, status }) => entry.session_id && (
        ['awaiting_start', 'awaiting_dag'].includes(status)
        || (status === 'awaiting_confirm' && entry.depth > 0)
      ))
    if (!gate) return
    if (gate.status === 'awaiting_start') {
      await startBuildSession({ data_dir: dataDir, session_id: gate.entry.session_id }, deps)
    } else if (gate.status === 'awaiting_dag') {
      await confirmBuildDag({ data_dir: dataDir, session_id: gate.entry.session_id }, deps)
    } else {
      await acceptBuild({ data_dir: dataDir, session_id: gate.entry.session_id }, deps)
    }
  }
  throw new Error('构建门禁推进超过上限')
}

function det(id, expr, extra = {}) {
  return { id, type: 'det', op: 'expr', expr, ...extra }
}

test('fold、branch 与 loop 均由 Det 节点确定性推进', async t => {
  const dataDir = workspace(t)
  const folded = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-fold',
    definition: {
      version: 1,
      entry: {
        id: 'root', type: 'sequence', steps: [
          {
            id: 'sum', type: 'fold', items: { var: 'values' }, initial: 0,
            body: det('add', { '+': [{ var: 'acc' }, { var: 'item' }] }),
          },
          {
            id: 'route', type: 'branch', condition: { '<=': [{ var: '' }, 5] },
            then: { id: 'small', type: 'det', op: 'literal', value: 'small' },
            else: { id: 'large', type: 'det', op: 'literal', value: 'large' },
          },
        ],
      },
    },
    input: { values: [1, 2, 3] },
  })
  assert.equal(folded.status, 'completed')
  assert.equal(folded.output, 'large')
  assert.equal(folded.trace.find(step => step.node_id === 'sum').details.iterations, 3)

  const looped = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-loop',
    definition: {
      version: 1,
      entry: {
        id: 'repeat', type: 'loop', while: { '<': [{ var: 'count' }, 3] }, max_iterations: 5,
        body: det('increment', { count: { '+': [{ var: 'count' }, 1] } }),
      },
    },
    input: { count: 0 },
  })
  assert.equal(looped.status, 'completed')
  assert.deepEqual(looped.output, { count: 3 })
  assert.equal(looped.trace.filter(step => step.node_id === 'increment').length, 3)
})

test('or_else 把节点失败转为可恢复值，fuel 负责终止失控循环', async t => {
  const dataDir = workspace(t)
  const recovered = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-recovery',
    definition: {
      version: 1,
      entry: {
        id: 'recover', type: 'or_else',
        primary: { id: 'validate', type: 'det', op: 'assert', condition: false, message: '校验未通过' },
        fallback: { id: 'fallback', type: 'det', op: 'literal', value: { recovered: true } },
      },
    },
  })
  assert.equal(recovered.status, 'completed')
  assert.deepEqual(recovered.output, { recovered: true })
  assert.equal(recovered.trace.find(step => step.node_id === 'validate').status, 'failed')
  assert.equal(recovered.trace.find(step => step.node_id === 'recover').details.recovered_from.message, '校验未通过')

  const exhausted = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-fuel',
    fuel: 3,
    definition: {
      version: 1,
      entry: {
        id: 'forever', type: 'loop', while: true,
        body: det('same', { var: '' }),
      },
    },
    input: { value: 1 },
  })
  assert.equal(exhausted.status, 'failed')
  assert.match(exhausted.error.message, /fuel/)
})

test('人工挂起恢复重放轨迹，已完成 gen/choose 不重复调用', async t => {
  const dataDir = workspace(t)
  let llmCalls = 0
  const llm = {
    async complete({ system }) {
      llmCalls += 1
      return system.includes('choose')
        ? { content: JSON.stringify({ choice: 'fast' }), model: 'mock-choose' }
        : { content: JSON.stringify({ prepared: true }), model: 'mock-gen' }
    },
  }
  const definition = {
    version: 1,
    name: '清盘现场验证（只读示例）',
    entry: {
      id: 'root', type: 'sequence', steps: [
        { id: 'prepare', type: 'llm', mode: 'gen', prompt: '准备只读排查上下文' },
        {
          id: 'route', type: 'llm', mode: 'choose', prompt: '选择只读验证路径',
          options: [
            { id: 'fast', label: '现场验证', value: { path: 'onsite' } },
            { id: 'slow', label: '历史追溯', value: { path: 'history' } },
          ],
        },
        { id: 'login', type: 'human', label: '扫码登录', prompt: '请在本机扫码登录 RMS，完成后注入确认结果' },
        det('result', { approved: { var: 'confirmed' } }),
      ],
    },
  }
  const waiting = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-clearance',
    definition,
  }, { llm })
  assert.equal(waiting.status, 'waiting_human')
  assert.equal(waiting.pending.node_id, 'login')
  assert.equal(llmCalls, 2)
  assert.equal(getFlow({ data_dir: dataDir, run_id: waiting.id }).trace.find(step => step.node_id === 'login').status, 'waiting_human')
  const groups = listFlow({ data_dir: dataDir, parent_session_id: 'decision-clearance' })
  assert.equal(groups.groups[0].runs[0].current.node_id, 'login')

  const completed = await resumeFlow({
    data_dir: dataDir,
    run_id: waiting.id,
    input: { confirmed: true },
  }, { llm })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { approved: true })
  assert.equal(llmCalls, 2, '恢复时不能重复调用已经完成的 LLM 节点')
  assert.deepEqual(completed.trace.find(step => step.node_id === 'login').output, { confirmed: true })
  await assert.rejects(() => resumeFlow({ data_dir: dataDir, run_id: waiting.id, input: {} }, { llm }), /不是等待人工输入/)
})

test('本地面板展示会话组、步骤输入输出，并可提交人工恢复', async t => {
  const dataDir = workspace(t)
  t.after(() => stopPanel())
  const waiting = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-panel',
    name: '面板人工节点示例',
    definition: {
      version: 1,
      entry: {
        id: 'root', type: 'sequence', steps: [
          det('read', { visible: { var: 'visible' } }),
          { id: 'confirm', type: 'human', prompt: '确认只读复现结果' },
        ],
      },
    },
    input: { visible: false },
  })
  assert.equal(waiting.status, 'waiting_human')

  const panel = await startPanel({ data_dir: dataDir, port: 0 })
  const html = await (await fetch(panel.url)).text()
  assert.match(html, /工作流会话组/)
  assert.match(html, /id="def-modal"/)
  assert.match(html, /data-step-def/)
  assert.match(html, /data-dag-def/)
  assert.match(html, /id="invoke-form"/)
  assert.match(html, /入口契约/)
  assert.match(html, /dag-runtime/)
  assert.match(html, /nodeRuntime/)
  assert.match(html, /data-tree-toggle/)
  assert.match(html, /data-open-run/)
  assert.match(html, /data-open-session/)
  const list = await (await fetch(`${panel.url}/api/runs`)).json()
  assert.equal(list.groups[0].runs[0].id, waiting.id)
  const detail = await (await fetch(`${panel.url}/api/runs/${waiting.id}`)).json()
  assert.equal(detail.trace.find(step => step.node_id === 'read').input.visible, false)

  const resumed = await (await fetch(`${panel.url}/api/runs/${waiting.id}?action=resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { confirmed: true } }),
  })).json()
  assert.equal(resumed.status, 'completed')
  assert.deepEqual(resumed.output, { confirmed: true })

  const invoked = await (await fetch(`${panel.url}/api/runs/${waiting.id}?action=invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { visible: true } }),
  })).json()
  assert.equal(invoked.status, 'waiting_human')
  assert.equal(invoked.previous_run_id, waiting.id)
  assert.deepEqual(invoked.invoked_from, { run_id: waiting.id, definition_version: 1 })
})

test('面板处理器可挂到宿主路由前缀下（dsh 常驻 /flow-runner）', async t => {
  const dataDir = workspace(t)
  const server = createServer(createPanelHandler({ data_dir: dataDir, prefix: '/flow-runner' }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

  const redirect = await fetch(`${base}/flow-runner`, { redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), '/flow-runner/')

  const html = await (await fetch(`${base}/flow-runner/`)).text()
  assert.match(html, /工作流会话组/)
  const health = await (await fetch(`${base}/flow-runner/api/health`)).json()
  assert.equal(health.service, 'rms-flow-runner')

  // 前缀外的路径不能被面板接管
  assert.equal((await fetch(`${base}/api/health`)).status, 404)
})

test('规划器修复 JSON、过滤经验引用，确认前不执行任何节点', async t => {
  const dataDir = workspace(t)
  let plannerCalls = 0
  const definition = {
    version: 1, name: '规划确认测试',
    entry: { id: 'done', type: 'det', op: 'literal', value: { ok: true } },
  }
  const llm = {
    async complete({ system }) {
      if (system.includes('工作流规划器')) {
        plannerCalls += 1
        if (plannerCalls === 1) return { content: '不是 JSON' }
        return { content: JSON.stringify({
          summary: '单节点确定性流程', definition, input: { source: 1 }, citations: ['exp-1', 'fabricated'],
        }) }
      }
      return { content: JSON.stringify({ conclusion: '完成状态正常', actions: [] }) }
    },
  }
  const retrieveExperience = async () => ({
    status: 'ok', query: '测试', fallback: false,
    entries: [{ id: 'exp-1', title: '历史经验', content: '先规划再执行', snippet: '' }],
  })
  const draft = await planFlow({
    data_dir: dataDir, parent_session_id: 'decision-plan', task: '生成一个只读流程',
  }, { llm, retrieveExperience })
  assert.equal(draft.status, 'draft')
  assert.equal(draft.trace.length, 0)
  assert.equal(plannerCalls, 2)
  assert.deepEqual(draft.planner.citations, ['exp-1'])
  assert.equal(draft.pending_actions[0].type, 'start')
  assert.equal(getFlow({ data_dir: dataDir, run_id: draft.id }).trace.length, 0)

  const completed = await confirmFlow({
    data_dir: dataDir, run_id: draft.id, action_id: draft.pending_actions[0].id, approved: true,
  }, { llm, retrieveExperience })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { ok: true })
  assert.equal(completed.pending_actions[0].status, 'confirmed')
  assert.equal(completed.supervision.last_mode, 'automatic')
  const session = getSessionRuns({ data_dir: dataDir, parent_session_id: 'decision-plan' })
  assert.ok(session.messages.some(message => message.role === 'supervisor'))
  assert.ok(session.messages.every(message => message.run_id === draft.id && message.definition_version === 1))
  assert.ok(session.actions.every(action => action.run_id === draft.id))
})

test('澄清与规划提示词携带平台能力，不再追问外部技术栈', async t => {
  const systems = []
  const definition = { version: 1, entry: { id: 'leaf', type: 'det', op: 'literal', value: 1 } }
  const llm = {
    async complete({ system }) {
      systems.push(system)
      if (system.includes('需求分析员')) {
        return { content: JSON.stringify({ sufficient: true, missing: [], questions: [], assumptions: [] }) }
      }
      return { content: JSON.stringify({ summary: '平台内实现', definition, input: null, acceptance_criteria: ['最终输出整数'], citations: [] }) }
    },
  }
  const view = await intakeFlow({
    data_dir: workspace(t),
    parent_session_id: 'decision-platform',
    task: '在当前平台做一个嵌套十层的子流程，叶子返回 1，逐层返回子结果加 1',
  }, {
    llm,
    retrieveExperience: async () => ({ status: 'ok', query: '嵌套子流程', fallback: false, entries: [] }),
  })
  assert.equal(view.session.status, 'awaiting_confirm')
  const analyst = systems.find(system => system.includes('需求分析员'))
  const planner = systems.find(system => system.includes('工作流规划器'))
  assert.match(analyst, /rms-flow-runner/)
  assert.match(analyst, /RMS_FLOW_SUBFLOW_MAX_DEPTH/)
  assert.match(analyst, /默认 16/)
  assert.match(analyst, /不要问“用什么平台\/技术栈”/)
  assert.match(planner, /rms-flow-runner/)
  assert.match(planner, /recursion:true/)
  assert.match(planner, /只规划第 1 层/)
})

test('经验检索为空或降级不阻塞规划，持续非法输出只保存 plan_failed', async t => {
  const definition = {
    version: 1,
    entry: { id: 'done', type: 'det', op: 'literal', value: true },
  }
  for (const status of ['empty', 'degraded']) {
    const result = await planDefinition({ task: `测试 ${status}` }, {
      retrieveExperience: async () => ({ status, query: '测试', fallback: false, entries: [], error: status === 'degraded' ? '索引不可用' : null }),
      llm: { async complete() { return { content: JSON.stringify({ summary: '可用草稿', definition, input: null, citations: [] }) } } },
    })
    assert.equal(result.definition.entry.id, 'done')
    assert.equal(result.retrieval.status, status)
  }

  const dataDir = workspace(t)
  let calls = 0
  const failed = await planFlow({
    data_dir: dataDir, parent_session_id: 'decision-plan-failed', task: '无法规划的流程',
  }, {
    retrieveExperience: async () => ({ status: 'empty', query: '测试', fallback: false, entries: [] }),
    llm: { async complete() { calls += 1; return { content: '{bad json' } } },
  })
  assert.equal(failed.status, 'plan_failed')
  assert.equal(failed.definition, null)
  assert.equal(failed.trace.length, 0)
  assert.equal(failed.pending_actions.length, 0)
  assert.equal(calls, 2)
})

test('监督只创建待确认建议，支持拒绝、暂停恢复、过期保护和终止', async t => {
  const dataDir = workspace(t)
  const definition = {
    version: 1,
    entry: { id: 'approve', type: 'human', prompt: '请确认业务结果' },
  }
  const supervisorLlm = type => ({
    async complete() {
      return { content: JSON.stringify({ conclusion: `建议 ${type}`, actions: [{ type, reason: '测试监督动作' }] }) }
    },
  })
  const waiting = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-supervision', name: '暂停恢复', definition,
  })
  const beforeTrace = structuredClone(waiting.trace)
  const suggested = await instructFlow({
    data_dir: dataDir, run_id: waiting.id, instruction: '检查是否需要暂停',
  }, { llm: supervisorLlm('pause') })
  const first = suggested.pending_actions[0]
  assert.equal(suggested.status, 'waiting_human')
  assert.equal(first.status, 'pending')
  assert.deepEqual(suggested.trace, beforeTrace)
  const rejected = await confirmFlow({
    data_dir: dataDir, run_id: waiting.id, action_id: first.id, approved: false,
  })
  assert.equal(rejected.status, 'waiting_human')
  assert.equal(rejected.pending_actions[0].status, 'rejected')

  const suggestedAgain = await instructFlow({
    data_dir: dataDir, run_id: waiting.id, instruction: '再次检查',
  }, { llm: supervisorLlm('pause') })
  const second = suggestedAgain.pending_actions[1]
  const paused = await confirmFlow({
    data_dir: dataDir, run_id: waiting.id, action_id: second.id, approved: true,
  })
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pending.node_id, 'approve')
  const completed = await resumeFlow({
    data_dir: dataDir, run_id: waiting.id, input: { confirmed: true },
  }, { llm: supervisorLlm('pause') })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { confirmed: true })

  const staleRun = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-stale', name: '过期动作', definition,
  })
  const staleSuggestion = await instructFlow({
    data_dir: dataDir, run_id: staleRun.id, instruction: '建议暂停',
  }, { llm: supervisorLlm('pause') })
  const staleAction = staleSuggestion.pending_actions[0]
  await resumeFlow({ data_dir: dataDir, run_id: staleRun.id, input: { done: true } }, { llm: supervisorLlm('pause') })
  await assert.rejects(() => confirmFlow({
    data_dir: dataDir, run_id: staleRun.id, action_id: staleAction.id, approved: true,
  }), /动作已过期/)
  assert.equal(getFlow({ data_dir: dataDir, run_id: staleRun.id }).pending_actions[0].status, 'stale')

  const terminateRun = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-terminate', name: '终止', definition,
  })
  const terminateSuggestion = await instructFlow({
    data_dir: dataDir, run_id: terminateRun.id, instruction: '建议终止',
  }, { llm: supervisorLlm('terminate') })
  const cancelled = await confirmFlow({
    data_dir: dataDir, run_id: terminateRun.id,
    action_id: terminateSuggestion.pending_actions[0].id, approved: true,
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.pending, null)
  assert.equal(cancelled.current, null)
  assert.ok(cancelled.trace.length > 0)
  await assert.rejects(() => resumeFlow({ data_dir: dataDir, run_id: cancelled.id, input: {} }), /不是等待人工输入或暂停状态/)
})

test('重规划生成不可变旧版本，并只复用节点哈希与 Cin 均兼容的缓存', async t => {
  const dataDir = workspace(t)
  const prepare = { id: 'prepare', type: 'llm', mode: 'gen', prompt: '准备数据', output: 'json' }
  const initial = {
    version: 1, name: '安全重规划',
    entry: { id: 'root', type: 'sequence', steps: [
      prepare,
      { id: 'review', type: 'human', prompt: '人工复核' },
      { id: 'finish', type: 'det', op: 'expr', expr: { accepted: { var: 'confirmed' } } },
    ] },
  }
  const replanned = {
    version: 1, name: '安全重规划',
    entry: { id: 'root', type: 'sequence', steps: [
      prepare,
      { id: 'finish', type: 'det', op: 'expr', expr: { replanned: { var: 'prepared' } } },
    ] },
  }
  let nodeCalls = 0
  const llm = {
    async complete({ system, user }) {
      if (system.includes('工作流规划器')) {
        return { content: JSON.stringify({ summary: '去除人工复核', definition: replanned, input: { source: 1 }, citations: [] }) }
      }
      if (system.includes('监督分析员')) {
        const payload = JSON.parse(user)
        return { content: JSON.stringify({
          conclusion: payload.instruction ? '需要调整流程' : '新版本已完成',
          actions: payload.instruction ? [{ type: 'replan', reason: '简化流程', instruction: '去除人工复核' }] : [],
        }) }
      }
      nodeCalls += 1
      return { content: JSON.stringify({ prepared: true }) }
    },
  }
  const retrieveExperience = async () => ({ status: 'empty', query: '重规划', fallback: false, entries: [] })
  const waiting = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-replan', definition: initial, input: { source: 1 },
  }, { llm })
  assert.equal(waiting.status, 'waiting_human')
  assert.equal(nodeCalls, 1)
  const oldTrace = structuredClone(waiting.trace)
  const suggested = await instructFlow({
    data_dir: dataDir, run_id: waiting.id, instruction: '请去掉人工复核',
  }, { llm, retrieveExperience })
  const action = suggested.pending_actions.find(item => item.type === 'replan')
  assert.equal(action.status, 'pending')
  assert.equal(action.draft.definition.entry.steps.length, 2)
  assert.equal(getFlow({ data_dir: dataDir, run_id: waiting.id }).status, 'waiting_human')

  const next = await confirmFlow({
    data_dir: dataDir, run_id: waiting.id, action_id: action.id, approved: true,
  }, { llm, retrieveExperience })
  assert.equal(next.status, 'completed')
  assert.equal(next.definition_version, 2)
  assert.equal(next.previous_run_id, waiting.id)
  assert.deepEqual(next.output, { replanned: true })
  assert.equal(nodeCalls, 1, '兼容的已完成 LLM 节点不得重复调用')
  assert.equal(next.trace.find(step => step.node_id === 'prepare').reused_from.run_id, waiting.id)
  const old = getFlow({ data_dir: dataDir, run_id: waiting.id })
  assert.equal(old.status, 'superseded')
  assert.equal(old.superseded_by, next.id)
  assert.deepEqual(old.trace, oldTrace)
  const session = getSessionRuns({ data_dir: dataDir, parent_session_id: 'decision-replan' })
  assert.equal(session.runs.length, 2)
  assert.ok(session.actions.some(item => item.id === action.id && item.run_id === waiting.id && item.definition_version === 1))
})

test('插入人工中断创建新版本，在当前根节点前挂起且不复用不兼容轨迹', async t => {
  const dataDir = workspace(t)
  const waiting = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-insert', input: { source: 'x' },
    definition: {
      version: 1,
      entry: { id: 'root', type: 'sequence', steps: [
        { id: 'read', type: 'det', op: 'expr', expr: { source: { var: 'source' } } },
        { id: 'original', type: 'human', prompt: '原人工节点' },
        { id: 'finish', type: 'det', op: 'expr', expr: { done: true } },
      ] },
    },
  })
  const oldTrace = structuredClone(waiting.trace)
  const llm = {
    async complete({ user }) {
      const payload = JSON.parse(user)
      return { content: JSON.stringify({
        conclusion: payload.instruction ? '需要增加人工确认' : '已在新的人工节点前挂起',
        actions: payload.instruction ? [{ type: 'insert_human', reason: '补充现场验证', prompt: '请完成现场验证' }] : [],
      }) }
    },
  }
  const suggested = await instructFlow({
    data_dir: dataDir, run_id: waiting.id, instruction: '插入现场验证',
  }, { llm })
  const action = suggested.pending_actions[0]
  assert.equal(action.type, 'insert_human')
  const next = await confirmFlow({
    data_dir: dataDir, run_id: waiting.id, action_id: action.id, approved: true,
  }, { llm })
  assert.equal(next.status, 'waiting_human')
  assert.match(next.pending.node_id, /^interrupt_/)
  assert.equal(next.definition_version, 2)
  assert.equal(next.trace.find(step => step.node_id === 'read').reused_from.run_id, waiting.id)
  assert.equal(next.trace.some(step => step.node_id === 'original' && step.status === 'completed'), false)
  assert.deepEqual(getFlow({ data_dir: dataDir, run_id: waiting.id }).trace, oldTrace)
})

test('新面板 API 完成规划、确认启动和手动监督，并返回跨版本关联信息', async t => {
  const dataDir = workspace(t)
  t.after(() => stopPanel())
  const llm = {
    async complete({ system }) {
      if (system.includes('工作流规划器')) {
        return { content: JSON.stringify({
          summary: '面板规划草稿',
          definition: { version: 1, entry: { id: 'done', type: 'det', op: 'literal', value: { panel: true } } },
          input: null, citations: [],
        }) }
      }
      return { content: JSON.stringify({ conclusion: '面板监督正常', actions: [] }) }
    },
  }
  const panel = await startPanel({ data_dir: dataDir, port: 0 }, {
    llm, retrieveExperience: async () => ({ status: 'empty', query: '面板', fallback: false, entries: [] }),
  })
  const html = await (await fetch(panel.url)).text()
  assert.match(html, /新建规划/)
  assert.match(html, /监督会话/)
  assert.match(html, /运行事件/)
  const created = await (await fetch(`${panel.url}/api/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_session_id: 'decision-panel-api', task: '验证新面板' }),
  })).json()
  assert.equal(created.status, 'draft')
  assert.equal(created.trace.length, 0)
  const action = created.pending_actions[0]
  const started = await (await fetch(`${panel.url}/api/runs/${created.id}?action=confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_id: action.id, approved: true }),
  })).json()
  assert.equal(started.status, 'completed')
  assert.deepEqual(started.output, { panel: true })
  const supervised = await (await fetch(`${panel.url}/api/runs/${created.id}?action=supervise`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: '检查完成结果' }),
  })).json()
  assert.equal(supervised.messages.at(-1).text, '面板监督正常')
  const session = await (await fetch(`${panel.url}/api/session?parent_session_id=decision-panel-api`)).json()
  assert.equal(session.actions[0].run_id, created.id)
  assert.equal(session.actions[0].definition_version, 1)
  assert.ok(session.messages.some(message => message.role === 'user' && message.text === '检查完成结果'))
})

function sessionLlm(options = {}) {
  let analystCalls = 0
  let plannerCalls = 0
  let evaluateCalls = 0
  const definition = options.definition || {
    version: 1, name: '会话闭环',
    entry: { id: 'done', type: 'det', op: 'literal', value: { ok: true } },
  }
  return {
    counters: () => ({ analystCalls, plannerCalls, evaluateCalls }),
    async complete({ system }) {
      if (system.includes('需求分析员')) {
        analystCalls += 1
        if (options.analyst) return options.analyst(analystCalls)
        return { content: JSON.stringify({ sufficient: true, missing: [], questions: [], assumptions: [] }) }
      }
      if (system.includes('工作流规划器')) {
        plannerCalls += 1
        return {
          content: JSON.stringify({
            summary: `规划第 ${plannerCalls} 版`,
            definition,
            input: { source: plannerCalls },
            acceptance_criteria: ['输出包含 ok'],
            citations: [],
          }),
        }
      }
      if (system.includes('验收评估员')) {
        evaluateCalls += 1
        if (options.evaluator) return options.evaluator(evaluateCalls)
        return { content: JSON.stringify({ passed: true, gaps: [], evidence: ['输出含 ok'], recommend: 'accept' }) }
      }
      return { content: JSON.stringify({ conclusion: '会话正常', actions: [] }) }
    },
  }
}

const emptyExperience = async () => ({ status: 'empty', query: '会话', fallback: false, entries: [] })

test('会话闭环：受理→澄清→回答→规划→确认执行→自动验收', async t => {
  const dataDir = workspace(t)
  const llm = sessionLlm({
    analyst: call => ({ content: JSON.stringify(call === 1
      ? { sufficient: false, missing: ['目标站点'], questions: ['要抓取哪个网站？'], assumptions: [] }
      : { sufficient: true, missing: [], questions: [], assumptions: ['目标站点由用户回答确定'] }) }),
  })
  const deps = { llm, retrieveExperience: emptyExperience }
  const started = await intakeFlow({ data_dir: dataDir, task: '规划一个只读抓取示例' }, deps)
  assert.equal(started.session.status, 'clarifying')
  assert.equal(started.session.analysis.questions[0], '要抓取哪个网站？')
  assert.equal(started.runs.length, 0)
  assert.equal(started.session.draft_run_id, null)

  const answered = await answerFlow({
    data_dir: dataDir, session_id: started.session.id, answer: 'example.com',
  }, deps)
  assert.equal(answered.session.status, 'awaiting_confirm')
  assert.equal(answered.session.clarifications.length, 1)
  assert.equal(answered.runs.length, 1)
  const draft = answered.runs[0]
  assert.equal(draft.status, 'draft')
  const action = answered.actions.find(item => item.status === 'pending')
  assert.equal(action.type, 'start')
  assert.equal(action.draft, null)

  const completed = await confirmFlow({
    data_dir: dataDir, run_id: draft.id, action_id: action.id, approved: true,
  }, deps)
  assert.equal(completed.status, 'completed')
  const after = getSession({ data_dir: dataDir, session_id: started.session.id })
  assert.equal(after.session.status, 'accepted')
  assert.equal(after.session.evaluations.length, 1)
  assert.equal(after.session.evaluations[0].passed, true)
  assert.equal(after.session.active_run_id, draft.id)
  assert.equal(after.session.draft_run_id, null)
  assert.equal(listSessionGroups({ data_dir: dataDir }).sessions[0].status, 'accepted')
  assert.equal(llm.counters().evaluateCalls, 1)
})

test('验收不通过只生成待确认 replan，确认后新版本重跑并再次验收', async t => {
  const dataDir = workspace(t)
  const llm = sessionLlm({
    evaluator: call => ({ content: JSON.stringify(call === 1
      ? { passed: false, gaps: ['输出未包含 ok'], evidence: ['最终 Cout 为空'], recommend: 'replan' }
      : { passed: true, gaps: [], evidence: ['新版本输出含 ok'], recommend: 'accept' }) }),
  })
  const deps = { llm, retrieveExperience: emptyExperience }
  const accepted = await intakeFlow({ data_dir: dataDir, task: '需要两轮验收的任务' }, deps)
  assert.equal(accepted.session.status, 'awaiting_confirm')
  const draft = accepted.runs[0]
  const startAction = accepted.actions.find(item => item.type === 'start' && item.status === 'pending')

  const completed = await confirmFlow({
    data_dir: dataDir, run_id: draft.id, action_id: startAction.id, approved: true,
  }, deps)
  assert.equal(completed.status, 'completed')
  const evaluated = getSession({ data_dir: dataDir, session_id: accepted.session.id })
  assert.equal(evaluated.session.status, 'awaiting_confirm')
  assert.equal(evaluated.session.evaluations[0].passed, false)
  const replan = evaluated.actions.find(item => item.type === 'replan' && item.status === 'pending')
  assert.ok(replan)
  assert.equal(replan.draft.definition.entry.id, 'done')
  assert.equal(getFlow({ data_dir: dataDir, run_id: draft.id }).status, 'completed')

  const next = await confirmFlow({
    data_dir: dataDir, run_id: draft.id, action_id: replan.id, approved: true,
  }, deps)
  assert.equal(next.status, 'completed')
  assert.equal(next.definition_version, 2)
  assert.equal(next.previous_run_id, draft.id)
  const final = getSession({ data_dir: dataDir, session_id: accepted.session.id })
  assert.equal(final.session.status, 'accepted')
  assert.equal(final.session.active_run_id, next.id)
  assert.equal(final.session.evaluations.length, 2)
  assert.equal(final.session.evaluations[1].passed, true)
  assert.equal(final.runs.find(run => run.id === draft.id).status, 'superseded')
  assert.equal(llm.counters().plannerCalls, 2)
  assert.equal(llm.counters().evaluateCalls, 2)
})

test('启动前修订生成新草稿并保留旧草稿审计', async t => {
  const dataDir = workspace(t)
  const llm = sessionLlm()
  const deps = { llm, retrieveExperience: emptyExperience }
  const first = await intakeFlow({ data_dir: dataDir, task: '初版任务' }, deps)
  assert.equal(first.session.status, 'awaiting_confirm')
  const firstDraft = first.runs[0]

  const revised = await reviseFlow({
    data_dir: dataDir, session_id: first.session.id, instruction: '改为只读流程',
  }, deps)
  assert.equal(revised.session.status, 'awaiting_confirm')
  assert.equal(revised.session.revisions.length, 1)
  assert.notEqual(revised.session.draft_run_id, firstDraft.id)
  const oldDraft = revised.runs.find(run => run.id === firstDraft.id)
  assert.equal(oldDraft.status, 'superseded')
  assert.equal(oldDraft.superseded_by, revised.session.draft_run_id)
  assert.equal(revised.runs.find(run => run.id === revised.session.draft_run_id).definition_version, 2)
  assert.equal(llm.counters().plannerCalls, 2)
  await assert.rejects(() => evaluateFlow({ data_dir: dataDir, session_id: first.session.id }, deps), /可验收/)
})

test('草稿态监督指令改走会话修订，生成新草稿而不是无效监督', async t => {
  const dataDir = workspace(t)
  const llm = sessionLlm()
  const deps = { llm, retrieveExperience: emptyExperience }
  const first = await intakeFlow({ data_dir: dataDir, task: '输出 1-10000' }, deps)
  assert.equal(first.session.status, 'awaiting_confirm')
  const draftId = first.session.draft_run_id

  const revised = await instructFlow({ data_dir: dataDir, run_id: draftId, instruction: '把步数上限改为 100' }, deps)
  assert.equal(revised.session.status, 'awaiting_confirm')
  assert.equal(revised.session.revisions.length, 1)
  assert.notEqual(revised.session.draft_run_id, draftId)
  assert.equal(llm.counters().plannerCalls, 2)
  const oldDraft = revised.runs.find(run => run.id === draftId)
  assert.equal(oldDraft.status, 'superseded')
  assert.equal(oldDraft.pending_actions.length, 1)
  assert.equal(revised.runs.find(run => run.id === revised.session.draft_run_id).status, 'draft')
})

test('agent 节点：有 runner 时走工具循环并解析 JSON，缺失时明确失败', async t => {
  const dataDir = workspace(t)
  const definition = {
    version: 1,
    entry: { id: 'entry', type: 'agent', prompt: '核对仓库中的工作流实现', output: 'json' },
  }
  const missing = await startFlow({ data_dir: dataDir, parent_session_id: 'agent-missing', definition })
  assert.equal(missing.status, 'failed')
  assert.match(missing.error.message, /agent 运行时/)

  const calls = []
  const completed = await startFlow({ data_dir: dataDir, parent_session_id: 'agent-run', definition }, {
    agentRunner: async request => {
      calls.push(request)
      return { text: '调查完成，结果如下：\n```json\n{"ok":true,"files":["runner.mjs"]}\n```', messages: 2 }
    },
  })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { ok: true, files: ['runner.mjs'] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, '核对仓库中的工作流实现')
  assert.equal(calls[0].workspace, join(dataDir, 'workspaces', 'agent-run'))
  assert.match(completed.trace[0].details.agent_mode, /loop/)
})

test('面板会话 API：受理、澄清回答与详情读取', async t => {
  const dataDir = workspace(t)
  t.after(() => stopPanel())
  const llm = sessionLlm({
    analyst: call => ({ content: JSON.stringify(call === 1
      ? { sufficient: false, missing: ['验收口径'], questions: ['怎样算完成？'], assumptions: [] }
      : { sufficient: true, missing: [], questions: [], assumptions: [] }) }),
  })
  const panel = await startPanel({ data_dir: dataDir, port: 0 }, {
    llm, retrieveExperience: emptyExperience,
  })
  const created = await (await fetch(`${panel.url}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: '面板会话测试' }),
  })).json()
  assert.equal(created.session.status, 'clarifying')
  const list = await (await fetch(`${panel.url}/api/sessions`)).json()
  assert.equal(list.sessions[0].id, created.session.id)
  const answered = await (await fetch(`${panel.url}/api/sessions/${created.session.id}?action=answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: '输出包含目标内容即完成' }),
  })).json()
  assert.equal(answered.session.status, 'awaiting_confirm')
  assert.equal(answered.runs.length, 1)
  const detail = await (await fetch(`${panel.url}/api/sessions/${created.session.id}`)).json()
  assert.equal(detail.session.clarifications.length, 1)
  assert.equal(detail.actions[0].type, 'start')
  const moved = await (await fetch(`${panel.url}/api/sessions/${created.session.id}?action=workspace`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: join(dataDir, 'panel-workspace') }),
  })).json()
  assert.equal(moved.session.workspace, join(dataDir, 'panel-workspace'))
  assert.equal(moved.runs[0].workspace, join(dataDir, 'panel-workspace'))
  const html = await (await fetch(panel.url)).text()
  assert.match(html, /受理任务/)
  assert.match(html, /验收标准/)
  assert.match(html, /id="workspace-form"/)
})

test('ts 与 python 运行时可直接作为确定性节点执行', async t => {
  const dataDir = workspace(t)
  const definition = runtime => ({
    version: 1,
    inputs: { n: { type: 'integer', required: true } },
    entry: { id: 'double', type: 'script', runtime, code: '' },
  })

  const tsDefinition = definition('ts')
  tsDefinition.entry.code = [
    'interface Payload { n: number }',
    "let raw = ''",
    "process.stdin.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })",
    "process.stdin.on('end', () => {",
    '  const input: Payload = JSON.parse(raw)',
    '  const output: { doubled: number } = { doubled: input.n * 2 }',
    '  process.stdout.write(JSON.stringify(output))',
    '})',
  ].join('\n')
  const typed = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-ts', definition: tsDefinition, input: { n: 21 },
  })
  assert.equal(typed.status, 'completed')
  assert.deepEqual(typed.output, { doubled: 42 })
  assert.equal(typed.trace[0].details.runtime, 'ts')

  const python = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-python',
    definition: {
      version: 1,
      inputs: { n: { type: 'integer', required: true } },
      entry: {
        id: 'double', type: 'script', runtime: 'python',
        code: 'import json, sys\ndata = json.load(sys.stdin)\nprint(json.dumps({"doubled": data["n"] * 2}))',
      },
    },
    input: { n: 21 },
  })
  assert.equal(python.status, 'completed')
  assert.deepEqual(python.output, { doubled: 42 })

  await assert.rejects(() => startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-runtime',
    definition: { version: 1, entry: { id: 'bad', type: 'script', runtime: 'ruby', code: 'puts 1' } },
  }), /runtime 仅支持/)
})

test('入口契约校验必填、类型、默认值与未知字段，judge=llm 必须有解析节点', async t => {
  const dataDir = workspace(t)
  const definition = {
    version: 1,
    inputs: {
      site: { type: 'string', required: true },
      limit: { type: 'integer', min: 1, max: 10, default: 3 },
    },
    entry: det('echo', { site: { var: 'site' }, limit: { var: 'limit' } }),
  }
  const completed = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-contract', definition, input: { site: 'example.com' },
  })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { site: 'example.com', limit: 3 })

  await assert.rejects(() => startFlow({
    data_dir: dataDir, parent_session_id: 'decision-contract', definition, input: {},
  }), /缺少必填输入：site/)
  await assert.rejects(() => startFlow({
    data_dir: dataDir, parent_session_id: 'decision-contract', definition, input: { site: 'a', limit: 99 },
  }), /不能大于 10/)
  await assert.rejects(() => startFlow({
    data_dir: dataDir, parent_session_id: 'decision-contract', definition, input: { site: 'a', other: 1 },
  }), /未知输入字段：other/)
  await assert.rejects(() => startFlow({
    data_dir: dataDir, parent_session_id: 'decision-contract-llm',
    definition: {
      version: 1,
      inputs: { raw: { type: 'string', judge: 'llm', required: true } },
      entry: det('noop', { var: '' }),
    },
    input: { raw: '任意自然语言' },
  }), /没有 llm\/agent 节点/)
})

test('script 节点按运行语言执行，Cin 走 stdin、Cout 走 stdout', async t => {
  const dataDir = workspace(t)
  const run = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-script',
    definition: {
      version: 1,
      inputs: { name: { type: 'string', required: true } },
      entry: {
        id: 'echo', type: 'script', runtime: 'node',
        code: [
          "let raw = ''",
          "process.stdin.on('data', chunk => { raw += chunk })",
          "process.stdin.on('end', () => {",
          "  const input = JSON.parse(raw)",
          "  process.stdout.write(JSON.stringify({ greeting: 'hi ' + input.name }))",
          '})',
        ].join('\n'),
      },
    },
    input: { name: 'flow' },
  })
  assert.equal(run.status, 'completed')
  assert.deepEqual(run.output, { greeting: 'hi flow' })
  assert.equal(run.trace[0].details.runtime, 'node')

  const asText = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-script-text',
    definition: {
      version: 1,
      entry: {
        id: 'plain', type: 'script', runtime: 'node', output: 'text',
        code: "process.stdout.write('hello')",
      },
    },
  })
  assert.equal(asText.status, 'completed')
  assert.equal(asText.output, 'hello')

  const broken = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-script-failed',
    definition: {
      version: 1,
      entry: { id: 'exit', type: 'script', runtime: 'node', code: 'process.exit(3)' },
    },
  })
  assert.equal(broken.status, 'failed')
  assert.match(broken.error.message, /退出码 3/)
})

test('http 节点直接发起请求，URL/body 支持表达式并按 JSON 解析响应', async t => {
  const dataDir = workspace(t)
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        path: request.url, method: request.method, body: body ? JSON.parse(body) : null,
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port

  const run = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-http',
    definition: {
      version: 1,
      entry: {
        id: 'call', type: 'http', method: 'POST',
        url: `http://127.0.0.1:${port}/ping`,
        body: { q: { var: 'q' } },
      },
    },
    input: { q: 'abc' },
  })
  assert.equal(run.status, 'completed')
  assert.deepEqual(run.output, { path: '/ping', method: 'POST', body: { q: 'abc' } })
  assert.equal(run.trace[0].details.status, 200)
})

test('tool 节点缺少宿主执行器时明确失败，有执行器时调用并解析返回值', async t => {
  const dataDir = workspace(t)
  const definition = {
    version: 1,
    entry: { id: 'read', type: 'tool', tool: 'read_file', args: { path: { var: 'path' } } },
  }
  const failed = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-tool', definition, input: { path: 'a.txt' },
  })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error.message, /toolRunner/)

  const calls = []
  const completed = await startFlow({
    data_dir: dataDir, parent_session_id: 'decision-tool', definition, input: { path: 'a.txt' },
  }, {
    toolRunner: async request => {
      calls.push(request)
      return { value: { text: 'ok' } }
    },
  })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { text: 'ok' })
  assert.deepEqual(calls[0], { name: 'read_file', args: { path: 'a.txt' }, input: { path: 'a.txt' } })
})

test('invokeFlow 按 run_id 复用定义直接运行，不经过规划且按契约校验输入', async t => {
  const dataDir = workspace(t)
  const source = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-invoke',
    name: '契约模板',
    definition: {
      version: 1,
      inputs: { n: { type: 'integer', required: true } },
      entry: det('double', { doubled: { '*': [{ var: 'n' }, 2] } }),
    },
    input: { n: 2 },
  })
  assert.equal(source.status, 'completed')
  assert.deepEqual(source.output, { doubled: 4 })

  const again = await invokeFlow({ data_dir: dataDir, run_id: source.id, input: { n: 5 } })
  assert.equal(again.status, 'completed')
  assert.deepEqual(again.output, { doubled: 10 })
  assert.equal(again.previous_run_id, source.id)
  assert.deepEqual(again.invoked_from, { run_id: source.id, definition_version: 1 })
  assert.equal(again.parent_session_id, 'decision-invoke')
  assert.equal(again.supervision.enabled, false)

  const reused = await invokeFlow({ data_dir: dataDir, run_id: source.id })
  assert.deepEqual(reused.output, { doubled: 4 })

  await assert.rejects(
    () => invokeFlow({ data_dir: dataDir, run_id: source.id, input: { n: 'x' } }),
    /必须是 integer/,
  )
  await assert.rejects(
    () => invokeFlow({ data_dir: dataDir, run_id: source.id, input: { n: 1, extra: true } }),
    /未知输入字段：extra/,
  )
})

test('会话工作目录：默认按会话隔离，script 默认 cwd 与相对 cwd 都以它为根', async t => {
  const dataDir = workspace(t)
  const write = {
    version: 1,
    entry: { id: 'write', type: 'script', runtime: 'node', code: "import { writeFileSync } from 'node:fs'\nwriteFileSync('probe.txt', 'ok')\nprocess.stdout.write('{}')" },
  }
  const run = await startFlow({ data_dir: dataDir, parent_session_id: 'decision-workspace', definition: write })
  assert.equal(run.status, 'completed')
  const defaultDir = join(dataDir, 'workspaces', 'decision-workspace')
  assert.equal(run.workspace, defaultDir)
  assert.ok(existsSync(join(defaultDir, 'probe.txt')))

  const customDir = join(dataDir, 'custom-workspace')
  mkdirSync(join(customDir, 'sub'), { recursive: true })
  const nested = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'decision-workspace-custom',
    workspace: customDir,
    definition: {
      version: 1,
      entry: { id: 'write-sub', type: 'script', runtime: 'node', cwd: 'sub', code: "import { writeFileSync } from 'node:fs'\nwriteFileSync('probe.txt', 'ok')\nprocess.stdout.write('{}')" },
    },
  })
  assert.equal(nested.status, 'completed')
  assert.equal(nested.workspace, customDir)
  assert.ok(existsSync(join(customDir, 'sub', 'probe.txt')))
})

test('flow_workspace 更新会话与未启动草稿的工作目录，缺省回到会话默认目录', async t => {
  const dataDir = workspace(t)
  const deps = { llm: sessionLlm(), retrieveExperience: emptyExperience }
  const customDir = join(dataDir, 'session-custom')
  const started = await intakeFlow({
    data_dir: dataDir, task: '按会话隔离输出目录', session_id: 'sess-workspace', workspace: customDir,
  }, deps)
  assert.equal(started.session.workspace, customDir)
  assert.ok(existsSync(customDir))
  assert.ok(started.session.draft_run_id)
  assert.equal(started.runs[0].workspace, customDir)

  const nextDir = join(dataDir, 'session-next')
  const updated = await configureWorkspace({ data_dir: dataDir, session_id: 'sess-workspace', workspace: nextDir })
  assert.equal(updated.session.workspace, nextDir)
  assert.ok(existsSync(nextDir))
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })
  assert.equal(draft.workspace, nextDir)

  const reset = await configureWorkspace({ data_dir: dataDir, session_id: 'sess-workspace' })
  const fallback = join(dataDir, 'workspaces', 'sess-workspace')
  assert.equal(reset.session.workspace, fallback)
  assert.ok(existsSync(fallback))
})

test('subflow：内联子流程直接返回 Cout，并持久化父子运行关系', async t => {
  const dataDir = workspace(t)
  const run = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'subflow-inline',
    definition: {
      version: 1,
      inputs: { n: { type: 'integer', required: true } },
      entry: {
        id: 'child', type: 'subflow',
        definition: {
          version: 1,
          inputs: { n: { type: 'integer', required: true } },
          entry: {
            id: 'double', type: 'script', runtime: 'node', output: 'json',
            code: "let s = ''\nprocess.stdin.on('data', c => s += c).on('end', () => process.stdout.write(JSON.stringify({ doubled: JSON.parse(s).n * 2 })))",
          },
        },
        input: { n: { var: 'n' } },
      },
    },
    input: { n: 21 },
  })
  assert.equal(run.status, 'completed')
  assert.deepEqual(run.output, { doubled: 42 })
  const childId = run.trace[0].details.subflow_run_id
  assert.ok(childId)
  const child = getFlow({ data_dir: dataDir, run_id: childId })
  assert.equal(child.parent_run_id, run.id)
  assert.equal(child.parent_node_id, 'child')
  assert.equal(child.root_run_id, run.id)
  assert.equal(child.depth, 1)
  assert.equal(child.status, 'completed')
})

test('subflow：命名定义加 recursion 可真递归，未开启时拒绝自引用，深度受上限约束', async t => {
  const dataDir = workspace(t)
  const previousMaxDepth = process.env.RMS_FLOW_SUBFLOW_MAX_DEPTH
  process.env.RMS_FLOW_SUBFLOW_MAX_DEPTH = '4'
  t.after(() => {
    if (previousMaxDepth === undefined) delete process.env.RMS_FLOW_SUBFLOW_MAX_DEPTH
    else process.env.RMS_FLOW_SUBFLOW_MAX_DEPTH = previousMaxDepth
  })
  const makeBase = self => ({
    version: 1,
    inputs: { n: { type: 'integer', required: true, min: 0 } },
    entry: {
      id: 'root', type: 'branch',
      condition: { '<=': [{ var: 'n' }, 1] },
      then: { id: 'stop', type: 'det', op: 'literal', value: { done: true } },
      else: {
        id: 'next', type: 'subflow', ref: self,
        input: { n: { '-': [{ var: 'n' }, 1] } },
      },
    },
  })
  const countdown = makeBase('countdown')
  countdown.entry.else.recursion = true
  defineFlow({ data_dir: dataDir, name: 'countdown', definition: countdown })
  defineFlow({ data_dir: dataDir, name: 'loopguard', definition: makeBase('loopguard') })

  assert.deepEqual(listDefinitions({ data_dir: dataDir }).map(item => item.name), ['countdown', 'loopguard'])
  assert.equal(listDefinitions({ data_dir: dataDir, name: 'countdown' }).versions[0].definition.entry.else.recursion, true)

  const entry = {
    version: 1,
    inputs: { n: { type: 'integer', required: true } },
    entry: { id: 'start', type: 'subflow', ref: { name: 'countdown', version: 1 }, input: { n: { var: 'n' } } },
  }
  const recursed = await startFlow({
    data_dir: dataDir, parent_session_id: 'subflow-recursion', definition: entry, input: { n: 3 },
  })
  assert.equal(recursed.status, 'completed')
  assert.deepEqual(recursed.output, { done: true })
  assert.equal(recursed.trace[0].details.depth, 1)

  const tooDeep = await startFlow({
    data_dir: dataDir, parent_session_id: 'subflow-depth', definition: entry, input: { n: 6 },
  })
  assert.equal(tooDeep.status, 'failed')
  assert.match(tooDeep.error.message, /子流程深度/)

  const guarded = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'subflow-guard',
    definition: {
      version: 1,
      inputs: { n: { type: 'integer', required: true } },
      entry: { id: 'start', type: 'subflow', ref: 'loopguard', input: { n: { var: 'n' } } },
    },
    input: { n: 2 },
  })
  assert.equal(guarded.status, 'failed')
  assert.match(guarded.error.message, /检测到递归引用/)
})

test('subflow：子流程等待人工时父级挂起，resume 自动路由到子运行后继续父流程', async t => {
  const dataDir = workspace(t)
  const run = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'subflow-human',
    definition: {
      version: 1,
      entry: {
        id: 'seq', type: 'sequence',
        steps: [
          {
            id: 'ask', type: 'subflow',
            definition: {
              version: 1,
              entry: { id: 'wait', type: 'human', prompt: '请输入确认词' },
            },
          },
          { id: 'after', type: 'det', op: 'expr', expr: { ok: { var: 'word' } } },
        ],
      },
    },
  })
  assert.equal(run.status, 'waiting_human')
  assert.ok(run.pending.subflow_run_id)
  const childId = run.pending.subflow_run_id
  assert.equal(getFlow({ data_dir: dataDir, run_id: childId }).status, 'waiting_human')

  const resumed = await resumeFlow({ data_dir: dataDir, run_id: run.id, input: { word: 'go' } })
  assert.equal(resumed.status, 'completed')
  assert.deepEqual(resumed.output, { ok: 'go' })
  assert.equal(getFlow({ data_dir: dataDir, run_id: childId }).status, 'completed')
})

function buildMock(handler) {
  return {
    async complete({ system, user }) {
      // 子会话与父会话一致，会先跑需求分析；默认视为信息足够
      if (system.includes('需求分析员')) {
        return { content: JSON.stringify({ sufficient: true, missing: [], questions: [], assumptions: [] }) }
      }
      const payload = user ? JSON.parse(user) : null
      const result = handler(system, payload)
      return { content: typeof result === 'string' ? result : JSON.stringify(result) }
    },
  }
}

test('building：骨架 → 逐节点会话实现 → 组装草稿并可直接确认执行', async t => {
  const dataDir = workspace(t)
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return {
        name: '骨架闭环',
        summary: '单节点扫描',
        children: [{ id: 'scan', role: 'script', intent: '输出扫描结果', complexity: 1 }],
      }
    }
    assert.equal(payload.node.id, 'scan')
    return {
      decision: 'implement',
      complexity: 1,
      node: {
        id: 'scan', type: 'script', runtime: 'node', output: 'json',
        code: "process.stdout.write(JSON.stringify({ ok: true }))",
      },
    }
  })
  const started = await startBuild({ data_dir: dataDir, session_id: 'build-one', task: '扫描一次' }, { llm })
  assert.equal(started.status, 'building')
  assert.equal(started.progress.nodes, 1)

  const built = await runBuild({ data_dir: dataDir, session_id: 'build-one' }, { llm })
  assert.equal(built.status, 'awaiting_confirm')
  assert.equal(built.progress.sessions, 2)
  assert.ok(built.definition)
  const draft = getFlow({ data_dir: dataDir, run_id: built.run_id })
  assert.equal(draft.status, 'draft')
  assert.equal(draft.pending_actions[0].type, 'start')

  const completed = await confirmFlow({
    data_dir: dataDir, run_id: draft.id, action_id: draft.pending_actions[0].id, approved: true,
  }, { llm })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { ok: true })
})

test('building：超标节点继续拆成子工作流，子节点独立会话实现', async t => {
  const dataDir = workspace(t)
  const seen = []
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return {
        name: '递归构建',
        children: [{ id: 'analyze', role: 'group', intent: '分析并判定', complexity: 5 }],
      }
    }
    seen.push(payload.node.path)
    if (payload.node.id === 'analyze') {
      return {
        decision: 'decompose',
        complexity: 4,
        children: [
          { id: 'collect', role: 'script', intent: '收集数据', complexity: 1 },
          { id: 'judge', role: 'script', intent: '给出判定', complexity: 1 },
        ],
      }
    }
    return {
      decision: 'implement',
      complexity: 1,
      node: {
        id: payload.node.id, type: 'det', op: 'literal',
        value: { step: payload.node.id },
      },
    }
  })
  await startBuild({ data_dir: dataDir, session_id: 'build-recursive', task: '分析任务' }, { llm })
  const built = await runBuild({ data_dir: dataDir, session_id: 'build-recursive' }, { llm })
  assert.equal(built.status, 'awaiting_confirm')
  assert.deepEqual(seen, ['/0', '/0/0', '/0/1'])
  assert.equal(built.progress.nodes, 3)
  assert.equal(built.progress.decomposed, 1)
  assert.equal(built.definition.entry.type, 'subflow')
  assert.equal(built.definition.entry.definition.entry.type, 'sequence')
  assert.equal(built.definition.entry.definition.entry.steps.length, 2)

  const completed = await confirmFlow({
    data_dir: dataDir,
    run_id: built.run_id,
    action_id: getFlow({ data_dir: dataDir, run_id: built.run_id }).pending_actions[0].id,
    approved: true,
  }, { llm })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { step: 'judge' })
})

test('构建栈：嵌套占位逐层开独立子会话，自底向上回填编译', async t => {
  const dataDir = workspace(t)
  let skeletons = 0
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      skeletons += 1
      const id = ['layer', 'mid', 'leaf'][Math.min(skeletons - 1, 2)]
      return { name: `第 ${skeletons} 层`, children: [{ id, role: 'group', intent: `第 ${skeletons} 层`, complexity: 3 }] }
    }
    if (payload.node.id === 'layer') {
      return {
        decision: 'implement',
        complexity: 2,
        node: {
          id: 'layer',
          type: 'sequence',
          steps: [
            { id: 'next', type: 'subflow', label: '第 2 层', build: { task: '实现第 2 层，规则相同', layers: 2 } },
            { id: 'add', type: 'det', op: 'expr', expr: { '+': [{ var: '' }, 1] } },
          ],
        },
      }
    }
    if (payload.node.id === 'mid') {
      return {
        decision: 'implement',
        complexity: 2,
        node: {
          id: 'mid',
          type: 'sequence',
          steps: [
            { id: 'next2', type: 'subflow', label: '第 3 层', build: { task: '实现第 3 层，规则相同', layers: 1 } },
            { id: 'add2', type: 'det', op: 'expr', expr: { '+': [{ var: '' }, 1] } },
          ],
        },
      }
    }
    assert.equal(payload.node.id, 'leaf')
    return { decision: 'implement', complexity: 1, node: { id: 'leaf', type: 'det', op: 'literal', value: 1 } }
  })
  await startBuild({ data_dir: dataDir, session_id: 'build-stack-layered', task: '三层逐层构建' }, { llm })
  const paused = await runBuild({ data_dir: dataDir, session_id: 'build-stack-layered' }, { llm })
  // 子会话先受理并做需求分析，生成骨架 DAG 后挂起等人工确认 DAG
  assert.equal(paused.status, 'waiting_children')
  const stackPaused = loadBuildStack(dataDir, 'build-stack-layered')
  assert.equal(stackPaused.entries.length, 2)
  const childEntry = stackPaused.entries.find(item => item.status === 'awaiting_dag')
  assert.ok(childEntry?.session_id)
  // 交接需求里必须出现具体预算与递减后的具体值，而不是“剩余层数”这种运行时表述
  const firstChild = getSession({
    data_dir: dataDir,
    session_id: childEntry.session_id,
  })
  assert.match(firstChild.session.task, /当前层预算 layers = 2/)
  assert.match(firstChild.session.task, /必须写具体整数 1/)
  // 需求分析已跑过，会话已从受理进入等待 DAG 确认
  assert.equal(firstChild.session.analysis?.sufficient, true)

  // 确认 DAG + 验收后才回填，最终根构建进入待确认
  await passBuildGates(dataDir, { llm }, 'build-stack-layered')
  const built = await getBuild({ data_dir: dataDir, session_id: 'build-stack-layered' })
  assert.equal(built.status, 'awaiting_confirm')

  // 每层独立子会话：共享构建栈记录 3 个条目、3 个不同会话
  const stack = loadBuildStack(dataDir, 'build-stack-layered')
  assert.equal(stack.entries.length, 3)
  assert.equal(new Set(stack.entries.map(item => item.session_id)).size, 3)
  assert.equal(stack.status, 'done')

  // 自底向上回填：占位被替换为携带 definition 的 subflow，三层结构逐层嵌套
  const entry = built.definition.entry
  assert.equal(entry.id, 'layer')
  assert.equal(entry.steps[0].id, 'next')
  assert.equal(entry.steps[0].type, 'subflow')
  assert.ok(entry.steps[0].definition)
  const mid = entry.steps[0].definition.entry
  assert.equal(mid.id, 'mid')
  assert.equal(mid.steps[0].id, 'next2')
  assert.ok(mid.steps[0].definition)
  assert.equal(mid.steps[0].definition.entry.value, 1)

  const completed = await confirmFlow({
    data_dir: dataDir,
    run_id: built.run_id,
    action_id: getFlow({ data_dir: dataDir, run_id: built.run_id }).pending_actions[0].id,
    approved: true,
  }, { llm })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.output, 3)
})

test('building：implement 只返回当前节点的 build 占位会拒绝并回灌修复', async t => {
  const dataDir = workspace(t)
  const errors = []
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return { name: '自占位拒绝', children: [{ id: 'layer', role: 'group', intent: '实现第 1 层', complexity: 3 }] }
    }
    errors.push(payload.repair_instruction || null)
    return {
      decision: 'implement',
      complexity: 3,
      node: { id: 'layer', type: 'subflow', label: '第 1 层', build: { task: '再实现第 1 层' } },
    }
  })
  await startBuild({ data_dir: dataDir, session_id: 'build-self-placeholder', task: '单层任务' }, { llm })
  const built = await runBuild({ data_dir: dataDir, session_id: 'build-self-placeholder' }, { llm })
  assert.equal(built.status, 'failed')
  assert.match(built.error.message, /不能只是把当前节点再包一层/)
  assert.equal(errors.length, 2)
  assert.match(errors[1], /不能只是把当前节点再包一层/)
})

test('building：人工请求支持 zoom in/out 调整分析角度与范围后重跑该节点', async t => {
  const dataDir = workspace(t)
  const calls = []
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return {
        name: '人工介入构建',
        children: [{ id: 'pick', role: 'llm', intent: '选择站点', complexity: 4 }],
      }
    }
    calls.push({ zoom: payload.node.zoom, angle: payload.node.angle, scope: payload.node.scope })
    if (payload.node.zoom === 'in') {
      return {
        decision: 'implement',
        complexity: 1,
        node: { id: 'pick', type: 'det', op: 'literal', value: { site: 'A' } },
      }
    }
    return {
      decision: 'need_human',
      question: '用哪个站点？',
      options: ['A', 'B'],
      suggested_zoom: 'in',
      reason: '任务没写站点范围',
    }
  })
  await startBuild({ data_dir: dataDir, session_id: 'build-human', task: '选择站点' }, { llm })
  const waiting = await stepBuild({ data_dir: dataDir, session_id: 'build-human' }, { llm })
  assert.equal(waiting.status, 'waiting_human')
  assert.equal(waiting.human.path, '/0')
  assert.equal(waiting.human.suggested_zoom, 'in')

  const answered = await answerBuild({
    data_dir: dataDir,
    session_id: 'build-human',
    action: 'zoom_in',
    answer: '只用 A 站点',
    angle: '按站点维度',
    scope: '单站点',
  }, { llm })
  assert.equal(answered.status, 'awaiting_confirm')
  assert.equal(answered.history[0].action, 'zoom_in')
  assert.equal(answered.tree.children[0].zoom, 'in')
  assert.equal(answered.tree.children[0].angle, '按站点维度')
  assert.deepEqual(calls, [
    { zoom: 'normal', angle: null, scope: null },
    { zoom: 'in', angle: '按站点维度', scope: '单站点' },
  ])
  assert.deepEqual(answered.definition.entry.value, { site: 'A' })
  assert.equal((await getBuild({ data_dir: dataDir, session_id: 'build-human' })).status, 'awaiting_confirm')
})

test('构建失败后可人工重试失败节点并继续', async t => {
  const dataDir = workspace(t)
  let nodeCalls = 0
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return { name: '重试构建', children: [{ id: 'scan', role: 'script', intent: '扫描一次', complexity: 1 }] }
    }
    assert.equal(payload.node.id, 'scan')
    nodeCalls += 1
    // 前两次（含内部一次重试）都返回坏 JSON，让节点构建失败
    if (nodeCalls <= 2) return '不是 JSON'
    return {
      decision: 'implement', complexity: 1,
      node: { id: 'scan', type: 'script', runtime: 'node', output: 'json', code: 'process.stdout.write(JSON.stringify({ ok: true }))' },
    }
  })
  await startBuild({ data_dir: dataDir, session_id: 'build-retry', task: '扫描一次' }, { llm })
  const failed = await runBuild({ data_dir: dataDir, session_id: 'build-retry' }, { llm })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.node_id, 'scan')

  // 人工点“重试失败节点”：重置该节点后继续推进到待确认
  const retried = await retryBuild({ data_dir: dataDir, session_id: 'build-retry' }, { llm })
  assert.equal(retried.status, 'awaiting_confirm')
  assert.ok(retried.build.definition)
  assert.equal(retried.build.error, null)
  assert.equal(nodeCalls, 3)
  await assert.rejects(retryBuild({ data_dir: dataDir, session_id: 'build-retry' }, { llm }), /只有 failed 可以重试/)
})

test('构建重试支持后台推进：请求立即返回，进度由后续状态体现', async t => {
  const dataDir = workspace(t)
  let nodeCalls = 0
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return { name: '后台重试', children: [{ id: 'scan', role: 'script', intent: '扫描一次', complexity: 1 }] }
    }
    assert.equal(payload.node.id, 'scan')
    nodeCalls += 1
    if (nodeCalls <= 2) return '不是 JSON'
    return {
      decision: 'implement', complexity: 1,
      node: { id: 'scan', type: 'script', runtime: 'node', output: 'json', code: 'process.stdout.write(JSON.stringify({ ok: true }))' },
    }
  })
  await startBuild({ data_dir: dataDir, session_id: 'build-retry-bg', task: '扫描一次' }, { llm })
  const failed = await runBuild({ data_dir: dataDir, session_id: 'build-retry-bg' }, { llm })
  assert.equal(failed.status, 'failed')

  // 面板重试走后台：先回 building，构建在队列里继续，轮询能看到最终状态
  const queued = await retryBuild({ data_dir: dataDir, session_id: 'build-retry-bg', background: true }, { llm })
  assert.equal(queued.background, true)
  assert.equal(queued.status, 'building')
  for (let guard = 0; guard < 200; guard += 1) {
    if ((await getBuild({ data_dir: dataDir, session_id: 'build-retry-bg' })).status !== 'building') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal((await getBuild({ data_dir: dataDir, session_id: 'build-retry-bg' })).status, 'awaiting_confirm')
})

test('节点编码会话使用独立工作目录，看不到同树其它节点产物', async t => {
  const dataDir = workspace(t)
  const calls = []
  const agentRunner = async args => {
    calls.push(args)
    if (args.system.includes('工作流骨架拆解器')) {
      return {
        text: JSON.stringify({
          name: '独立节点',
          children: [
            { id: 'alpha_out', role: 'script', intent: '产出 alpha', complexity: 1 },
            { id: 'beta_out', role: 'script', intent: '产出 beta', complexity: 1 },
          ],
        }),
      }
    }
    const id = args.input.node.id
    return {
      text: JSON.stringify({
        decision: 'implement', complexity: 1,
        node: { id, type: 'script', runtime: 'node', output: 'json', code: `process.stdout.write(JSON.stringify({ from: "${id}" }))` },
      }),
    }
  }
  const started = await startBuild({ data_dir: dataDir, session_id: 'build-isolate', task: '两个独立节点' }, { agentRunner })
  assert.equal(started.status, 'building')
  const built = await runBuild({ data_dir: dataDir, session_id: 'build-isolate' }, { agentRunner })
  assert.equal(built.status, 'awaiting_confirm')

  const nodeCalls = calls.filter(call => call.input?.node)
  assert.equal(nodeCalls.length, 2)
  const cwds = nodeCalls.map(call => call.cwd)
  assert.equal(new Set(cwds).size, 2)
  for (const call of nodeCalls) {
    // 编码会话 cwd 指向本节点专属目录，工作区父目录不共享给其它节点
    assert.match(call.cwd, /\.flow-nodes/)
    assert.equal(call.workspace, started.workspace)
    assert.equal(existsSync(call.cwd), true)
  }
})

const PLACEHOLDER_DEFINITION = {
  version: 1,
  name: '交接闭环',
  entry: {
    id: 'seq', type: 'sequence',
    steps: [
      { id: 'seed', type: 'det', op: 'literal', value: { started: true } },
      {
        id: 'report', type: 'subflow', label: '报告生成',
        build: { task: '生成一份报告', layers: 1, sample_input: { started: true } },
      },
    ],
  },
}

function handoffBuildLlm(output = { report: true }) {
  return buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return {
        name: '报告生成',
        children: [{ id: 'make', role: 'script', intent: '生成报告', complexity: 1 }],
      }
    }
    assert.equal(payload.node.id, 'make')
    return {
      decision: 'implement',
      complexity: 1,
      node: {
        id: 'make', type: 'script', runtime: 'node', output: 'json',
        code: `process.stdout.write(JSON.stringify(${JSON.stringify(output)}))`,
      },
    }
  })
}

async function handoffFixture(t, output) {
  const dataDir = workspace(t)
  const deps = { llm: sessionLlm({ definition: PLACEHOLDER_DEFINITION }), retrieveExperience: emptyExperience }
  const started = await intakeFlow({ data_dir: dataDir, parent_session_id: 'handoff-root', task: '生成报告' }, deps)
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })
  const llm = handoffBuildLlm(output)
  const handed = await startBuild({ data_dir: dataDir, from_run_id: draft.id, node_id: 'report' }, { llm })
  return { dataDir, draft, handed, llm, childId: handed.session_id, deps }
}

test('handoff：占位未构建时拒绝启动；交接构建后回填父草稿新版本并可执行', async t => {
  const dataDir = workspace(t)
  const deps = { llm: sessionLlm({ definition: PLACEHOLDER_DEFINITION }), retrieveExperience: emptyExperience }

  await assert.rejects(
    startFlow({ data_dir: dataDir, parent_session_id: 'handoff-guard', definition: PLACEHOLDER_DEFINITION }),
    /未构建的子流程占位/,
  )

  const started = await intakeFlow({ data_dir: dataDir, parent_session_id: 'handoff-root', task: '生成报告' }, deps)
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })
  assert.equal(draft.status, 'draft')
  assert.equal(draft.definition.entry.steps[1].build.task, '生成一份报告')

  await assert.rejects(confirmFlow({
    data_dir: dataDir, run_id: draft.id, action_id: draft.pending_actions[0].id, approved: true,
  }, deps), /未构建的子流程占位/)

  const llm = handoffBuildLlm()
  const handed = await startBuild({ data_dir: dataDir, from_run_id: draft.id, node_id: 'report' }, { llm })
  // 只生成骨架 DAG，停在人工确认 DAG 之前
  assert.equal(handed.status, 'awaiting_dag')
  assert.ok(handed.readonly_definition?.entry)
  assert.equal(handed.origin.run_id, draft.id)
  assert.equal(handed.origin.node_id, 'report')
  assert.equal(handed.context.node_label, '报告生成')
  assert.equal(handed.context.parent_task, '生成报告')
  const childId = handed.session_id

  // 第1层（根层）先有独立会话，占位子会话挂到它下面形成层链
  const layer = getSession({ data_dir: dataDir, session_id: 'sess-handoff-root_layer1' })
  assert.equal(layer.session.parent_session_id, 'handoff-root')
  const child = getSession({ data_dir: dataDir, session_id: childId })
  assert.equal(child.session.parent_session_id, layer.session.id)
  assert.equal(child.session.root_session_id, 'handoff-root')
  assert.equal(child.session.depth, 2)
  assert.equal(child.session.origin.node_id, 'report')
  assert.ok(child.session.task.startsWith('生成一份报告'))
  // 交接需求必须带上具体层数预算与终止条件，避免子会话把层数当变量继续外推
  assert.match(child.session.task, /当前层预算 layers = 1/)
  assert.match(child.session.task, /终止条件（本层已触发）/)

  const tree = listSessionTree({ data_dir: dataDir })
  const root = tree.roots.find(item => item.id === 'handoff-root')
  assert.equal(root.children[0].id, 'sess-handoff-root_layer1')
  assert.equal(root.children[0].children[0].id, childId)
  const subtree = listSessionTree({ data_dir: dataDir, session_id: childId })
  assert.equal(subtree.roots[0].id, childId)
  assert.deepEqual(subtree.roots[0].children, [])

  const built = await runBuild({ data_dir: dataDir, session_id: childId }, { llm })
  // 子会话和父会话一样：先停在 DAG 确认，确认前不进入编码
  assert.equal(built.status, 'awaiting_dag')
  assert.ok(built.readonly_definition?.entry)
  assert.equal(built.definition, null)
  const dagConfirmed = await confirmBuildDag({ data_dir: dataDir, session_id: childId }, { llm })
  // 与单层父会话一致：编译完成生成可独立运行的草稿，并停在待运行/验收
  assert.equal(dagConfirmed.status, 'awaiting_confirm')
  assert.equal(dagConfirmed.build.definition.entry.type, 'script')
  const childRun = getFlow({ data_dir: dataDir, run_id: dagConfirmed.build.run_id })
  assert.equal(childRun.status, 'draft')
  assert.equal(getSession({ data_dir: dataDir, session_id: childId }).session.draft_run_id, childRun.id)
  // 父草稿尚未回填
  assert.equal(getFlow({ data_dir: dataDir, run_id: draft.id }).status, 'draft')

  // 子会话可独立运行，且运行结果不影响构建栈/验收状态
  const childRan = await confirmFlow({
    data_dir: dataDir, run_id: childRun.id, action_id: childRun.pending_actions[0].id, approved: true,
  }, { llm })
  assert.equal(childRan.status, 'completed')
  assert.deepEqual(childRan.output, { report: true })
  assert.equal((await getBuild({ data_dir: dataDir, session_id: childId })).status, 'awaiting_confirm')
  // 子会话独立运行只是试运行：不会把会话状态改成待验收，也不生成 replan
  assert.equal(getSession({ data_dir: dataDir, session_id: childId }).session.status, 'awaiting_confirm')

  const accepted = await acceptBuild({ data_dir: dataDir, session_id: childId }, { llm })
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.build.status, 'accepted')
  assert.equal(getSession({ data_dir: dataDir, session_id: childId }).session.status, 'built')
  const v2 = getFlow({ data_dir: dataDir, run_id: getSession({ data_dir: dataDir, session_id: 'handoff-root' }).session.draft_run_id })
  assert.equal(v2.status, 'draft')
  assert.equal(v2.definition_version, 2)
  assert.equal(v2.previous_run_id, draft.id)
  assert.equal(v2.definition.entry.steps[0].id, 'seed')
  assert.equal(v2.definition.entry.steps[1].type, 'subflow')
  assert.equal(v2.definition.entry.steps[1].id, 'report')
  assert.ok(v2.definition.entry.steps[1].definition)
  assert.equal(getFlow({ data_dir: dataDir, run_id: draft.id }).status, 'superseded')
  assert.equal(getSession({ data_dir: dataDir, session_id: 'handoff-root' }).session.draft_run_id, v2.id)

  const completed = await confirmFlow({
    data_dir: dataDir, run_id: v2.id, action_id: v2.pending_actions[0].id, approved: true,
  }, { llm: sessionLlm() })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { report: true })
  assert.equal(getFlow({ data_dir: dataDir, run_id: draft.id }).status, 'superseded')
})

test('prebuild：逐个创建子会话构建全部占位，全部完成后才能确认执行', async t => {
  const dataDir = workspace(t)
  const definition = {
    version: 1,
    name: '双子流程',
    entry: {
      id: 'seq', type: 'sequence',
      steps: [
        { id: 'seed', type: 'det', op: 'literal', value: { started: true } },
        { id: 'alpha', type: 'subflow', label: '子流程A', build: { task: '生成A', layers: 1, sample_input: { started: true } } },
        { id: 'beta', type: 'subflow', label: '子流程B', build: { task: '生成B', layers: 1, sample_input: { started: true } } },
      ],
    },
  }
  const deps = { llm: sessionLlm({ definition }), retrieveExperience: emptyExperience }
  const started = await intakeFlow({ data_dir: dataDir, parent_session_id: 'prebuild-root', task: '生成A与B' }, deps)
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })
  assert.equal(draft.status, 'draft')

  const runsView = getSessionRuns({ data_dir: dataDir, parent_session_id: 'prebuild-root' })
  assert.deepEqual(runsView.runs[0].build_placeholders.map(item => item.node_id), ['alpha', 'beta'])

  await assert.rejects(confirmFlow({
    data_dir: dataDir, run_id: draft.id, action_id: draft.pending_actions[0].id, approved: true,
  }, deps), /未构建的子流程占位/)

  const llm = handoffBuildLlm()
  // 预构建为第一个占位创建子会话：先受理+需求分析，再出骨架 DAG，挂起等确认
  const first = await prebuildFlow({ data_dir: dataDir, run_id: draft.id, step: true }, { llm })
  assert.equal(first.status, 'awaiting_dag')
  assert.equal(first.blocked.node_id, 'alpha')
  assert.equal(first.remaining, 2)
  assert.equal(first.builds.find(item => item.node_id === 'alpha').status, 'awaiting_dag')
  assert.equal(first.builds.find(item => item.node_id === 'beta').status, 'pending')

  // 人工确认 DAG → 完成待验收 → 验收后回填，产生 v2
  const alphaId = first.blocked.session_id
  await confirmBuildDag({ data_dir: dataDir, session_id: alphaId }, { llm })
  assert.equal((await getBuild({ data_dir: dataDir, session_id: alphaId })).status, 'awaiting_confirm')
  await acceptBuild({ data_dir: dataDir, session_id: alphaId }, { llm })
  const v2 = getFlow({ data_dir: dataDir, run_id: getSession({ data_dir: dataDir, session_id: 'prebuild-root' }).session.draft_run_id })
  assert.equal(v2.definition_version, 2)
  assert.ok(v2.definition.entry.steps[1].definition)

  // 第二个占位在回填出的新版本上继续
  const second = await prebuildFlow({ data_dir: dataDir, run_id: draft.id, step: true }, { llm })
  assert.equal(second.status, 'awaiting_dag')
  assert.equal(second.blocked.node_id, 'beta')
  const betaId = second.blocked.session_id
  await confirmBuildDag({ data_dir: dataDir, session_id: betaId }, { llm })
  await acceptBuild({ data_dir: dataDir, session_id: betaId }, { llm })

  const ready = await prebuildFlow({ data_dir: dataDir, run_id: draft.id }, { llm })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.remaining, 0)

  const v3 = getFlow({ data_dir: dataDir, run_id: ready.run_id })
  assert.equal(v3.definition_version, 3)
  assert.ok(v3.definition.entry.steps[1].definition)
  assert.ok(v3.definition.entry.steps[2].definition)
  assert.equal(getSessionRuns({ data_dir: dataDir, parent_session_id: 'prebuild-root' }).runs
    .find(run => run.id === v3.id).build_placeholders.length, 0)

  // 第1层（根层）有独立会话，两个占位子会话链式挂在它下面
  const tree = listSessionTree({ data_dir: dataDir, session_id: 'prebuild-root' })
  assert.equal(tree.roots[0].children.length, 1)
  assert.equal(tree.roots[0].children[0].id, 'sess-prebuild-root_layer1')
  assert.equal(tree.roots[0].children[0].name.includes('第1层'), true)
  assert.equal(tree.roots[0].children[0].children.length, 2)

  const completed = await confirmFlow({
    data_dir: dataDir, run_id: v3.id, action_id: v3.pending_actions[0].id, approved: true,
  }, { llm: sessionLlm() })
  assert.equal(completed.status, 'completed')

  // 非草稿不能预构建
  await assert.rejects(prebuildFlow({ data_dir: dataDir, run_id: ready.run_id }, { llm }), /只有草稿可以预构建/)
})

test('子会话需求不足时先澄清，回答后才生成骨架 DAG', async t => {
  const dataDir = workspace(t)
  const deps = { llm: sessionLlm({ definition: PLACEHOLDER_DEFINITION }), retrieveExperience: emptyExperience }
  const started = await intakeFlow({ data_dir: dataDir, parent_session_id: 'clarify-root', task: '生成报告' }, deps)
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })
  let analystCalls = 0
  const inner = handoffBuildLlm()
  const llm = {
    async complete(args) {
      if (args.system.includes('需求分析员')) {
        analystCalls += 1
        return {
          content: JSON.stringify(analystCalls === 1
            ? { sufficient: false, missing: ['叶子层终止行为'], questions: ['叶子层返回什么？'], assumptions: [] }
            : { sufficient: true, missing: [], questions: [], assumptions: ['叶子层返回 1'] }),
        }
      }
      return inner.complete(args)
    },
  }
  // 子会话受理后先做需求分析：信息不足就停在 clarifying，不生成 DAG、不编码
  const first = await prebuildFlow({ data_dir: dataDir, run_id: draft.id }, { llm })
  assert.equal(first.status, 'clarifying')
  assert.equal(first.blocked.node_id, 'report')
  assert.equal(first.blocked.status, 'clarifying')
  const childId = first.blocked.session_id
  const child = getSession({ data_dir: dataDir, session_id: childId })
  assert.equal(child.session.status, 'clarifying')
  assert.deepEqual(child.session.analysis.questions, ['叶子层返回什么？'])
  await assert.rejects(getBuild({ data_dir: dataDir, session_id: childId }), /没有构建|不存在/)

  // 回答后重新分析，信息足够才生成骨架 DAG，仍停在待确认 DAG
  await answerFlow({ data_dir: dataDir, session_id: childId, answer: '返回 1' }, { llm })
  const after = getSession({ data_dir: dataDir, session_id: childId })
  assert.equal(after.session.status, 'awaiting_dag')
  assert.equal((await getBuild({ data_dir: dataDir, session_id: childId })).status, 'awaiting_dag')
})

test('子会话 DAG 确认前可提意见并重新生成 DAG', async t => {
  const dataDir = workspace(t)
  const deps = { llm: sessionLlm({ definition: PLACEHOLDER_DEFINITION }), retrieveExperience: emptyExperience }
  const started = await intakeFlow({ data_dir: dataDir, parent_session_id: 'revise-root', task: '生成报告' }, deps)
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })
  const base = handoffBuildLlm()
  let skeletonCalls = 0
  let seenRevision = null
  let seenPrevious = null
  const llm = {
    async complete(args) {
      if (args.system.includes('工作流骨架拆解器')) {
        skeletonCalls += 1
        const payload = JSON.parse(args.user)
        if (payload.revision) {
          seenRevision = payload.revision
          seenPrevious = payload.previous_definition
          return {
            content: JSON.stringify({
              name: '修订版报告',
              summary: '按意见：加一节点改为脚本',
              children: [
                { id: 'build_next', role: 'group', intent: '构建剩余层占位', complexity: 3 },
                { id: 'add_one', role: 'script', intent: '读取子占位 value 加 1 返回', complexity: 1 },
              ],
            }),
          }
        }
      }
      return base.complete(args)
    },
  }
  const first = await prebuildFlow({ data_dir: dataDir, run_id: draft.id }, { llm })
  assert.equal(first.status, 'awaiting_dag')
  const childId = first.blocked.session_id
  const beforeBuild = await getBuild({ data_dir: dataDir, session_id: childId })
  assert.equal(beforeBuild.status, 'awaiting_dag')
  assert.equal(skeletonCalls, 1)
  // 待实现的脚本节点按骨架角色渲染，不能一律显示成子流程
  assert.equal(beforeBuild.readonly_definition.entry.type, 'script')

  // 提意见：丢弃旧骨架，按意见重新分析需求并生成新的 DAG，任务正文不变
  const revised = await reviseFlow({
    data_dir: dataDir, session_id: childId, instruction: '把加一的节点改成脚本，不要再包一层子流程',
  }, { llm })
  assert.equal(revised.session.status, 'awaiting_dag')
  assert.equal(skeletonCalls, 2)
  assert.equal(seenRevision.instruction, '把加一的节点改成脚本，不要再包一层子流程')
  assert.ok(seenPrevious?.entry)
  const afterBuild = await getBuild({ data_dir: dataDir, session_id: childId })
  assert.equal(afterBuild.status, 'awaiting_dag')
  assert.notEqual(afterBuild.build_id, beforeBuild.build_id)
  assert.ok(afterBuild.readonly_definition?.entry)
  // 修订后的 DAG 真正变了：出现脚本节点，且占位是子流程
  const afterSteps = afterBuild.readonly_definition.entry.steps || [afterBuild.readonly_definition.entry]
  assert.deepEqual(afterSteps.map(item => item.type), ['subflow', 'script'])
  assert.equal(revised.session.task, beforeBuild.task)
  const stack = loadBuildStack(dataDir, 'revise-root')
  assert.equal(stack.entries.find(item => item.session_id === childId).status, 'awaiting_dag')
})

test('构建栈：任一条目等待人工即整体暂停，兄弟条目不再驱动', async t => {
  const dataDir = workspace(t)
  const definition = {
    version: 1,
    name: '双子流程',
    entry: {
      id: 'seq', type: 'sequence',
      steps: [
        { id: 'seed', type: 'det', op: 'literal', value: { started: true } },
        { id: 'alpha', type: 'subflow', label: '子流程A', build: { task: '生成A', layers: 1, sample_input: { started: true } } },
        { id: 'beta', type: 'subflow', label: '子流程B', build: { task: '生成B', layers: 1, sample_input: { started: true } } },
      ],
    },
  }
  const deps = { llm: sessionLlm({ definition }), retrieveExperience: emptyExperience }
  const started = await intakeFlow({ data_dir: dataDir, parent_session_id: 'pause-root', task: '生成A与B' }, deps)
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })

  // 第一个占位的构建节点请求人工；第二个占位的实现计数用于验证未被驱动
  let betaCalls = 0
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return { name: '占位构建', children: [{ id: 'make', role: 'script', intent: '生成', complexity: 1 }] }
    }
    if (payload.task === '生成B') {
      betaCalls += 1
      return {
        decision: 'implement', complexity: 1,
        node: { id: 'make', type: 'script', runtime: 'node', output: 'json', code: 'process.stdout.write(JSON.stringify({ b: true }))' },
      }
    }
    return {
      decision: 'need_human',
      question: 'A 的输出格式？',
      options: ['json'],
      suggested_zoom: 'in',
      reason: '任务没写输出格式',
    }
  })

  // 子会话受理 → 需求分析 → 骨架 DAG，然后等人工确认 DAG
  const waitingDag = await prebuildFlow({ data_dir: dataDir, run_id: draft.id }, { llm })
  assert.equal(waitingDag.status, 'awaiting_dag')
  const alphaSession = waitingDag.blocked.session_id
  // 确认 DAG 后 alpha 请求人工，整栈暂停，beta 不再被驱动
  const paused = await confirmBuildDag({ data_dir: dataDir, session_id: alphaSession }, { llm })
  assert.equal(paused.build.status, 'waiting_human')
  assert.equal(paused.stack.status, 'waiting_human')
  const snapshot = await prebuildFlow({ data_dir: dataDir, run_id: draft.id }, { llm })
  assert.equal(snapshot.status, 'waiting_human')
  assert.equal(snapshot.builds.find(item => item.node_id === 'beta').status, 'pending')
  assert.equal(betaCalls, 0)
})

test('信箱：context/question 幂等收发与回复，bug_report 触发节点重建并自动回信', async t => {
  const fixture = await handoffFixture(t, { report: true })
  const { dataDir, draft, llm, childId } = fixture
  const built = await runBuild({ data_dir: dataDir, session_id: childId }, { llm })
  assert.equal(built.status, 'awaiting_dag')
  await confirmBuildDag({ data_dir: dataDir, session_id: childId }, { llm })
  assert.equal((await getBuild({ data_dir: dataDir, session_id: childId })).status, 'awaiting_confirm')
  // 先人工验收回填 v2，后续 bug_report 才有父草稿可升级
  await acceptBuild({ data_dir: dataDir, session_id: childId }, { llm })

  const question = await sendMail({
    data_dir: dataDir, session_id: 'handoff-root', to_session: childId,
    kind: 'question', subject: '确认报告范围', body: '报告需要包含哪些字段？', refs: { run_id: draft.id },
  }, { llm })
  assert.equal(question.reused, false)
  assert.equal(question.rebuild, null)
  assert.equal(question.mail.requires_reply, true)

  const again = await sendMail({
    data_dir: dataDir, session_id: 'handoff-root', to_session: childId,
    kind: 'question', subject: '确认报告范围', body: '报告需要包含哪些字段？', refs: { run_id: draft.id },
  }, { llm })
  assert.equal(again.reused, true)
  assert.equal(again.mail.id, question.mail.id)

  const childTree = listSessionTree({ data_dir: dataDir, session_id: childId })
  assert.equal(childTree.roots[0].unread_mail, 1)

  const inbox = inboxMail({ data_dir: dataDir, session_id: childId })
  assert.equal(inbox.unread, 1)
  assert.equal(inbox.marked_read, 1)
  assert.equal(inboxMail({ data_dir: dataDir, session_id: childId }).unread, 0)

  const replied = await replyMail({ data_dir: dataDir, session_id: childId, reply_to: question.mail.id, body: '包含 report 与来源。' })
  assert.equal(replied.mail.kind, 'answer')
  assert.equal(replied.mail.reply_to, question.mail.id)
  const rootInbox = inboxMail({ data_dir: dataDir, session_id: 'handoff-root', mark_read: false })
  assert.ok(rootInbox.mails.some(mail => mail.id === replied.mail.id))

  const mailbox = sessionMail({ data_dir: dataDir, session_id: childId })
  assert.equal(mailbox.root_session_id, 'handoff-root')
  assert.deepEqual(mailbox.mails.map(mail => mail.kind), ['question', 'answer'])
  assert.equal(mailbox.mails[0].from_name, getSession({ data_dir: dataDir, session_id: 'handoff-root' }).session.name)
  assert.equal(mailbox.mails[0].read, true)
  assert.equal(mailbox.mails[0].resolved, true)
  assert.equal(mailbox.unread, 0)
  assert.equal(mailbox.tree_unread, 1)
  assert.equal(mailbox.pending_reply, 0)
  const groups = listSessionGroups({ data_dir: dataDir })
  assert.equal(groups.sessions.find(item => item.id === 'handoff-root').unread_mail, 1)

  const panel = await startPanel({ data_dir: dataDir, port: 0 })
  t.after(() => stopPanel())
  const routed = await (await fetch(`${panel.url}/api/sessions/${childId}/mail`)).json()
  assert.equal(routed.root_session_id, 'handoff-root')
  assert.equal(routed.mails.length, 2)

  const bug = await sendMail({
    data_dir: dataDir, session_id: 'handoff-root', to_session: childId,
    kind: 'bug_report', subject: '报告实现有问题', body: '脚本没有输出 report 字段，请修复', refs: { run_id: draft.id, node_path: '/0' },
  }, { llm })
  assert.equal(bug.reused, false)
  assert.equal(bug.rebuild.applied, true)
  assert.equal(bug.rebuild.node_path, '/0')
  assert.equal(bug.rebuild.status, 'awaiting_confirm')
  // 子构建自己有可运行草稿；父草稿尚未被回填升级
  assert.equal(getFlow({ data_dir: dataDir, run_id: bug.rebuild.run_id }).status, 'draft')
  assert.equal(getSession({ data_dir: dataDir, session_id: 'handoff-root' }).session.status, 'awaiting_confirm')

  const buildView = await getBuild({ data_dir: dataDir, session_id: childId })
  assert.equal(buildView.history[0].action, 'mailbox')
  assert.equal(buildView.history[0].answer, '脚本没有输出 report 字段，请修复')
  assert.equal(buildView.history[0].path, '/0')

  // 验收后才回填父草稿，生成 v3
  await acceptBuild({ data_dir: dataDir, session_id: childId }, { llm })
  const v3 = getFlow({
    data_dir: dataDir,
    run_id: getSession({ data_dir: dataDir, session_id: 'handoff-root' }).session.draft_run_id,
  })
  assert.equal(v3.status, 'draft')
  assert.equal(v3.definition_version, 3)

  const answerInbox = inboxMail({ data_dir: dataDir, session_id: 'handoff-root', mark_read: false })
  const autoAnswer = answerInbox.mails.find(mail => mail.kind === 'answer' && mail.reply_to === bug.mail.id)
  assert.ok(autoAnswer)
  assert.equal(autoAnswer.from_session, childId)
})

test('信箱：跨根会话与非法 kind 被拒绝', async t => {
  const fixture = await handoffFixture(t, { report: true })
  const { dataDir, childId } = fixture
  const other = await intakeFlow({
    data_dir: dataDir, parent_session_id: 'another-root', task: '另一个会话',
  }, { llm: sessionLlm(), retrieveExperience: emptyExperience })
  assert.equal(other.session.id, 'another-root')

  await assert.rejects(sendMail({
    data_dir: dataDir, session_id: 'another-root', to_session: childId, kind: 'note', body: '越界',
  }), /同一个根会话树/)

  await assert.rejects(sendMail({
    data_dir: dataDir, session_id: 'handoff-root', to_session: childId, kind: 'unknown', body: 'x',
  }), /kind 仅支持/)
})

function humanHandoffLlm() {
  let nodeCalls = 0
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return {
        name: '人工下沉',
        children: [{ id: 'pick', role: 'llm', intent: '选择站点', complexity: 2 }],
      }
    }
    assert.equal(payload.node.id, 'pick')
    nodeCalls += 1
    if (nodeCalls === 1) {
      return {
        decision: 'need_human',
        question: '使用哪个站点？',
        options: ['A', 'B'],
        suggested_zoom: 'in',
        reason: '缺少站点范围',
      }
    }
    return {
      decision: 'implement',
      complexity: 1,
      node: {
        id: 'pick', type: 'script', runtime: 'node', output: 'json',
        code: 'process.stdout.write(JSON.stringify({ site: "A" }))',
      },
    }
  })
  return { llm, nodeCalls: () => nodeCalls }
}

async function humanHandoffFixture(t) {
  const dataDir = workspace(t)
  const intakeDeps = { llm: sessionLlm({ definition: PLACEHOLDER_DEFINITION }), retrieveExperience: emptyExperience }
  const started = await intakeFlow({ data_dir: dataDir, parent_session_id: 'handoff-root', task: '生成报告' }, intakeDeps)
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })
  const mock = humanHandoffLlm()
  const handed = await startBuild({ data_dir: dataDir, from_run_id: draft.id, node_id: 'report' }, { llm: mock.llm })
  const childId = handed.session_id
  const paused = await runBuild({ data_dir: dataDir, session_id: childId }, { llm: mock.llm })
  assert.equal(paused.status, 'awaiting_dag')
  const waiting = await confirmBuildDag({ data_dir: dataDir, session_id: childId }, { llm: mock.llm })
  assert.equal(waiting.status, 'waiting_human')
  return { dataDir, draft, childId, mock, waiting }
}

test('人工下沉：构建人工请求留在归属子会话，根会话只留指针并在子会话答复', async t => {
  const { dataDir, childId, mock } = await humanHandoffFixture(t)

  const root = getSession({ data_dir: dataDir, session_id: 'handoff-root' })
  assert.deepEqual(root.session.pending_human, [])
  assert.equal(root.delegated_human.length, 1)
  assert.equal(root.delegated_human[0].session_id, childId)
  assert.equal(root.delegated_human[0].kind, 'build_human')
  assert.equal(root.delegated_human[0].path, '/0')
  assert.equal(root.delegated_human[0].question, '使用哪个站点？')
  // 根会话的直接子会话只有第1层锚点，人工请求留在更深的占位子会话
  assert.deepEqual(root.children.map(item => item.id), ['sess-handoff-root_layer1'])
  assert.equal(root.build, null)

  const child = getSession({ data_dir: dataDir, session_id: childId })
  assert.equal(child.build.status, 'waiting_human')
  assert.equal(child.session.pending_human[0].question, '使用哪个站点？')
  assert.equal(child.delegated_human.length, 0)

  const tree = listSessionTree({ data_dir: dataDir, session_id: 'handoff-root' })
  assert.equal(tree.roots[0].pending_human, null)
  assert.equal(tree.roots[0].children[0].children[0].pending_human.kind, 'build_human')

  const rootInbox = inboxMail({ data_dir: dataDir, session_id: 'handoff-root', mark_read: false })
  const notice = rootInbox.mails.find(mail => mail.kind === 'question' && mail.from_session === childId)
  assert.ok(notice)
  assert.match(notice.subject, /构建人工请求/)

  const answered = await answerBuild({ data_dir: dataDir, session_id: childId, answer: '只用 A 站点' }, { llm: mock.llm })
  assert.equal(answered.status, 'awaiting_confirm')
  assert.equal(getFlow({ data_dir: dataDir, run_id: answered.run_id }).status, 'draft')
  assert.equal(answered.history[0].action, 'answer')
  assert.equal(mock.nodeCalls(), 2)

  const accepted = await acceptBuild({ data_dir: dataDir, session_id: childId }, { llm: mock.llm })
  assert.equal(accepted.status, 'accepted')
  const v2 = getFlow({
    data_dir: dataDir,
    run_id: getSession({ data_dir: dataDir, session_id: 'handoff-root' }).session.draft_run_id,
  })
  assert.equal(v2.status, 'draft')
  assert.equal(v2.definition_version, 2)
  assert.equal(getSession({ data_dir: dataDir, session_id: childId }).session.status, 'built')
  assert.ok(getSession({ data_dir: dataDir, session_id: 'handoff-root' })
    .session.mail_resolved.includes(notice.id))
})

test('人工下沉：父会话回复通知信即可继续子会话构建，无需切换会话', async t => {
  const { dataDir, childId, mock } = await humanHandoffFixture(t)
  const rootInbox = inboxMail({ data_dir: dataDir, session_id: 'handoff-root', mark_read: false })
  const notice = rootInbox.mails.find(mail => mail.kind === 'question' && mail.from_session === childId)
  assert.ok(notice)

  const replied = await replyMail({
    data_dir: dataDir, session_id: 'handoff-root', reply_to: notice.id, body: '只用 B 站点',
  }, { llm: mock.llm })
  assert.equal(replied.applied.applied, true)
  assert.equal(replied.applied.status, 'awaiting_confirm')
  assert.equal(mock.nodeCalls(), 2)

  const child = getSession({ data_dir: dataDir, session_id: childId })
  assert.equal(child.build.status, 'awaiting_confirm')
  assert.equal(getFlow({ data_dir: dataDir, run_id: child.build.run_id }).status, 'draft')
  await acceptBuild({ data_dir: dataDir, session_id: childId }, { llm: mock.llm })
  const v2 = getFlow({
    data_dir: dataDir,
    run_id: getSession({ data_dir: dataDir, session_id: 'handoff-root' }).session.draft_run_id,
  })
  assert.equal(v2.definition_version, 2)
  assert.ok(getSession({ data_dir: dataDir, session_id: 'handoff-root' })
    .session.mail_resolved.includes(notice.id))
})

test('多轮讨论：构建开始后收到的信件注入下一次节点会话并标记已读', async t => {
  const dataDir = workspace(t)
  const intakeDeps = { llm: sessionLlm({ definition: PLACEHOLDER_DEFINITION }), retrieveExperience: emptyExperience }
  const started = await intakeFlow({ data_dir: dataDir, parent_session_id: 'handoff-root', task: '生成报告' }, intakeDeps)
  const draft = getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id })
  const seen = []
  const llm = buildMock((system, payload) => {
    if (system.includes('工作流骨架拆解器')) {
      return { name: '注入上下文', children: [{ id: 'make', role: 'script', intent: '生成报告', complexity: 1 }] }
    }
    assert.equal(payload.node.id, 'make')
    seen.push(payload.mailbox)
    return {
      decision: 'implement',
      complexity: 1,
      node: {
        id: 'make', type: 'script', runtime: 'node', output: 'json',
        code: 'process.stdout.write(JSON.stringify({ report: true }))',
      },
    }
  })
  const handed = await startBuild({ data_dir: dataDir, from_run_id: draft.id, node_id: 'report' }, { llm })
  await sendMail({
    data_dir: dataDir, session_id: 'handoff-root', to_session: handed.session_id,
    kind: 'context', subject: '补充上下文', body: '报告必须包含 site 字段', refs: { run_id: draft.id },
  })
  assert.equal(inboxMail({ data_dir: dataDir, session_id: handed.session_id, mark_read: false }).unread, 1)

  const built = await runBuild({ data_dir: dataDir, session_id: handed.session_id }, { llm })
  assert.equal(built.status, 'awaiting_dag')
  await confirmBuildDag({ data_dir: dataDir, session_id: handed.session_id }, { llm })
  assert.equal(seen.length, 1)
  assert.ok(seen[0].some(mail => mail.subject === '补充上下文'))
  assert.equal(inboxMail({ data_dir: dataDir, session_id: handed.session_id }).unread, 0)
  const accepted = await acceptBuild({ data_dir: dataDir, session_id: handed.session_id }, { llm })
  assert.equal(accepted.status, 'accepted')
})

test('运行期人工下沉：按会话恢复等待链，结果向上回传且根运行只保留指针', async t => {
  const dataDir = workspace(t)
  const waiting = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'run-human',
    definition: {
      version: 1,
      entry: {
        id: 'root', type: 'sequence', steps: [
          {
            id: 'sub', type: 'subflow',
            definition: { version: 1, entry: { id: 'inner_human', type: 'human', prompt: '请确认站点' } },
          },
          det('after', { done: { var: '' } }),
        ],
      },
    },
  })
  assert.equal(waiting.status, 'waiting_human')
  assert.ok(waiting.pending.subflow_run_id)
  assert.equal(waiting.pending.subflow_run_id === waiting.id, false)

  const resumed = await resumeFlow({ data_dir: dataDir, session_id: 'run-human', input: { site: 'A' } })
  assert.equal(resumed.status, 'completed')
  assert.deepEqual(resumed.output, { done: { site: 'A' } })
  assert.equal(getFlow({ data_dir: dataDir, run_id: waiting.id }).status, 'completed')

  await assert.rejects(
    resumeFlow({ data_dir: dataDir, session_id: 'run-empty' }),
    /没有等待人工输入或暂停的运行/,
  )
})

function dshAlignmentMock() {
  const workspaces = new Map()
  const mirrors = []
  return {
    mirrors,
    workspaces,
    workspaceProvider: {
      async ensure({ path }) {
        mkdirSync(path, { recursive: true })
        if (!workspaces.has(path)) workspaces.set(path, `ws-${workspaces.size + 1}`)
        return { path, workspace_id: workspaces.get(path) }
      },
    },
    async sessionMirror(args) {
      mirrors.push(args)
      return {
        session_id: args.sessionId,
        path: args.workspace,
        workspace_id: workspaces.get(args.workspace) || null,
      }
    },
  }
}

function agentJson(args, value, mode = 'readonly') {
  return {
    text: JSON.stringify(value),
    session_id: args.sessionId,
    parent_session_id: args.parentSessionId || null,
    workspace: args.workspace,
    workspace_id: 'ws-agent',
    mode,
  }
}

test('dsh 对齐：构建保留骨架/节点真实会话，预检错误回灌且节点状态可观察', async t => {
  const dataDir = workspace(t)
  const dsh = dshAlignmentMock()
  const calls = []
  const observed = []
  const agentRunner = async args => {
    calls.push(args)
    return agentJson(args, {
      name: 'dsh 构建', children: [{ id: 'scan', role: 'script', intent: '输出结果', complexity: 1 }],
    })
  }
  const codingAgentRunner = async args => {
    calls.push(args)
    observed.push(await getBuild({ data_dir: dataDir, session_id: 'build-dsh' }))
    const invalid = calls.filter(call => call.sessionId.includes('-node-')).length === 1
    return agentJson(args, {
      decision: 'implement', complexity: 1,
      node: {
        id: 'scan', type: 'script', runtime: 'node', output: 'json',
        code: invalid ? 'const = 1' : 'process.stdout.write(JSON.stringify({ ok: true }))',
      },
    }, 'coding')
  }
  const deps = { ...dsh, agentRunner, codingAgentRunner }
  const started = await startBuild({ data_dir: dataDir, session_id: 'build-dsh', task: '构建并验证' }, deps)
  assert.equal(started.dsh_session_id, 'build-dsh')
  assert.ok(started.workspace_id)
  assert.equal(started.sessions[0].session_id, `${started.build_id}-skeleton-1`)
  assert.equal(started.sessions[0].parent_session_id, 'build-dsh')

  const built = await runBuild({ data_dir: dataDir, session_id: 'build-dsh' }, deps)
  assert.equal(built.status, 'awaiting_confirm')
  assert.equal(built.progress.sessions, 3)
  assert.deepEqual(built.sessions.map(item => item.status), ['completed', 'failed', 'completed'])
  assert.equal(new Set(built.sessions.map(item => item.session_id)).size, 3)
  assert.ok(built.sessions.every(item => item.parent_session_id === 'build-dsh'))
  assert.match(built.sessions[1].error, /语法预检失败/)
  assert.match(calls.at(-1).input.repair_instruction, /语法预检失败/)
  assert.equal(observed[0].status, 'building')
  assert.equal(observed[0].current_node.node_id, 'scan')
  assert.equal(observed[0].tree.children[0].status, 'building')
  const draft = getFlow({ data_dir: dataDir, run_id: built.run_id })
  assert.equal(draft.workspace_id, built.workspace_id)
  assert.equal(draft.dsh_session_id, 'build-dsh')
})

test('dsh 对齐：工作区变更新建镜像并同步草稿，重复变更递增修订号', async t => {
  const dataDir = workspace(t)
  const dsh = dshAlignmentMock()
  const deps = { ...dsh, llm: sessionLlm(), retrieveExperience: emptyExperience }
  const customDir = join(dataDir, 'aligned-custom')
  const started = await intakeFlow({
    data_dir: dataDir, session_id: 'sess-aligned', task: '管理工作区', workspace: customDir,
  }, deps)
  assert.equal(started.session.dsh_session_id, 'sess-aligned')
  assert.equal(started.session.workspace_revision, 0)
  assert.ok(started.session.workspace_id)
  assert.equal(started.runs[0].dsh_session_id, 'sess-aligned')

  const nextDir = join(dataDir, 'aligned-next')
  const moved = await configureWorkspace({ data_dir: dataDir, session_id: 'sess-aligned', workspace: nextDir }, deps)
  assert.equal(moved.session.workspace_revision, 1)
  assert.equal(moved.session.dsh_session_id, 'sess-aligned-ws-1')
  assert.equal(getFlow({ data_dir: dataDir, run_id: started.session.draft_run_id }).dsh_session_id, 'sess-aligned-ws-1')

  const reset = await configureWorkspace({ data_dir: dataDir, session_id: 'sess-aligned' }, deps)
  assert.equal(reset.session.workspace_revision, 2)
  assert.equal(reset.session.dsh_session_id, 'sess-aligned-ws-2')
  assert.deepEqual(dsh.mirrors.map(item => item.sessionId),
    ['sess-aligned', 'sess-sess-aligned_layer1', 'sess-aligned-ws-1', 'sess-aligned-ws-2'])
})

test('dsh 对齐：交接构建创建子镜像，节点会话归属子镜像且父草稿关联不变', async t => {
  const dataDir = workspace(t)
  const dsh = dshAlignmentMock()
  const llm = sessionLlm({ definition: PLACEHOLDER_DEFINITION })
  const started = await intakeFlow({
    data_dir: dataDir, parent_session_id: 'aligned-handoff', task: '生成报告',
  }, { ...dsh, llm, retrieveExperience: emptyExperience })
  const agentRunner = async args => agentJson(args, args.system.includes('工作流骨架拆解器') ? {
    name: '子流程构建', children: [{ id: 'make', role: 'script', intent: '生成结果', complexity: 1 }],
  } : {
    decision: 'implement', complexity: 1,
    node: { id: args.input.node.id, type: 'det', op: 'literal', value: { report: true } },
  })
  const handed = await startBuild({
    data_dir: dataDir, from_run_id: started.session.draft_run_id, node_id: 'report',
  }, { ...dsh, agentRunner })
  assert.equal(handed.dsh_session_id, handed.session_id)
  assert.ok(handed.workspace_id)
  assert.equal(handed.sessions[0].parent_session_id, handed.session_id)
  assert.equal(dsh.mirrors.at(-1).sessionId, handed.session_id)
  // 第1层独立镜像挂在发起会话下，子镜像再挂到第1层，dsh 侧栏按 parentSession 渲染成层链
  const layerMirror = dsh.mirrors.find(item => item.sessionId === 'sess-aligned-handoff_layer1')
  assert.equal(layerMirror.parentSessionId, 'aligned-handoff')
  assert.equal(dsh.mirrors.at(-1).parentSessionId, 'sess-aligned-handoff_layer1')
  const child = getSession({ data_dir: dataDir, session_id: handed.session_id })
  assert.equal(child.session.dsh_session_id, handed.session_id)

  const built = await runBuild({ data_dir: dataDir, session_id: handed.session_id }, { ...dsh, agentRunner })
  assert.equal(built.status, 'awaiting_dag')
  const confirmed = await confirmBuildDag({ data_dir: dataDir, session_id: handed.session_id }, { ...dsh, agentRunner })
  assert.equal(confirmed.status, 'awaiting_confirm')
  assert.ok(confirmed.build.sessions.every(item => item.parent_session_id === handed.session_id))
  await acceptBuild({ data_dir: dataDir, session_id: handed.session_id }, { ...dsh, agentRunner })
  const parentDraft = getFlow({
    data_dir: dataDir,
    run_id: getSession({ data_dir: dataDir, session_id: 'aligned-handoff' }).session.draft_run_id,
  })
  assert.equal(parentDraft.dsh_session_id, 'aligned-handoff')
  assert.equal(parentDraft.workspace_id, started.session.workspace_id)
})

test('dsh 对齐：预构建先建第1层会话并挂在发起会话下，占位子会话链式挂到第1层', async t => {
  const dataDir = workspace(t)
  const dsh = dshAlignmentMock()
  const intake = await intakeFlow({
    data_dir: dataDir, parent_session_id: 'layer-root', task: '生成报告',
  }, { ...dsh, llm: sessionLlm({ definition: PLACEHOLDER_DEFINITION }), retrieveExperience: emptyExperience })
  const draft = getFlow({ data_dir: dataDir, run_id: intake.session.draft_run_id })
  // 规划完成时第1层会话就存在（待确认），不需要等预构建
  assert.equal(getSession({ data_dir: dataDir, session_id: 'sess-layer-root_layer1' }).session.status, 'awaiting_confirm')
  const prebuilt = await prebuildFlow({ data_dir: dataDir, run_id: draft.id }, { ...dsh, llm: handoffBuildLlm() })

  // 第1层（根层）有自己的会话与 dsh 镜像，挂在发起会话下
  const layer = getSession({ data_dir: dataDir, session_id: 'sess-layer-root_layer1' })
  assert.equal(layer.session.parent_session_id, 'layer-root')
  assert.equal(layer.session.depth, 1)
  assert.equal(layer.session.dsh_session_id, 'sess-layer-root_layer1')
  assert.equal(layer.session.origin.layer, 1)
  assert.equal(layer.build, null)
  assert.equal(dsh.mirrors.find(item => item.sessionId === 'sess-layer-root_layer1').parentSessionId, 'layer-root')

  // 第2层占位会话挂在第1层下，镜像父级也是第1层镜像
  const childId = prebuilt.blocked.session_id
  const child = getSession({ data_dir: dataDir, session_id: childId })
  assert.equal(child.session.parent_session_id, 'sess-layer-root_layer1')
  assert.equal(child.session.root_session_id, 'layer-root')
  assert.equal(dsh.mirrors.find(item => item.sessionId === childId).parentSessionId, 'sess-layer-root_layer1')

  // 第1层只是层级锚点，不承担需求分析或节点编码：只有规划期与预构建开始两条系统消息
  assert.equal(layer.session.analysis, null)
  assert.equal(layer.session.messages.length, 2)
  assert.equal(layer.session.status, 'building')
})

test('自动修复：.mjs 的 require 错误回灌编码会话，局部修复后自动重跑成功', async t => {
  const dataDir = workspace(t)
  const calls = []
  const codingAgentRunner = async args => {
    calls.push(args)
    return agentJson(args, {
      node: {
        id: 'esm', type: 'script', runtime: 'node', output: 'json',
        code: 'process.stdout.write(JSON.stringify({ ok: true }))',
      },
    }, 'coding')
  }
  const repaired = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'repair-esm',
    definition: {
      version: 1,
      entry: {
        id: 'esm', type: 'script', runtime: 'node', output: 'json',
        code: "const fs = require('node:fs')\nprocess.stdout.write(JSON.stringify({ ok: Boolean(fs) }))",
      },
    },
  }, { autoRepair: true, codingAgentRunner })
  assert.equal(repaired.status, 'completed')
  assert.deepEqual(repaired.output, { ok: true })
  assert.equal(repaired.definition_version, 2)
  assert.equal(repaired.repair_state.status, 'repaired')
  assert.equal(repaired.repairs.length, 1)
  assert.equal(repaired.repairs[0].dsh_session_id, `${repaired.previous_run_id}-repair-1`)
  assert.match(JSON.stringify(calls[0].input.error), /require/)
  assert.equal(calls[0].sessionId, `${repaired.previous_run_id}-repair-1`)
  assert.equal(getFlow({ data_dir: dataDir, run_id: repaired.previous_run_id }).status, 'superseded')
})

test('自动修复：最多修复两次，仍失败则 exhausted 并保留全部修复会话', async t => {
  const dataDir = workspace(t)
  const calls = []
  const codingAgentRunner = async args => {
    calls.push(args)
    return agentJson(args, {
      node: { id: 'broken', type: 'script', runtime: 'node', code: "throw new Error('still broken')" },
    }, 'coding')
  }
  const failed = await startFlow({
    data_dir: dataDir,
    parent_session_id: 'repair-limit',
    definition: {
      version: 1,
      entry: { id: 'broken', type: 'script', runtime: 'node', code: "throw new Error('still broken')" },
    },
  }, { autoRepair: true, codingAgentRunner })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.definition_version, 3)
  assert.equal(failed.repair_state.status, 'exhausted')
  assert.equal(failed.repair_state.attempts, 2)
  assert.equal(failed.repairs.length, 2)
  assert.equal(calls.length, 2)
  assert.equal(new Set(failed.repairs.map(item => item.dsh_session_id)).size, 2)
  assert.match(failed.error.message, /still broken/)
})

test('dsh 宿主只等待必需服务，无 WorkspaceRegistry 时可加载并本地执行', async t => {
  const dataDir = workspace(t)
  const registered = new Map()
  t.after(() => configureHost({ autoRepair: true }))
  assert.deepEqual(dshHostInject, ['tools', 'agents'])

  applyDshHost({
    agents: {},
    get: () => undefined,
    on: () => () => {},
    effect: callback => callback(),
    tools: {
      register: tool => registered.set(tool.name, tool),
      schemas: () => [],
    },
  })

  const completed = JSON.parse(await registered.get('flow_start').execute({
    data_dir: dataDir,
    parent_session_id: 'host-without-workspace',
    definition: {
      version: 1,
      entry: { id: 'local', type: 'det', op: 'literal', value: { ok: true } },
    },
  }))
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output, { ok: true })
  assert.equal(completed.workspace_id, null)
  assert.equal(completed.dsh_session_id, null)

  await intakeFlow({
    data_dir: dataDir, session_id: 'host-local-workspace', task: '本地工作区降级',
  }, { llm: sessionLlm(), retrieveExperience: emptyExperience })
  const aligned = JSON.parse(await registered.get('flow_workspace').execute({
    data_dir: dataDir,
    session_id: 'host-local-workspace',
  }))
  assert.equal(aligned.session.workspace_id, null)
  assert.equal(aligned.session.dsh_session_id, null)
})

test('dsh 宿主在调用时获取晚就绪的 WorkspaceRegistry 并对齐镜像会话', async t => {
  const dataDir = workspace(t)
  const registered = new Map()
  const attached = []
  const mirrors = []
  let registry
  let creates = 0
  t.after(() => configureHost({ autoRepair: true }))

  await intakeFlow({
    data_dir: dataDir, session_id: 'host-late-workspace', task: '晚就绪工作区',
  }, { llm: sessionLlm(), retrieveExperience: emptyExperience })
  applyDshHost({
    agents: {
      get: () => undefined,
      async create({ sessionId, meta }) {
        mirrors.push({ sessionId, cwd: meta.cwd })
        return {
          agent: {
            session: {
              header: { id: sessionId, cwd: meta.cwd },
              append: () => {},
            },
          },
          dispose: async () => {},
        }
      },
    },
    get: name => name === 'workspaceRegistry' ? registry : undefined,
    on: () => () => {},
    effect: callback => callback(),
    tools: {
      register: tool => registered.set(tool.name, tool),
      schemas: () => [],
    },
  })
  assert.equal(creates, 0)

  const nextDir = join(dataDir, 'late-workspace')
  const dshWorkspace = {
    id: 'ws-late',
    path: nextDir,
    attachSession: async sessionId => attached.push(sessionId),
  }
  registry = {
    create: async path => {
      creates += 1
      assert.equal(path, nextDir)
      return dshWorkspace
    },
    get: id => id === dshWorkspace.id ? dshWorkspace : undefined,
    resolveByPath: async path => path === nextDir ? dshWorkspace : undefined,
  }

  const aligned = JSON.parse(await registered.get('flow_workspace').execute({
    data_dir: dataDir,
    session_id: 'host-late-workspace',
    workspace: nextDir,
  }))
  assert.ok(creates > 0)
  assert.equal(aligned.session.workspace_id, 'ws-late')
  assert.equal(aligned.session.dsh_session_id, 'host-late-workspace-ws-1')
  assert.deepEqual(attached, ['host-late-workspace-ws-1'])
  assert.deepEqual(mirrors, [{ sessionId: 'host-late-workspace-ws-1', cwd: nextDir }])
})

test('dsh 宿主：节点隔离目录的会话不挂 Workspace，骨架/构建会话正常挂载', async t => {
  const dataDir = workspace(t)
  const registered = new Map()
  const listeners = new Set()
  const created = []
  const attached = []
  t.after(() => configureHost({ autoRepair: true }))

  // dsh Workspace 只接纳 cwd 恰好等于自身路径的会话；节点隔离目录不满足这一点。
  const dshWorkspace = {
    id: 'ws-node',
    path: null,
    attachSession: async sessionId => { attached.push(sessionId) },
  }
  const registry = {
    async create(path) {
      dshWorkspace.path = path
      return dshWorkspace
    },
    get: id => id === dshWorkspace.id ? dshWorkspace : undefined,
    resolveByPath: async () => dshWorkspace,
  }
  const skeletonReply = JSON.stringify({
    name: '隔离节点',
    children: [{ id: 'scan', role: 'script', intent: '输出结果', complexity: 1 }],
  })
  const nodeReply = JSON.stringify({
    decision: 'implement',
    complexity: 1,
    node: { id: 'scan', type: 'script', runtime: 'node', output: 'json', code: 'process.stdout.write(JSON.stringify({ ok: true }))' },
  })
  const emit = (sessionId, text) => {
    for (const listener of listeners) {
      listener({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    }
  }
  applyDshHost({
    agents: {
      get: () => undefined,
      async create({ sessionId, meta }) {
        created.push({ sessionId, cwd: meta.cwd, origin: meta.origin || null })
        return {
          agent: {
            session: { header: { id: sessionId, cwd: meta.cwd }, append: () => {} },
            followup(message) {
              const text = message.content[0].text
              emit(sessionId, text.includes('工作流骨架拆解器') ? skeletonReply : nodeReply)
            },
            whenIdle: async () => {},
          },
          dispose: async () => {},
        }
      },
    },
    get: name => name === 'workspaceRegistry' ? registry : undefined,
    on: (event, callback) => {
      if (event === 'session/event') listeners.add(callback)
      return () => listeners.delete(callback)
    },
    effect: callback => callback(),
    tools: { register: tool => registered.set(tool.name, tool), schemas: () => [] },
  })

  const started = JSON.parse(await registered.get('flow_build').execute({
    data_dir: dataDir, action: 'start', session_id: 'host-node-build', task: '单节点构建',
  }))
  const built = JSON.parse(await registered.get('flow_build').execute({
    data_dir: dataDir, action: 'run', session_id: 'host-node-build',
  }))
  assert.equal(built.status, 'awaiting_confirm')

  // 节点编码会话在 .flow-nodes 隔离目录：不挂 Workspace，并以 subagent 来源避免侧栏散落
  const nodeSession = created.find(item => item.cwd.includes('.flow-nodes'))
  assert.ok(nodeSession)
  assert.equal(nodeSession.origin, 'subagent')
  assert.equal(attached.includes(nodeSession.sessionId), false)
  // 骨架会话仍在工作目录内，正常挂到 Workspace
  assert.equal(attached.includes(started.sessions[0].session_id), true)
})

function restoreEnv(t, values) {
  const saved = new Map(values.map(key => [key, process.env[key]]))
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('面板脚本可解析：模板字符串改动不破坏整体渲染', () => {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, 'panel/index.html 应包含内联脚本')
  assert.doesNotThrow(() => new Function(match[1]))
})

test('llm：max_tokens 截断（含带残片）一律放大额度重试，残缺输出不外泄', async t => {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      calls.push(JSON.parse(body))
      res.setHeader('content-type', 'application/json')
      if (calls.length === 1) {
        // 模拟截断：已有部分内容但 finish_reason=length，残片 JSON 不完整
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"decision":"implement","node":{"id":"x","type":"subflow","definition":{"version":1,' }, finish_reason: 'length' }],
        }))
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  restoreEnv(t, ['RMS_FLOW_LLM_BASE_URL', 'RMS_FLOW_LLM_API_KEY', 'RMS_FLOW_LLM_MODEL', 'RMS_FLOW_LLM_PROTOCOL', 'RMS_FLOW_LLM_MAX_TOKENS'])
  process.env.RMS_FLOW_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  process.env.RMS_FLOW_LLM_API_KEY = 'test-key'
  process.env.RMS_FLOW_LLM_MODEL = 'test-model'
  process.env.RMS_FLOW_LLM_PROTOCOL = 'openai'
  process.env.RMS_FLOW_LLM_MAX_TOKENS = '1000'
  const result = await createLlmExecutor().complete({ system: 's', user: 'u' })
  assert.equal(result.content, '{"ok":true}')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].max_tokens, 1000)
  assert.equal(calls[1].max_tokens, 2000)
})

test('llm：anthropic 协议 stop_reason=max_tokens 时同样重试，两次截断才报错', async t => {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      calls.push(JSON.parse(body))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        content: [{ type: 'text', text: '{"decision":"implement","node":{"id":"x","type":"subflow","definition":{"version":1,' }],
        stop_reason: 'max_tokens',
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  restoreEnv(t, ['RMS_FLOW_LLM_BASE_URL', 'RMS_FLOW_LLM_API_KEY', 'RMS_FLOW_LLM_MODEL', 'RMS_FLOW_LLM_PROTOCOL', 'RMS_FLOW_LLM_MAX_TOKENS'])
  process.env.RMS_FLOW_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/anthropic`
  process.env.RMS_FLOW_LLM_API_KEY = 'test-key'
  process.env.RMS_FLOW_LLM_MODEL = 'test-model'
  process.env.RMS_FLOW_LLM_PROTOCOL = 'anthropic'
  process.env.RMS_FLOW_LLM_MAX_TOKENS = '1000'
  await assert.rejects(() => createLlmExecutor().complete({ system: 's', user: 'u' }), /max_tokens 截断/)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].max_tokens, 1000)
  assert.equal(calls[1].max_tokens, 2000)
})

