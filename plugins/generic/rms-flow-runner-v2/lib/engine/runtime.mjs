import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => (value === undefined ? null : structuredClone(value))
const now = () => new Date().toISOString()

const OUTPUT_LIMIT = 10 * 1024 * 1024

const sleep = ms => new Promise(settle => setTimeout(settle, ms))
const persistLockWait = () => Math.max(100, Number(process.env.RMS_PERSIST_LOCK_WAIT_MS) || 5000)

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

const fanoutConcurrency = () => Math.max(1, Number(process.env.RMS_FLOW_FANOUT_CONCURRENCY) || 4)

/** 受并发上限约束地执行任务；任一失败时等其它任务结束后抛出第一个错误。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  const errors = new Array(items.length).fill(null)
  let cursor = 0
  async function worker() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        errors[index] = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()))
  const failed = errors.findIndex(Boolean)
  if (failed >= 0) throw errors[failed]
  return results
}

const safePathKey = path => String(path || 'root')
  .replace(/^\/+/, '')
  .replace(/[^A-Za-z0-9_-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 120) || 'root'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value === undefined ? null : value))).digest('hex')
}

function parseJson(text) {
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
  throw new Error(`未返回合法 JSON：${source.slice(0, 120) || '空内容'}`)
}

function readPath(data, path) {
  const normalized = String(path ?? '').replace(/^\$\.?/, '')
  if (!normalized) return data
  let current = data
  for (const key of normalized.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return null
    if (current === null || current === undefined || !hasOwn(Object(current), key)) return null
    current = current[key]
  }
  return current === undefined ? null : current
}

function numbers(values) {
  const result = values.map(value => Number(value))
  if (result.some(value => !Number.isFinite(value))) throw new Error('表达式包含非有限数值')
  return result
}

/** 与 runner.mjs 的 evaluateExpression 语义完全一致。 */
function evaluateExpression(expression, data) {
  if (expression === null || typeof expression !== 'object') return expression
  if (Array.isArray(expression)) return expression.map(item => evaluateExpression(item, data))
  if (hasOwn(expression, 'var')) return clone(readPath(data, expression.var))
  if (hasOwn(expression, 'literal')) return clone(expression.literal)

  if (hasOwn(expression, 'if')) {
    const parts = expression.if
    if (!Array.isArray(parts) || parts.length < 2) throw new Error('if 表达式需要 [condition, then, else?]')
    return evaluateExpression(parts[0], data)
      ? evaluateExpression(parts[1], data)
      : (parts.length > 2 ? evaluateExpression(parts[2], data) : null)
  }
  if (hasOwn(expression, 'and')) {
    let result = true
    for (const item of expression.and) {
      result = evaluateExpression(item, data)
      if (!result) return result
    }
    return result
  }
  if (hasOwn(expression, 'or')) {
    let result = false
    for (const item of expression.or) {
      result = evaluateExpression(item, data)
      if (result) return result
    }
    return result
  }
  if (hasOwn(expression, 'coalesce')) {
    for (const item of expression.coalesce) {
      const value = evaluateExpression(item, data)
      if (value !== null && value !== undefined) return value
    }
    return null
  }

  const binary = (name, fn) => {
    if (!hasOwn(expression, name)) return undefined
    const args = expression[name]
    if (!Array.isArray(args) || args.length !== 2) throw new Error(`${name} 表达式需要两个参数`)
    return fn(evaluateExpression(args[0], data), evaluateExpression(args[1], data))
  }
  let result
  if ((result = binary('===', (a, b) => a === b)) !== undefined) return result
  if ((result = binary('!==', (a, b) => a !== b)) !== undefined) return result
  if ((result = binary('>', (a, b) => a > b)) !== undefined) return result
  if ((result = binary('>=', (a, b) => a >= b)) !== undefined) return result
  if ((result = binary('<', (a, b) => a < b)) !== undefined) return result
  if ((result = binary('<=', (a, b) => a <= b)) !== undefined) return result
  if ((result = binary('in', (a, b) => Array.isArray(b) || typeof b === 'string' ? b.includes(a) : false)) !== undefined) return result

  for (const op of ['+', '-', '*', '/', '%']) {
    if (!hasOwn(expression, op)) continue
    const args = numbers(expression[op].map(item => evaluateExpression(item, data)))
    let value
    if (op === '+') value = args.reduce((a, b) => a + b, 0)
    if (op === '-') value = args.length === 1 ? -args[0] : args.slice(1).reduce((a, b) => a - b, args[0])
    if (op === '*') value = args.reduce((a, b) => a * b, 1)
    if (op === '/') value = args.slice(1).reduce((a, b) => a / b, args[0])
    if (op === '%') value = args[0] % args[1]
    if (!Number.isFinite(value)) throw new Error(`表达式 ${op} 产生非有限数值`)
    return value
  }
  if (hasOwn(expression, '!')) return !evaluateExpression(expression['!'], data)
  if (hasOwn(expression, 'cat')) return expression.cat.map(item => String(evaluateExpression(item, data) ?? '')).join('')
  if (hasOwn(expression, 'range')) {
    const args = expression.range
    if (!Array.isArray(args) || args.length !== 2) throw new Error('range 表达式需要 [start, end]')
    const [start, end] = numbers(args.map(item => evaluateExpression(item, data)))
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error('range 参数必须是整数')
    const length = Math.abs(end - start) + 1
    if (length > 200000) throw new Error('range 结果超过 200000 项')
    const step = start <= end ? 1 : -1
    return Array.from({ length }, (_, index) => start + index * step)
  }
  if (hasOwn(expression, 'join')) {
    const args = expression.join
    if (!Array.isArray(args) || args.length < 1 || args.length > 2) throw new Error('join 表达式需要 [数组, 分隔符?]')
    const value = evaluateExpression(args[0], data)
    if (!Array.isArray(value)) throw new Error('join 第一个参数必须是数组')
    const separator = args.length > 1 ? String(evaluateExpression(args[1], data) ?? '') : ''
    return value.map(item => String(item ?? '')).join(separator)
  }
  if (hasOwn(expression, 'split')) {
    const args = expression.split
    if (!Array.isArray(args) || args.length !== 2) throw new Error('split 表达式需要 [字符串, 分隔符]')
    const value = evaluateExpression(args[0], data)
    if (typeof value !== 'string') throw new Error('split 第一个参数必须是字符串')
    return value.split(String(evaluateExpression(args[1], data) ?? ''))
  }
  if (hasOwn(expression, 'length')) {
    const value = evaluateExpression(expression.length, data)
    if (typeof value === 'string' || Array.isArray(value)) return value.length
    if (isObject(value)) return Object.keys(value).length
    return 0
  }

  return Object.fromEntries(Object.entries(expression).map(([key, value]) => [key, evaluateExpression(value, data)]))
}

