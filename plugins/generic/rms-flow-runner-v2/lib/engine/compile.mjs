import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hashNode } from '../runner.mjs'

const engineDir = dirname(fileURLToPath(import.meta.url))
const CONTROL_TYPES = new Set(['sequence', 'branch', 'fold', 'loop', 'or_else', 'fanout', 'merge'])
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3080/flow-runner-v2'

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => (value === undefined ? null : structuredClone(value))

/** trace 路径 → 目录名：与解释器 runner.mjs 的 safePathKey 一致。 */
const safePathKey = path => String(path || 'root')
  .replace(/^\/+/, '')
  .replace(/[^A-Za-z0-9_-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 120) || 'root'

/** 与 runner.mjs 的 scriptExtension 规则保持一致。 */
function scriptExtension(runtime, code = '') {
  if (runtime === 'python' || runtime === 'python3') return 'py'
  if (runtime === 'node') {
    const text = String(code || '')
    const esm = /(^|\n)\s*(?:import\s+[\w*{'"]|import\s*\(|export\s+(?:default|const|let|var|function|class|async|{))/m.test(text)
    return esm ? 'mjs' : 'cjs'
  }
  if (runtime === 'ts') return 'ts'
  if (runtime === 'powershell' || runtime === 'pwsh') return 'ps1'
  return 'sh'
}

function writeJsonFile(file, value) {
  writeFileSync(file, `${JSON.stringify(value === undefined ? null : value, null, 2)}\n`, 'utf8')
}

const commentText = label => String(label ?? '')
  .replace(/[\r\n]+/g, ' ')
  .trim()
  .slice(0, 80)

/** 汇集所有叶子节点（控制节点不进 manifest.nodes），fold/loop 的路径使用模板占位。 */
function collectNodes(node, path, out) {
  if (!isObject(node)) return
  if (!CONTROL_TYPES.has(node.type)) {
    out.set(path, node)
    return
  }
  if (node.type === 'sequence') {
    for (const step of node.steps || []) collectNodes(step, `${path}/${step.id}`, out)
    return
  }
  if (node.type === 'branch') {
    if (isObject(node.then)) collectNodes(node.then, `${path}/${node.then.id}`, out)
    if (isObject(node.else)) collectNodes(node.else, `${path}/${node.else.id}`, out)
    return
  }
  if (node.type === 'fold') {
    if (isObject(node.body)) collectNodes(node.body, `${path}/item:{index}/${node.body.id}`, out)
    return
  }
  if (node.type === 'loop') {
    if (isObject(node.body)) collectNodes(node.body, `${path}/iter:{index}/${node.body.id}`, out)
    return
  }
  if (node.type === 'or_else') {
    if (isObject(node.primary)) collectNodes(node.primary, `${path}/${node.primary.id}`, out)
    if (isObject(node.fallback)) collectNodes(node.fallback, `${path}/${node.fallback.id}`, out)
    return
  }
  if (node.type === 'fanout') {
    for (const branch of Array.isArray(node.branches) ? node.branches : []) {
      if (isObject(branch)) collectNodes(branch, `${path}/${branch.id}`, out)
    }
  }
}

function nodeManifest(node, path) {
  const base = clone(node)
  delete base.code
  const entry = {
    path,
    node_id: node.id,
    type: node.type,
    label: node.label || node.id,
    hash: `sha256:${hashNode(node)}`,
    inputs: node.inputs === undefined ? null : clone(node.inputs),
    outputs: node.outputs === undefined ? null : clone(node.outputs),
    dir: `nodes/${safePathKey(path)}`,
  }
  const result = { ...base, ...entry }
  if (node.type === 'script') {
    result.script = {
      runtime: node.runtime,
      file: `work/main.${scriptExtension(node.runtime, node.code)}`,
      args: node.args || [],
      timeout_ms: node.timeout_ms === undefined ? null : node.timeout_ms,
      output: node.output || 'json',
      cwd: node.cwd === undefined ? null : node.cwd,
      env: node.env === undefined ? null : clone(node.env),
    }
  }
  return result
}

function controlSummary(node, path) {
  if (!isObject(node)) return null
  if (!CONTROL_TYPES.has(node.type)) {
    return { kind: 'step', path, node_id: node.id, type: node.type }
  }
  if (node.type === 'sequence') {
    return { kind: 'sequence', path, steps: (node.steps || []).map(step => controlSummary(step, `${path}/${step.id}`)) }
  }
  if (node.type === 'branch') {
    return {
      kind: 'branch',
      path,
      then: controlSummary(node.then, `${path}/${node.then && node.then.id}`),
      else: node.else ? controlSummary(node.else, `${path}/${node.else.id}`) : null,
    }
  }
  if (node.type === 'fold') {
    return { kind: 'fold', path, body: controlSummary(node.body, `${path}/item:{index}/${node.body && node.body.id}`) }
  }
  if (node.type === 'loop') {
    return { kind: 'loop', path, body: controlSummary(node.body, `${path}/iter:{index}/${node.body && node.body.id}`) }
  }
  if (node.type === 'fanout') {
    return {
      kind: 'fanout',
      path,
      collect: node.collect || 'keyed',
      branches: (Array.isArray(node.branches) ? node.branches : [])
        .map(branch => controlSummary(branch, `${path}/${branch.id}`)),
    }
  }
  if (node.type === 'merge') {
    return { kind: 'merge', path, mapping: clone(node.mapping) }
  }
  return {
    kind: 'or_else',
    path,
    primary: controlSummary(node.primary, `${path}/${node.primary && node.primary.id}`),
    fallback: controlSummary(node.fallback, `${path}/${node.fallback && node.fallback.id}`),
  }
}

/**
 * 把 IR 编译成可读的 pipeline.mjs：控制流直接生成 JS，叶子节点调用 runtime.step。
 * 路径语义与 runner.mjs 的 executeNode 保持一致。
 */
function generatePipeline(definition) {
  const entry = definition && definition.entry
  if (!isObject(entry)) throw new Error('definition.entry 不能为空')

  const lines = []
  let counter = 0
  const nextVar = () => `v${counter += 1}`
  const push = (indent, text) => { lines.push(`${'  '.repeat(indent)}${text}`) }

  const staticPath = value => ({ literal: value, expr: JSON.stringify(value) })
  const appendPath = (path, id) => (path.literal !== null
    ? staticPath(`${path.literal}/${id}`)
    : { literal: null, expr: `(${path.expr} + ${JSON.stringify(`/${id}`)})` })
  const appendDynamic = (path, prefix, indexVar, id) => ({
    literal: null,
    expr: `(${path.expr} + ${JSON.stringify(`/${prefix}:`)} + ${indexVar} + ${JSON.stringify(`/${id}`)})`,
  })

  function emit(node, path, inputVar, target, indent) {
    const comment = `// ${commentText(node.label || node.id)}`

    if (!CONTROL_TYPES.has(node.type)) {
      push(indent, comment)
      if (target) {
        push(indent, `${target} = await runtime.step(${path.expr}, ${inputVar})`)
        return target
      }
      const variable = nextVar()
      push(indent, `const ${variable} = await runtime.step(${path.expr}, ${inputVar})`)
      return variable
    }

    if (node.type === 'sequence') {
      const variable = target || nextVar()
      push(indent, comment)
      if (!target) push(indent, `let ${variable} = ${inputVar}`)
      for (const step of node.steps || []) {
        const child = emit(step, appendPath(path, step.id), variable, variable, indent)
        if (child !== variable) push(indent, `${variable} = ${child}`)
      }
      return variable
    }

    if (node.type === 'branch') {
      const variable = target || nextVar()
      push(indent, comment)
      if (!target) push(indent, `let ${variable} = ${inputVar}`)
      push(indent, `if (runtime.evalExpr(${JSON.stringify(node.condition)}, ${inputVar})) {`)
      const thenOutput = emit(node.then, appendPath(path, node.then.id), inputVar, variable, indent + 1)
      if (thenOutput !== variable) push(indent + 1, `${variable} = ${thenOutput}`)
      if (node.else) {
        push(indent, '} else {')
        const elseOutput = emit(node.else, appendPath(path, node.else.id), inputVar, variable, indent + 1)
        if (elseOutput !== variable) push(indent + 1, `${variable} = ${elseOutput}`)
      }
      push(indent, '}')
      return variable
    }

    if (node.type === 'fold') {
      const variable = target || nextVar()
      const itemsVar = nextVar()
      const indexVar = nextVar()
      const bodyInputVar = nextVar()
      const initial = node.initial === undefined ? null : node.initial
      push(indent, comment)
      push(indent, `const ${itemsVar} = runtime.items(${JSON.stringify(node.items)}, ${inputVar})`)
      push(indent, `${target ? '' : 'let '}${variable} = ${JSON.stringify(initial)}`)
      push(indent, `for (let ${indexVar} = 0; ${indexVar} < ${itemsVar}.length; ${indexVar} += 1) {`)
      push(indent + 1, `const ${bodyInputVar} = { acc: ${variable}, item: ${itemsVar}[${indexVar}], index: ${indexVar} }`)
      const bodyOutput = emit(node.body, appendDynamic(path, 'item', indexVar, node.body.id), bodyInputVar, null, indent + 1)
      push(indent + 1, `${variable} = ${bodyOutput}`)
      push(indent, '}')
      return variable
    }

    if (node.type === 'loop') {
      const variable = target || nextVar()
      const iterationVar = nextVar()
      push(indent, comment)
      if (!target) push(indent, `let ${variable} = ${inputVar}`)
      push(indent, `let ${iterationVar} = 0`)
      push(indent, `while (runtime.evalExpr(${JSON.stringify(node.while)}, ${variable})) {`)
      if (node.max_iterations !== undefined) {
        push(indent + 1, `if (${iterationVar} >= ${node.max_iterations}) {`)
        push(indent + 2, `throw new Error(${JSON.stringify(`loop 达到 max_iterations=${node.max_iterations}`)})`)
        push(indent + 1, '}')
      }
      const bodyOutput = emit(node.body, appendDynamic(path, 'iter', iterationVar, node.body.id), variable, null, indent + 1)
      push(indent + 1, `${variable} = ${bodyOutput}`)
      push(indent + 1, `${iterationVar} += 1`)
      push(indent, '}')
      return variable
    }

    if (node.type === 'fanout') {
      const variable = target || nextVar()
      const branchInputVar = nextVar()
      const branchNode = {
        id: node.id,
        label: node.label || node.id,
        ...(hasOwn(node, 'input') ? { input: node.input } : {}),
        branches: (node.branches || []).map(branch => branch.id),
        ...(Array.isArray(node.carry) && node.carry.length ? { carry: node.carry } : {}),
        collect: node.collect || 'keyed',
      }
      push(indent, comment)
      push(indent, `const ${branchInputVar} = ${hasOwn(node, 'input') ? `runtime.evalExpr(${JSON.stringify(node.input)}, ${inputVar})` : inputVar}`)
      push(indent, `${target ? '' : 'const '}${variable} = await runtime.fanout(${path.expr}, ${JSON.stringify(branchNode)}, ${branchInputVar})`)
      return variable
    }

    if (node.type === 'merge') {
      const variable = target || nextVar()
      const mergeNode = { id: node.id, label: node.label || node.id, mapping: node.mapping }
      push(indent, comment)
      push(indent, `${target ? '' : 'const '}${variable} = runtime.merge(${path.expr}, ${JSON.stringify(mergeNode)}, ${inputVar})`)
      return variable
    }

    // or_else：主路径抛 StepFailure 时执行兜底路径
    const variable = target || nextVar()
    push(indent, comment)
    if (!target) push(indent, `let ${variable} = ${inputVar}`)
    push(indent, 'try {')
    const primaryOutput = emit(node.primary, appendPath(path, node.primary.id), inputVar, null, indent + 1)
    push(indent + 1, `${variable} = ${primaryOutput}`)
    push(indent, '} catch (error) {')
    push(indent + 1, 'if (!(error instanceof StepFailure)) throw error')
    const fallbackOutput = emit(node.fallback, appendPath(path, node.fallback.id), inputVar, null, indent + 1)
    push(indent + 1, `${variable} = ${fallbackOutput}`)
    push(indent, '}')
    return variable
  }

  lines.push("import { createRuntime, StepFailure } from './runtime.mjs'")
  lines.push('')
  lines.push('const runtime = await createRuntime()')
  lines.push('')
  lines.push('try {')
  lines.push('  const cin = await runtime.start()')

  const output = emit(entry, staticPath(`/${entry.id}`), 'cin', null, 1)

  lines.push(`  await runtime.finish(${output})`)
  lines.push('} catch (error) {')
  lines.push('  if (runtime.isWaitingSignal(error)) {')
  lines.push('    await runtime.waiting(error.ticket)')
  lines.push('  } else {')
  lines.push('    await runtime.fail(error)')
  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

/**
 * 物化一次运行的包：manifest.json + pipeline.mjs + runtime.mjs + 节点 work 脚本。
 * 已存在的 runDir 会复用，但步骤缓存与 checkpoint 会被清理；workspace 不删除。
 */
export async function prepareRunPackage({ dataDir, run, definition, matrix, bridgeUrl } = {}) {
  if (!run || !run.id) throw new Error('prepareRunPackage 需要 run.id')
  if (!isObject(definition) || !isObject(definition.entry)) throw new Error('definition.entry 不能为空')

  const runDir = join(resolve(dataDir), 'runs', run.id)
  mkdirSync(runDir, { recursive: true })
  mkdirSync(join(runDir, 'workspace'), { recursive: true })
  mkdirSync(join(runDir, 'tickets'), { recursive: true })

  // 清理旧断点与旧缓存；保留 workspace / resume.json / llm-session.json
  rmSync(join(runDir, 'state', 'steps'), { recursive: true, force: true })
  mkdirSync(join(runDir, 'state', 'steps'), { recursive: true })
  rmSync(join(runDir, 'state', 'checkpoint.json'), { force: true })

  const entryPath = `/${definition.entry.id}`
  const leaves = new Map()
  collectNodes(definition.entry, entryPath, leaves)

  const nodes = {}
  for (const [path, node] of leaves) {
    nodes[path] = nodeManifest(node, path)
    const nodeDir = join(runDir, 'nodes', safePathKey(path))
    mkdirSync(join(nodeDir, 'work'), { recursive: true })
    if (node.type === 'script') {
      writeFileSync(join(nodeDir, 'work', `main.${scriptExtension(node.runtime, node.code)}`), String(node.code || ''), 'utf8')
    }
  }

  const matrixId = (matrix && matrix.id) || run.matrix_id || null
  const rootMatrixId = (matrix && matrix.root_id) || run.root_matrix_id || matrixId
  const manifest = {
    version: 1,
    engine: 'node',
    matrix_id: matrixId,
    root_matrix_id: rootMatrixId,
    // persist 节点运行上下文：项目级数据目录与项目 id
    data_dir: resolve(dataDir),
    project_id: (matrix && matrix.project_id) || null,
    run_id: run.id,
    name: run.name || definition.name || (matrix && matrix.name) || run.id,
    created_at: new Date().toISOString(),
    definition_hash: `sha256:${hashNode(definition)}`,
    io_mode: run.io_mode || (matrix && matrix.execution_mode) || 'files',
    workspace: 'workspace',
    entry: clone(definition.entry),
    bridge: {
      base_url: String(bridgeUrl || process.env.RMS_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(/\/+$/, ''),
      token_file: 'state/bridge-token',
      run_id: run.id,
    },
    nodes,
    control: controlSummary(definition.entry, entryPath),
  }

  writeJsonFile(join(runDir, 'manifest.json'), manifest)
  writeJsonFile(join(runDir, 'input.json'), run.input === undefined ? null : run.input)
  writeFileSync(join(runDir, 'pipeline.mjs'), generatePipeline(definition), 'utf8')

  const runtimeSource = join(engineDir, 'runtime.mjs')
  if (!existsSync(runtimeSource)) throw new Error(`缺少运行时源文件：${runtimeSource}`)
  copyFileSync(runtimeSource, join(runDir, 'runtime.mjs'))

  writeFileSync(join(runDir, 'state', 'bridge-token'), `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 })

  return {
    dir: runDir,
    manifest_path: join(runDir, 'manifest.json'),
    pipeline_path: join(runDir, 'pipeline.mjs'),
  }
}
