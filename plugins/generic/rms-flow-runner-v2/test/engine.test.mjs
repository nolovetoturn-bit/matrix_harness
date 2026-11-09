import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { prepareRunPackage } from '../lib/engine/compile.mjs'

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `flow-engine-${label}-`))
}

function runPipeline(runDir, runId) {
  return spawnSync(process.execPath, ['pipeline.mjs'], {
    cwd: runDir,
    env: { ...process.env, RMS_RUN_DIR: runDir, RMS_RUN_ID: runId },
    encoding: 'utf8',
    timeout: 120000,
  })
}

function runMessage(result) {
  return `exit=${result.status}\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`
}

const WRITE_HELLO = `
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.RMS_RUN_DIR
const counter = path.join(dir, 'counter.txt')
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0
fs.writeFileSync(counter, String(count + 1))
const text = 'hello world'
const target = path.join(dir, 'hello.txt')
fs.writeFileSync(target, text, 'utf8')
fs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ path: target, text }))
`.trim()

const READ_HELLO = `
const fs = require('node:fs')
const input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'))
const text = fs.readFileSync(input.path, 'utf8')
fs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ text, length: text.length }))
`.trim()

const FOLD_ADD = `
const fs = require('node:fs')
const input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'))
const value = (input.acc || 0) + input.item
fs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify(value))
`.trim()