const nodeStripsTypes = () => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
}

function runtimeCommand(runtime, file) {
  if (runtime === 'bash') return { command: 'bash', args: [file] }
  if (runtime === 'sh') return { command: 'sh', args: [file] }
  if (runtime === 'powershell') return { command: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] }
  if (runtime === 'pwsh') return { command: 'pwsh', args: ['-NoProfile', '-File', file] }
  if (runtime === 'node') return { command: process.execPath, args: [file] }
  if (runtime === 'ts') {
    if (!nodeStripsTypes()) throw new Error(`ts 运行需要 Node 22.18+/23.6+（当前 ${process.versions.node}）`)
    return { command: process.execPath, args: [file] }
  }
  if (runtime === 'python') return { command: 'python', args: [file] }
  if (runtime === 'python3') return { command: 'python3', args: [file] }
  throw new Error(`不支持的脚本运行时：${runtime}`)
}

function runProcess({ command, args, cwd, env, timeoutMs, stdin }) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const failure = new Error(`${command} 启动失败：${error.message}`)
      failure.stdout = stdout
      failure.stderr = stderr
      reject(failure)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timedOut) {
        const failure = new Error(`${command} 超过 ${timeoutMs}ms 未结束`)
        failure.stdout = stdout
        failure.stderr = stderr
        failure.code = 'STEP_TIMEOUT'
        reject(failure)
      } else if (code !== 0) {
        const failure = new Error(`${command} 退出码 ${code}：${(stderr || stdout).trim().slice(0, 800) || '无输出'}`)
        failure.stdout = stdout
        failure.stderr = stderr
        failure.exit_code = code
        reject(failure)
      } else {
        resolveProcess({ stdout, stderr, code })
      }
    })
    if (child.stdin) child.stdin.end(stdin === undefined ? '' : stdin)
  })
}

export class StepFailure extends Error {
  constructor(message, info = {}) {
    super(String(message || '节点失败'))
    this.name = 'StepFailure'
    this.node_id = info.node_id ?? null
    this.path = info.path ?? null
    this.error = info.error || { message: String(message || '节点失败') }
  }
}

export class WaitingSignal extends Error {
  constructor(ticket) {
    super(String(ticket && ticket.prompt ? ticket.prompt : '等待人工输入'))
    this.name = 'WaitingSignal'
    this.ticket = ticket || null
  }
}

class Runtime {
  constructor(runDir, manifest, runId) {
    this.runDir = runDir
    this.manifest = manifest
    this.runId = runId
    this.nodes = manifest.nodes || {}
    this.workspaceDir = join(runDir, manifest.workspace || 'workspace')
    this.bridgeBaseUrl = String(process.env.RMS_BRIDGE_URL || (manifest.bridge && manifest.bridge.base_url) || 'http://127.0.0.1:3080/flow-runner-v2').replace(/\/+$/, '')
    try { mkdirSync(this.workspaceDir, { recursive: true }) } catch {}
  }

  isWaitingSignal(error) {
    return Boolean(error && error.name === 'WaitingSignal')
  }

  hash(value) {
    return hashValue(value)
  }

  evalExpr(expression, scope) {
    return evaluateExpression(expression, scope)
  }

  items(expression, scope) {
    const value = this.evalExpr(expression, scope)
    if (!Array.isArray(value)) throw new Error('fold.items 必须求值为数组')
    return value
  }

  log(fields) {
    try {
      const line = JSON.stringify({ at: now(), run_id: this.runId, ...fields })
      appendFileSync(join(this.runDir, 'run.log'), `${line}\n`, 'utf8')
    } catch {}
  }

  writeJson(file, value) {
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, `${JSON.stringify(value === undefined ? null : value, null, 2)}\n`, 'utf8')
    } catch {}
  }

  remove(file) {
    try { rmSync(file, { force: true }) } catch {}
  }

  readJson(file) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  artifactDir(path) {
    return join(this.runDir, 'nodes', safePathKey(path))
  }

  cacheFile(path) {
    return join(this.runDir, 'state', 'steps', `${safePathKey(path)}.json`)
  }

  lookupNode(path) {
    const key = String(path)
    if (hasOwn(this.nodes, key)) return this.nodes[key]
    const normalized = key
      .replace(/\/item:\d+/g, '/item:{index}')
      .replace(/\/iter:\d+/g, '/iter:{index}')
    if (hasOwn(this.nodes, normalized)) return this.nodes[normalized]
    return null
  }

  /** 取消标记由执行器写入；pipeline 在每个节点前检查并自行退出。 */
  isCancelled() {
    return existsSync(join(this.runDir, 'state', 'cancel.json'))
  }

  async start() {
    const file = join(this.runDir, 'input.json')
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8')
    if (!text.trim()) return null
    return JSON.parse(text)
  }

  async step(path, input) {
    const tracePath = String(path)
    if (this.isCancelled()) {
      this.log({ phase: 'cancel', path: tracePath, status: 'cancelled' })
      process.exit(130)
    }
    const node = this.lookupNode(tracePath)
    if (!node) {
      throw new StepFailure(`manifest 中找不到节点：${tracePath}`, {
        path: tracePath,
        error: { message: `manifest 中找不到节点：${tracePath}`, path: tracePath },
      })
    }
    const nodeId = node.node_id || node.id || null
    const nodeHash = node.hash || `sha256:${this.hash(node)}`
    const inputHash = `sha256:${this.hash(input === undefined ? null : input)}`
    const startedAt = Date.now()
    const startedIso = now()

    // persist 有外部副作用，禁止按输入缓存复用
    const cacheable = node.type !== 'persist'
    const cached = cacheable ? this.readJson(this.cacheFile(tracePath)) : null
    if (cacheable && cached && cached.status === 'completed' && cached.node_hash === nodeHash && cached.input_hash === inputHash) {
      this.writeArtifacts(tracePath, node, {
        status: 'completed',
        input,
        output: cached.output,
        details: cached.details || {},
        reused: true,
        started_at: cached.started_at || startedIso,
        finished_at: now(),
      })
      this.log({ phase: 'step_end', path: tracePath, node_id: nodeId, type: node.type, status: 'reused', duration_ms: 0 })
      return clone(cached.output)
    }

    this.log({ phase: 'step_start', path: tracePath, node_id: nodeId, type: node.type, status: 'running' })
    this.writeArtifacts(tracePath, node, { status: 'running', input, started_at: startedIso })

    try {
      const result = await this.executeNode(tracePath, node, input)
      const duration = Date.now() - startedAt
      this.writeArtifacts(tracePath, node, {
        status: 'completed',
        input,
        output: result.output,
        details: result.details,
        started_at: startedIso,
        finished_at: now(),
        duration_ms: duration,
        stdout: result.stdout,
        stderr: result.stderr,
      })
      if (cacheable) {
        this.writeJson(this.cacheFile(tracePath), {
          version: 1,
          path: tracePath,
          node_id: nodeId,
          node_hash: nodeHash,
          input_hash: inputHash,
          status: 'completed',
          output: clone(result.output),
          details: result.details === undefined ? null : clone(result.details),
          artifact_dir: `nodes/${safePathKey(tracePath)}`,
          started_at: startedIso,
          finished_at: now(),
        })
      }
      if (result.details && result.details.resumed) {
        this.log({ phase: 'resume', path: tracePath, node_id: nodeId, status: 'completed' })
      }
      this.log({ phase: 'step_end', path: tracePath, node_id: nodeId, type: node.type, status: 'completed', duration_ms: duration })
      return clone(result.output)
    } catch (error) {
      if (this.isWaitingSignal(error)) {
        this.writeArtifacts(tracePath, node, {
          status: 'waiting_human',
          input,
          started_at: startedIso,
          prompt: error.ticket && error.ticket.prompt ? error.ticket.prompt : null,
        })
        this.log({ phase: 'waiting', path: tracePath, node_id: nodeId, type: node.type, status: 'waiting' })
        throw error
      }
      const failure = this.toFailure(error, node, tracePath)
      this.writeArtifacts(tracePath, node, {
        status: 'failed',
        input,
        error: failure,
        started_at: startedIso,
        finished_at: now(),
        duration_ms: Date.now() - startedAt,
        stdout: error && typeof error.stdout === 'string' ? error.stdout : undefined,
        stderr: error && typeof error.stderr === 'string' ? error.stderr : undefined,
      })
      this.log({
        phase: 'step_end',
        path: tracePath,
        node_id: nodeId,
        type: node.type,
        status: 'failed',
        duration_ms: Date.now() - startedAt,
        error: failure.message,
      })
      throw new StepFailure(failure.message || '节点失败', { node_id: nodeId, path: tracePath, error: failure })
    }
  }

  toFailure(error, node, path) {
    const nodeId = node.node_id || node.id || null
    if (error && error.name === 'StepFailure' && isObject(error.error)) {
      return {
        node_id: error.error.node_id ?? nodeId,
        label: error.error.label || node.label || nodeId,
        path: error.error.path || path,
        message: error.error.message || error.message || '节点失败',
      }
    }
    return {
      node_id: nodeId,
      label: node.label || nodeId,
      path,
      message: error && error.message ? String(error.message) : String(error || '节点失败'),
    }
  }

  writeArtifacts(path, node, info) {
    const dir = this.artifactDir(path)
    try { mkdirSync(join(dir, 'work'), { recursive: true }) } catch {}
    this.writeJson(join(dir, 'input.json'), info.input === undefined ? null : info.input)

    const meta = {
      node_id: node.node_id || node.id || null,
      label: node.label || node.node_id || node.id || null,
      type: node.type || null,
      path,
      status: info.status,
      started_at: info.started_at || null,
      finished_at: info.finished_at || null,
      duration_ms: info.duration_ms === undefined ? null : info.duration_ms,
    }
    if (info.reused) meta.reused = true
    if (info.prompt) meta.prompt = info.prompt
    if (isObject(info.details) && Object.keys(info.details).length) meta.details = info.details

    if (typeof info.stdout === 'string') {
      try { writeFileSync(join(dir, 'stdout.log'), info.stdout, 'utf8') } catch {}
    }
    if (typeof info.stderr === 'string') {
      try { writeFileSync(join(dir, 'stderr.log'), info.stderr, 'utf8') } catch {}
    }
    if (info.status === 'completed') {
      this.writeJson(join(dir, 'output.json'), info.output)
      this.remove(join(dir, 'error.json'))
    } else if (info.status === 'failed') {
      this.writeJson(join(dir, 'error.json'), info.error)
      this.remove(join(dir, 'output.json'))
    }
    this.writeJson(join(dir, 'meta.json'), meta)
  }

  /**
   * 一对多分发：所有分支收到同一份输入，独立执行并落盘；
   * collect=keyed 汇总为 {branchId: output}，array 按声明顺序汇总为数组。
   */
  async fanout(path, node, input) {
    const branchInput = hasOwn(node, 'input') ? this.evalExpr(node.input, input) : input
    const branches = Array.isArray(node.branches) ? node.branches : []
    this.log({ phase: 'fanout_start', path, node_id: node.id, branches, status: 'running' })
    const results = await mapLimit(branches, fanoutConcurrency(), branchId => this.step(`${path}/${branchId}`, branchInput))
    let output = results
    if (node.collect !== 'array') {
      output = Object.fromEntries(branches.map((branchId, index) => [branchId, results[index]]))
      // carry：把上游输入字段原样并入汇总输出，避免再生成只做透传的分支
      for (const key of Array.isArray(node.carry) ? node.carry : []) {
        if (isObject(branchInput) && hasOwn(branchInput, key)) output[key] = clone(branchInput[key])
      }
    }
    // 控制节点只传值：不写 nodes 产物，避免进入 run.trace
    this.log({ phase: 'fanout_end', path, node_id: node.id, branches, carry: node.carry || [], status: 'completed' })
    return output
  }

  /** 汇合：mapping 表达式在 fanout 汇总输出（即 merge 的 Cin）上求值。 */
  merge(path, node, input) {
    const output = this.evalExpr(node.mapping, input)
    this.log({ phase: 'merge', path, node_id: node.id, mapping: node.mapping, status: 'completed' })
    return output
  }

  async executeNode(path, node, input) {
    const type = node.type
    if (type === 'det') return this.executeDet(node, input)
    if (type === 'script') return this.executeScript(path, node, input)
    if (type === 'http') return this.executeHttp(node, input)
    if (type === 'llm') return this.executeLlm(path, node, input)
    if (type === 'agent') return this.executeAgent(path, node, input)
    if (type === 'tool') return this.executeTool(path, node, input)
    if (type === 'human') return this.executeHuman(path, node, input)
    if (type === 'persist') return this.executePersist(node, input)
    if (type === 'subflow') return this.executeSubflow(path, node, input)
    // stub 节点复用 subflow 运行时，调用 stub 根 matrix
    if (type === 'stub') return this.executeSubflow(path, node, input)
    throw new Error(`未知节点类型：${type}`)
  }

  executeDet(node, input) {
    if (node.op === 'literal') return { output: clone(node.value), details: { op: 'literal' } }
    if (node.op === 'expr') return { output: clone(this.evalExpr(node.expr, input)), details: { op: 'expr' } }
    if (!this.evalExpr(node.condition, input)) throw new Error(node.message || 'Det assert 条件不满足')
    return { output: clone(input), details: { op: 'assert' } }
  }

  async executeScript(path, node, input) {
    const script = node.script || {}
    const runtimeName = script.runtime || node.runtime
    if (!runtimeName) throw new Error('script 节点缺少 runtime')

    const staticDir = node.dir ? join(this.runDir, node.dir) : this.artifactDir(path)
    const scriptFile = script.file
      ? (isAbsolute(script.file) ? script.file : join(staticDir, script.file))
      : join(staticDir, 'work', 'main.cjs')

    const dir = this.artifactDir(path)
    try { mkdirSync(dir, { recursive: true }) } catch {}
    const inputFile = join(dir, 'input.json')
    const outputFile = join(dir, 'output.json')
    this.writeJson(inputFile, input === undefined ? null : input)
    this.remove(outputFile)

    const cwd = script.cwd
      ? (isAbsolute(script.cwd) ? script.cwd : resolve(this.workspaceDir, script.cwd))
      : this.workspaceDir
    const env = {
      ...((script.env && isObject(script.env)) ? script.env : {}),
      RMS_NODE_ID: String(node.node_id || node.id || ''),
      RMS_RUN_ID: String(this.runId),
      RMS_NODE_DIR: dir,
      RMS_ARTIFACT_DIR: dir,
      RMS_RUN_DIR: this.workspaceDir,
      RMS_INPUT_FILE: inputFile,
      RMS_OUTPUT_FILE: outputFile,
    }
    const { command, args } = runtimeCommand(runtimeName, scriptFile)
    const started = Date.now()
    const result = await runProcess({
      command,
      args: [...args, ...(script.args || [])],
      cwd,
      env,
      timeoutMs: script.timeout_ms || Number(process.env.RMS_FLOW_EXEC_TIMEOUT_MS || 120000),
      stdin: JSON.stringify(input === undefined ? null : input),
    })

    let output
    if (existsSync(outputFile)) {
      const text = readFileSync(outputFile, 'utf8').trim()
      if (!text) throw new Error(`${runtimeName} 脚本写入的 output.json 是空的`)
      output = script.output === 'text' ? text : parseJson(text)
    } else {
      const text = result.stdout.trim()
      if (!text) throw new Error(`${runtimeName} 脚本没有输出内容（请写 output.json 或打印到 stdout）`)
      output = script.output === 'text' ? result.stdout : parseJson(text)
    }

    return {
      output,
      details: {
        runtime: runtimeName,
        cwd,
        exit_code: result.code,
        duration_ms: Date.now() - started,
        artifact_dir: `nodes/${safePathKey(path)}`,
      },
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  async executeHttp(node, input) {
    const url = String(typeof node.url === 'string' ? node.url : this.evalExpr(node.url, input) ?? '')
    if (!/^https?:\/\//i.test(url)) throw new Error('http.url 必须是 http/https 地址')
    const method = String(node.method || 'GET').toUpperCase()
    const rawHeaders = node.headers ? this.evalExpr(node.headers, input) : {}
    const headers = {}
    for (const [key, value] of Object.entries(rawHeaders || {})) headers[key] = String(value ?? '')
    const body = hasOwn(node, 'body') ? this.evalExpr(node.body, input) : undefined
    const init = { method, headers }
    if (body !== undefined && !['GET', 'HEAD'].includes(method)) {
      if (typeof body === 'string') init.body = body
      else {
        init.body = JSON.stringify(body)
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
      }
    }
    const timeoutMs = node.timeout_ms || Number(process.env.RMS_FLOW_HTTP_TIMEOUT_MS || 30000)
    let response
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new Error(`http ${method} ${url} 请求失败：${error && error.message ? error.message : error}`)
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`http ${method} ${url} 返回 ${response.status}：${text.slice(0, 400)}`)
    const contentType = response.headers.get('content-type') || ''
    const details = { status: response.status, content_type: contentType, bytes: text.length }
    if (node.output === 'text') return { output: text, details }
    if (!/json/i.test(contentType)) throw new Error(`http 响应不是 JSON（${contentType || 'unknown'}）：${text.slice(0, 200)}`)
    return { output: parseJson(text), details }
  }

  readResume() {
    const file = join(this.runDir, 'state', 'resume.json')
    const value = this.readJson(file)
    return isObject(value) ? value : {}
  }

  writeTicket(ticket) {
    this.writeJson(join(this.runDir, 'tickets', `${ticket.id}.json`), ticket)
  }

  executeHuman(path, node, input) {
    const resume = this.readResume()
    const entry = resume[path]
    if (entry && (hasOwn(entry, 'answer') || hasOwn(entry, 'value'))) {
      const answer = hasOwn(entry, 'answer') ? entry.answer : entry.value
      return {
        output: clone(answer),
        details: { resumed: true, ticket_id: entry.ticket_id || null },
      }
    }
    const ticket = {
      version: 1,
      id: `tk_${randomBytes(6).toString('hex')}`,
      run_id: this.runId,
      matrix_id: this.manifest.matrix_id || null,
      root_matrix_id: this.manifest.root_matrix_id || this.manifest.matrix_id || null,
      node_id: node.node_id || node.id || null,
      path,
      kind: 'human',
      prompt: node.prompt || '请确认是否继续',
      input: clone(input),
      status: 'open',
      answer: null,
      created_at: now(),
      answered_at: null,
      answered_by: null,
      resume_attempt: 0,
    }
    this.writeTicket(ticket)
    throw new WaitingSignal(ticket)
  }

  executeTool(path, node, input) {
    const args = hasOwn(node, 'args') ? this.evalExpr(node.args, input) : input
    return this.postBridge('tool', {
      node_id: node.node_id || node.id || null,
      path,
      tool: node.tool,
      args: clone(args),
      input: clone(input),
    }).then(response => {
      const value = isObject(response) && hasOwn(response, 'value') ? response.value : response
      const output = node.output === 'text' ? String(value ?? '') : (typeof value === 'string' ? parseJson(value) : value)
      return { output: clone(output), details: { tool: node.tool, bridge: 'tool' } }
    })
  }

  async executeLlm(path, node, input) {
    const response = await this.postBridge('llm', {
      node_id: node.node_id || node.id || null,
      path,
      system: node.system ?? null,
      prompt: node.prompt,
      input: clone(input),
      mode: node.mode || 'gen',
      output: node.output || null,
      options: node.options ?? null,
      options_expr: node.options_expr ?? null,
    })
    const details = {
      bridge: 'llm',
      mode: node.mode || 'gen',
      session_id: response && response.session_id ? response.session_id : null,
      usage: response && response.usage ? response.usage : null,
    }
    if (response && hasOwn(response, 'value')) return { output: clone(response.value), details }
    const text = String(response && response.text !== undefined ? response.text : '')
    if (!text) throw new Error('bridge llm 没有返回内容')
    return { output: node.output === 'text' ? text : parseJson(text), details }
  }

  async executeAgent(path, node, input) {
    const response = await this.postBridge('agent', {
      node_id: node.node_id || node.id || null,
      path,
      system: node.system ?? null,
      prompt: node.prompt,
      input: clone(input),
      output: node.output || null,
      workspace: this.workspaceDir,
    })
    const details = {
      bridge: 'agent',
      session_id: response && response.session_id ? response.session_id : null,
      messages: response && response.messages ? response.messages : null,
    }
    if (response && hasOwn(response, 'value')) return { output: clone(response.value), details }
    const text = String(response && response.text !== undefined ? response.text : '')
    if (!text) throw new Error('bridge agent 没有返回内容')
    return { output: node.output === 'text' ? text : parseJson(text), details }
  }

  /** 项目级 persistence store：<dataDir>/projects/<projectId>/data/<modelId>.json */
  persistRoot(node) {
    const dataDir = this.manifest.data_dir
    const projectId = node.project_id || this.manifest.project_id
    if (!dataDir || !projectId) {
      throw new Error('persist 节点需要项目级 data_dir 与 project_id（运行包缺少上下文）')
    }
    return join(dataDir, 'projects', String(projectId), 'data')
  }

  writeAtomic(file, value) {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  }

  /** 按 model 文件加锁；原子写避免并发运行互相覆盖。 */
  async withPersistLock(file, operation) {
    mkdirSync(dirname(file), { recursive: true })
    const lock = `${file}.lock`
    const deadline = Date.now() + persistLockWait()
    while (true) {
      try {
        const fd = openSync(lock, 'wx')
        writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: now() }), 'utf8')
        closeSync(fd)
        break
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
        let stale = false
        try {
          stale = !processAlive(Number(JSON.parse(readFileSync(lock, 'utf8')).pid))
        } catch {}
        if (stale) {
          try { unlinkSync(lock) } catch {}
          continue
        }
        if (Date.now() >= deadline) throw new Error(`持久化文件被占用，请稍后重试：${file}`)
        await sleep(25)
      }
    }
    try {
      return await operation()
    } finally {
      try { if (existsSync(lock)) unlinkSync(lock) } catch {}
    }
  }

  async executePersist(node, input) {
    const modelId = String(node.model_id || '')
    if (!/^mdl_[A-Za-z0-9_-]{4,40}$/.test(modelId)) throw new Error(`persist 节点 model_id 不合法：${modelId}`)
    const operation = String(node.operation || '')
    const key = node.key ? String(node.key) : null
    const projectId = node.project_id || this.manifest.project_id
    const relative = `projects/${String(projectId)}/data/${modelId}.json`
    const result = await this.withPersistLock(join(this.persistRoot(node), `${modelId}.json`), async () => {
      const file = join(this.persistRoot(node), `${modelId}.json`)
      const stored = this.readJson(file)
      const records = stored && Array.isArray(stored.records) ? stored.records : []
      const keyValue = key && isObject(input) ? input[key] : undefined
      const requireKey = () => {
        if (!key) throw new Error(`persist ${node.node_id || node.id || ''} 未声明 key，无法执行 ${operation}`)
        if (keyValue === undefined || keyValue === null || keyValue === '') {
          throw new Error(`persist ${operation} 需要输入字段 ${key}`)
        }
        return keyValue
      }
      const indexOf = value => records.findIndex(record => isObject(record) && record[key] === value)
      let output
      if (operation === 'create') {
        if (!isObject(input)) throw new Error('persist create 的输入必须是对象')
        if (key) {
          requireKey()
          if (indexOf(keyValue) >= 0) throw new Error(`记录已存在：${key}=${String(keyValue)}`)
        }
        const record = clone(input)
        records.push(record)
        output = clone(record)
      } else if (operation === 'update') {
        if (!isObject(input)) throw new Error('persist update 的输入必须是对象')
        const value = requireKey()
        const index = indexOf(value)
        if (index < 0) throw new Error(`记录不存在：${key}=${String(value)}`)
        records[index] = { ...records[index], ...clone(input) }
        output = clone(records[index])
      } else if (operation === 'get') {
        const value = requireKey()
        const index = indexOf(value)
        output = index >= 0 ? clone(records[index]) : null
      } else if (operation === 'delete') {
        const value = requireKey()
        const index = indexOf(value)
        if (index >= 0) records.splice(index, 1)
        output = { [key]: value, deleted: index >= 0 }
      } else if (operation === 'list') {
        const where = {
          ...(isObject(node.where) ? node.where : {}),
          ...(isObject(input) && isObject(input.where) ? input.where : {}),
        }
        const items = records.filter(record => isObject(record)
          && Object.entries(where).every(([field, expected]) => record[field] === expected))
        output = { items: clone(items), total: items.length }
      } else {
        throw new Error(`不支持的 persist operation：${operation}`)
      }
      this.writeAtomic(file, {
        version: 1,
        model_id: modelId,
        project_id: projectId || null,
        updated_at: now(),
        records,
      })
      return { output, details: { model_id: modelId, operation, file: relative, count: records.length } }
    })
    this.log({ phase: 'persist', node_id: node.node_id || node.id || null, model_id: modelId, operation, status: 'completed' })
    return result
  }

  async executeSubflow(path, node, input) {
    // 父运行等待子 matrix 期间会以同一路径恢复；恢复点直接给出子运行结果，
    // 不再调用 bridge，避免重复启动子运行。
    const resumed = this.readResume()[path]
    if (resumed && hasOwn(resumed, 'error')) {
      const failure = isObject(resumed.error) ? resumed.error : {}
      throw new Error(failure.message || '子流程失败')
    }
    if (resumed && (hasOwn(resumed, 'answer') || hasOwn(resumed, 'value'))) {
      return {
        output: clone(hasOwn(resumed, 'answer') ? resumed.answer : resumed.value),
        details: {
          resumed: true, bridge: 'subflow',
          subflow_run_id: resumed.subflow_run_id || null,
          ticket_id: resumed.ticket_id || null,
        },
      }
    }
    const childInput = hasOwn(node, 'input') ? this.evalExpr(node.input, input) : input
    const response = await this.postBridge('subflow', {
      node_id: node.node_id || node.id || null,
      node_type: node.type || null,
      stub_id: node.stub_id ?? null,
      path,
      matrix_id: node.matrix_id ?? null,
      ref: node.ref ?? null,
      definition: node.definition ?? null,
      workspace: node.workspace ?? null,
      fuel: node.fuel ?? null,
      recursion: node.recursion ?? null,
      input: clone(childInput),
      parent_run_id: this.runId,
    })
    if (response && response.status === 'completed') {
      return {
        output: clone(response.output),
        details: { subflow_run_id: response.run_id || null, bridge: 'subflow' },
      }
    }
    if (response && (response.status === 'waiting_human' || response.status === 'waiting')) {
      throw new WaitingSignal({
        version: 1,
        id: response.ticket_id || `tk_${randomBytes(6).toString('hex')}`,
        run_id: this.runId,
        matrix_id: this.manifest.matrix_id || null,
        root_matrix_id: this.manifest.root_matrix_id || this.manifest.matrix_id || null,
        node_id: node.node_id || node.id || null,
        path,
        kind: 'subflow',
        prompt: (response.pending && response.pending.prompt) || '子流程等待人工输入',
        input: clone(childInput),
        status: 'open',
        answer: null,
        created_at: now(),
        subflow_run_id: response.run_id || null,
        subflow_path: (response.pending && response.pending.path) || null,
      })
    }
    throw new Error(`子流程 ${response && response.run_id || ''} 失败：${(response && response.error && response.error.message) || '未知错误'}`)
  }

  readToken() {
    const relative = (this.manifest.bridge && this.manifest.bridge.token_file) || 'state/bridge-token'
    const file = isAbsolute(relative) ? relative : join(this.runDir, relative)
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }

  async postBridge(kind, payload) {
    const token = this.readToken()
    if (!token) throw new Error('BRIDGE_UNAUTHORIZED：缺少 bridge token')
    const url = `${this.bridgeBaseUrl}/api/runs/${encodeURIComponent(this.runId)}/bridge/${kind}`
    const started = Date.now()
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rms-run-token': token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Number(process.env.RMS_FLOW_BRIDGE_TIMEOUT_MS || 120000)),
      })
    } catch (error) {
      this.log({ phase: 'bridge', kind, status: 'failed', duration_ms: Date.now() - started })
      throw new Error(`BRIDGE_UNAVAILABLE：${kind} 调用失败：${error && error.message ? error.message : error}`)
    }
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch {}
    this.log({ phase: 'bridge', kind, status: response.ok ? 'completed' : 'failed', http_status: response.status, duration_ms: Date.now() - started })
    if (!response.ok) {
      const unauthorized = response.status === 401 || response.status === 403
      throw new Error(`${unauthorized ? 'BRIDGE_UNAUTHORIZED' : 'BRIDGE_UNAVAILABLE'}：bridge ${kind} 返回 ${response.status}：${String(text).slice(0, 300)}`)
    }
    if (data === null && text.trim()) throw new Error(`bridge ${kind} 返回非 JSON：${text.slice(0, 200)}`)
    return data
  }

  async finish(output) {
    this.writeJson(join(this.runDir, 'output.json'), output === undefined ? null : output)
    this.log({ phase: 'finish', status: 'completed' })
    process.exit(0)
  }

  async waiting(ticket) {
    const value = ticket || {}
    if (this.isCancelled()) {
      this.log({ phase: 'cancel', path: value.path ?? null, status: 'cancelled' })
      process.exit(130)
    }
    this.writeJson(join(this.runDir, 'state', 'checkpoint.json'), {
      version: 1,
      run_id: this.runId,
      status: 'waiting_human',
      kind: value.kind ?? 'human',
      path: value.path ?? null,
      node_id: value.node_id ?? null,
      ticket_id: value.id ?? null,
      prompt: value.prompt ?? null,
      input: value.input === undefined ? null : value.input,
      subflow_run_id: value.subflow_run_id ?? null,
      subflow_path: value.subflow_path ?? null,
      created_at: now(),
    })
    this.log({ phase: 'waiting', path: value.path ?? null, node_id: value.node_id ?? null, status: 'waiting', ticket_id: value.id ?? null })
    process.exit(75)
  }

  async fail(error) {
    if (this.isWaitingSignal(error)) return this.waiting(error.ticket)
    const failure = (error && error.name === 'StepFailure' && isObject(error.error))
      ? error.error
      : {
        node_id: (error && error.node_id) || null,
        path: (error && error.path) || null,
        message: error && error.message ? String(error.message) : String(error || '节点失败'),
      }
    this.writeJson(join(this.runDir, 'error.json'), {
      ...failure,
      at: now(),
      run_id: this.runId,
      stack: error && error.stack ? String(error.stack) : null,
    })
    this.log({ phase: 'finish', status: 'failed', error: failure.message })
    process.exit(1)
  }
}

/** 读取 RMS_RUN_DIR 下的 manifest.json，返回可被 pipeline.mjs 直接使用的运行时。 */
export async function createRuntime(options = {}) {
  const runDir = resolve(options.runDir || process.env.RMS_RUN_DIR || process.cwd())
  const manifestPath = join(runDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`PACKAGE_INVALID：缺少 ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const runId = String(options.runId || process.env.RMS_RUN_ID || manifest.run_id || '')
  return new Runtime(runDir, manifest, runId)
}