test('Node 运行时：两个 script 节点串联、产物落盘与缓存命中', async () => {
  const dataDir = tempDir('scripts')
  const run = {
    id: 'run-engine01',
    matrix_id: 'mx_engine01',
    root_matrix_id: 'mx_engine01',
    name: 'hello pipeline',
    input: { seed: 'seed-value' },
    io_mode: 'files',
  }
  const matrix = { id: 'mx_engine01', root_id: 'mx_engine01', name: 'hello pipeline', execution_mode: 'files' }
  const definition = {
    version: 1,
    name: 'hello pipeline',
    entry: {
      id: 'root',
      type: 'sequence',
      label: '根节点',
      steps: [
        { id: 'write_hello', type: 'script', label: '写入 hello.txt', runtime: 'node', code: WRITE_HELLO, output: 'json' },
        { id: 'read_hello', type: 'script', label: '读取 hello.txt', runtime: 'node', code: READ_HELLO, output: 'json' },
      ],
    },
  }

  try {
    const bridgeUrl = 'http://192.168.34.5:3080/flow-runner-v2'
    const prepared = await prepareRunPackage({ dataDir, run, definition, matrix, bridgeUrl })
    assert.equal(prepared.dir, join(dataDir, 'runs', run.id))
    assert.ok(existsSync(prepared.manifest_path))
    assert.ok(existsSync(prepared.pipeline_path))
    assert.ok(existsSync(join(prepared.dir, 'runtime.mjs')))
    assert.ok(existsSync(join(prepared.dir, 'state', 'bridge-token')))

    const manifest = JSON.parse(readFileSync(prepared.manifest_path, 'utf8'))
    assert.equal(manifest.version, 1)
    assert.equal(manifest.engine, 'node')
    assert.equal(manifest.run_id, run.id)
    assert.equal(manifest.bridge.base_url, bridgeUrl)
    assert.ok(manifest.nodes['/root/write_hello'])
    assert.ok(manifest.nodes['/root/read_hello'])
    assert.equal(manifest.nodes['/root/write_hello'].script.file, 'work/main.cjs')
    assert.equal(manifest.nodes['/root/write_hello'].dir, 'nodes/root_write_hello')

    const pipeline = readFileSync(prepared.pipeline_path, 'utf8')
    assert.ok(pipeline.startsWith("import { createRuntime, StepFailure } from './runtime.mjs'"))
    assert.ok(pipeline.includes("runtime.step(\"/root/write_hello\""))
    assert.ok(pipeline.includes("runtime.step(\"/root/read_hello\""))

    const first = runPipeline(prepared.dir, run.id)
    assert.equal(first.status, 0, runMessage(first))
    const output = JSON.parse(readFileSync(join(prepared.dir, 'output.json'), 'utf8'))
    assert.deepEqual(output, { text: 'hello world', length: 11 })

    const writeDir = join(prepared.dir, 'nodes', 'root_write_hello')
    assert.ok(existsSync(join(writeDir, 'input.json')))
    assert.ok(existsSync(join(writeDir, 'output.json')))
    assert.ok(existsSync(join(prepared.dir, 'run.log')))
    assert.ok(existsSync(join(prepared.dir, 'workspace', 'hello.txt')))

    // 第二次执行必须命中缓存：脚本里的计数文件不应再增加
    const counterFile = join(prepared.dir, 'workspace', 'counter.txt')
    const executedOnce = Number(readFileSync(counterFile, 'utf8'))
    const second = runPipeline(prepared.dir, run.id)
    assert.equal(second.status, 0, runMessage(second))
    const executedTwice = Number(readFileSync(counterFile, 'utf8'))
    assert.equal(executedTwice, executedOnce, '缓存命中时脚本不应再次执行')
    const rerunOutput = JSON.parse(readFileSync(join(prepared.dir, 'output.json'), 'utf8'))
    assert.deepEqual(rerunOutput, output)
    assert.ok(readFileSync(join(prepared.dir, 'run.log'), 'utf8').includes('reused'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

const FANOUT_PLUS_ONE = `
const fs = require('node:fs')
const path = require('node:path')
const input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'))
const counter = path.join(process.env.RMS_RUN_DIR, 'plus_one.count')
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0
fs.writeFileSync(counter, String(count + 1))
fs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ result: input.value + 1 }))
`.trim()

const FANOUT_KEEP = `
const fs = require('node:fs')
const input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'))
fs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ value: input.value }))
`.trim()

const FANOUT_FLAKY = `
const fs = require('node:fs')
const path = require('node:path')
const marker = path.join(process.env.RMS_RUN_DIR, 'flaky.marker')
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1')
  process.exit(3)
}
const input = JSON.parse(fs.readFileSync(process.env.RMS_INPUT_FILE, 'utf8'))
fs.writeFileSync(process.env.RMS_OUTPUT_FILE, JSON.stringify({ value: input.value }))
`.trim()

function fanoutDefinition(flaky = false) {
  const branches = [{
    id: 'plus_one',
    type: 'script',
    label: '加一',
    runtime: 'node',
    code: FANOUT_PLUS_ONE,
    output: 'json',
  }]
  if (flaky) {
    branches.push({
      id: 'keep',
      type: 'script',
      label: '保留原值',
      runtime: 'node',
      code: FANOUT_FLAKY,
      output: 'json',
    })
  }
  return {
    version: 1,
    name: 'fanout pipeline',
    entry: {
      id: 'root',
      type: 'sequence',
      label: '根节点',
      steps: [
        {
          id: 'calc',
          type: 'fanout',
          label: '并行计算',
          inputs: { value: 'number' },
          outputs: flaky
            ? { plus_one: 'object', keep: 'object' }
            : { plus_one: 'object', value: 'number' },
          ...(flaky ? {} : { carry: ['value'] }),
          collect: 'keyed',
          branches,
        },
        {
          id: 'join',
          type: 'merge',
          label: '汇合',
          inputs: flaky
            ? { plus_one: 'object', keep: 'object' }
            : { plus_one: 'object', value: 'number' },
          outputs: { value: 'number', result: 'number' },
          mapping: flaky
            ? { value: { var: 'keep.value' }, result: { var: 'plus_one.result' } }
            : { value: { var: 'value' }, result: { var: 'plus_one.result' } },
        },
      ],
    },
  }
}

test('Node 运行时：fanout 并发分发、keyed 汇总、merge 重组与分支缓存', async () => {
  const dataDir = tempDir('fanout')
  const run = {
    id: 'run-fanout01',
    matrix_id: 'mx_fanout01',
    root_matrix_id: 'mx_fanout01',
    name: 'fanout pipeline',
    input: { value: 77 },
    io_mode: 'files',
  }
  const matrix = { id: 'mx_fanout01', root_id: 'mx_fanout01', name: 'fanout pipeline', execution_mode: 'files' }
  try {
    const prepared = await prepareRunPackage({ dataDir, run, definition: fanoutDefinition(), matrix })
    const manifest = JSON.parse(readFileSync(prepared.manifest_path, 'utf8'))
    assert.ok(manifest.nodes['/root/calc/plus_one'])
    assert.ok(!manifest.nodes['/root/calc/keep'], 'carry 方案不应再生成透传分支')
    assert.equal(manifest.control.steps[0].kind, 'fanout')
    assert.equal(manifest.control.steps[0].collect, 'keyed')
    assert.equal(manifest.control.steps[1].kind, 'merge')

    const pipeline = readFileSync(prepared.pipeline_path, 'utf8')
    assert.ok(pipeline.includes('runtime.fanout('))
    assert.ok(pipeline.includes('runtime.merge('))

    const first = runPipeline(prepared.dir, run.id)
    assert.equal(first.status, 0, runMessage(first))
    const output = JSON.parse(readFileSync(join(prepared.dir, 'output.json'), 'utf8'))
    assert.deepEqual(output, { value: 77, result: 78 })

    // fanout/merge 是传值控制节点：不写 nodes 产物，只有分支节点落盘
    assert.ok(!existsSync(join(prepared.dir, 'nodes', 'root_calc')), 'fanout 不应生成执行产物')
    assert.ok(!existsSync(join(prepared.dir, 'nodes', 'root_join')), 'merge 不应生成执行产物')
    {
      const dir = join(prepared.dir, 'nodes', 'root_calc_plus_one')
      assert.ok(existsSync(join(dir, 'input.json'), '缺少分支 plus_one 的 input.json'))
      assert.ok(existsSync(join(dir, 'output.json'), '缺少分支 plus_one 的 output.json'))
    }
    assert.ok(readFileSync(join(prepared.dir, 'run.log'), 'utf8').includes('fanout_end'))

    // 重跑命中分支缓存：分支脚本不应再次执行
    const counters = ['plus_one']
    for (const name of counters) {
      const file = join(prepared.dir, 'workspace', `${name}.count`)
      assert.equal(Number(readFileSync(file, 'utf8')), 1)
    }
    const second = runPipeline(prepared.dir, run.id)
    assert.equal(second.status, 0, runMessage(second))
    for (const name of counters) {
      const file = join(prepared.dir, 'workspace', `${name}.count`)
      assert.equal(Number(readFileSync(file, 'utf8')), 1, '缓存命中时分支脚本不应再次执行')
    }
    const rerunOutput = JSON.parse(readFileSync(join(prepared.dir, 'output.json'), 'utf8'))
    assert.deepEqual(rerunOutput, output)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('Node 运行时：fanout 单个分支失败后只重跑该分支', async () => {
  const dataDir = tempDir('fanout-retry')
  const run = {
    id: 'run-fanout02',
    matrix_id: 'mx_fanout02',
    root_matrix_id: 'mx_fanout02',
    name: 'fanout retry',
    input: { value: 10 },
    io_mode: 'files',
  }
  const matrix = { id: 'mx_fanout02', root_id: 'mx_fanout02', name: 'fanout retry', execution_mode: 'files' }
  try {
    const prepared = await prepareRunPackage({ dataDir, run, definition: fanoutDefinition(true), matrix })
    const first = runPipeline(prepared.dir, run.id)
    assert.notEqual(first.status, 0, runMessage(first))
    const error = JSON.parse(readFileSync(join(prepared.dir, 'error.json'), 'utf8'))
    assert.equal(error.path, '/root/calc/keep')
    assert.equal(Number(readFileSync(join(prepared.dir, 'workspace', 'plus_one.count'), 'utf8')), 1)

    const second = runPipeline(prepared.dir, run.id)
    assert.equal(second.status, 0, runMessage(second))
    assert.equal(Number(readFileSync(join(prepared.dir, 'workspace', 'plus_one.count'), 'utf8')), 1, '成功分支应直接复用缓存')
    const output = JSON.parse(readFileSync(join(prepared.dir, 'output.json'), 'utf8'))
    assert.deepEqual(output, { value: 10, result: 11 })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('Node 运行时：fanout collect=array 按声明顺序汇总', async () => {
  const dataDir = tempDir('fanout-array')
  const run = {
    id: 'run-fanout03',
    matrix_id: 'mx_fanout03',
    root_matrix_id: 'mx_fanout03',
    name: 'fanout array',
    input: { value: 5 },
    io_mode: 'files',
  }
  const matrix = { id: 'mx_fanout03', root_id: 'mx_fanout03', name: 'fanout array', execution_mode: 'files' }
  const definition = {
    version: 1,
    name: 'fanout array',
    entry: {
      id: 'root',
      type: 'fanout',
      label: '并行',
      outputs: { plus_one: 'object', keep: 'object' },
      collect: 'array',
      branches: [
        { id: 'plus_one', type: 'script', runtime: 'node', code: FANOUT_PLUS_ONE, output: 'json' },
        { id: 'keep', type: 'script', runtime: 'node', code: FANOUT_KEEP, output: 'json' },
      ],
    },
  }
  try {
    const prepared = await prepareRunPackage({ dataDir, run, definition, matrix })
    const result = runPipeline(prepared.dir, run.id)
    assert.equal(result.status, 0, runMessage(result))
    const output = JSON.parse(readFileSync(join(prepared.dir, 'output.json'), 'utf8'))
    assert.deepEqual(output, [{ result: 6 }, { value: 5 }])
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('Node 运行时：fold 生成真实循环、按迭代落盘产物', async () => {
  const dataDir = tempDir('fold')
  const run = {
    id: 'run-fold01',
    matrix_id: 'mx_fold01',
    root_matrix_id: 'mx_fold01',
    name: 'fold pipeline',
    input: null,
    io_mode: 'files',
  }
  const matrix = { id: 'mx_fold01', root_id: 'mx_fold01', name: 'fold pipeline', execution_mode: 'files' }
  const definition = {
    version: 1,
    name: 'fold pipeline',
    entry: {
      id: 'root',
      type: 'sequence',
      label: '根节点',
      steps: [
        { id: 'make_items', type: 'det', label: '构造数组', op: 'literal', value: [1, 2, 3, 4] },
        {
          id: 'sum',
          type: 'fold',
          label: '累加',
          items: { var: '' },
          initial: 0,
          body: { id: 'add', type: 'script', label: '相加', runtime: 'node', code: FOLD_ADD, output: 'json' },
        },
      ],
    },
  }

  try {
    const prepared = await prepareRunPackage({ dataDir, run, definition, matrix })
    const manifest = JSON.parse(readFileSync(prepared.manifest_path, 'utf8'))
    assert.ok(manifest.nodes['/root/make_items'])
    assert.ok(manifest.nodes['/root/sum/item:{index}/add'])

    const pipeline = readFileSync(prepared.pipeline_path, 'utf8')
    assert.ok(pipeline.includes('runtime.items('))
    assert.ok(pipeline.includes('for (let'))

    const result = runPipeline(prepared.dir, run.id)
    assert.equal(result.status, 0, runMessage(result))
    const output = JSON.parse(readFileSync(join(prepared.dir, 'output.json'), 'utf8'))
    assert.equal(output, 10)

    for (let index = 0; index < 4; index += 1) {
      const iterationDir = join(prepared.dir, 'nodes', `root_sum_item_${index}_add`)
      assert.ok(existsSync(join(iterationDir, 'input.json')), `缺少第 ${index} 次迭代 input.json`)
      assert.ok(existsSync(join(iterationDir, 'output.json')), `缺少第 ${index} 次迭代 output.json`)
      const cachedInput = JSON.parse(readFileSync(join(iterationDir, 'input.json'), 'utf8'))
      assert.equal(cachedInput.index, index)
      assert.equal(cachedInput.item, index + 1)
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
