const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => value === undefined ? null : structuredClone(value)

const NODE_TYPES = new Set(['det', 'llm', 'human', 'agent', 'tool', 'script', 'http', 'subflow', 'sequence', 'branch', 'fold', 'loop', 'or_else', 'fanout', 'merge', 'persist', 'stub'])
const PERSIST_OPERATIONS = new Set(['create', 'get', 'update', 'delete', 'list'])
const CONTROL_NODE_TYPES = new Set(['sequence', 'branch', 'fold', 'loop', 'or_else', 'fanout', 'merge'])
const fanoutMax = () => Math.max(1, Number(process.env.RMS_FLOW_FANOUT_MAX) || 8)
const fanoutConcurrency = () => Math.max(1, Number(process.env.RMS_FLOW_FANOUT_CONCURRENCY) || 4)
const SCRIPT_RUNTIMES = new Set(['bash', 'sh', 'powershell', 'pwsh', 'node', 'ts', 'python', 'python3'])
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const INPUT_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'json', 'array', 'object'])
const INPUT_JUDGES = new Set(['deterministic', 'llm'])
const OUTPUT_LIMIT = 10 * 1024 * 1024
const execTimeout = () => Number(process.env.RMS_FLOW_EXEC_TIMEOUT_MS || 120000)
// 这些叶子节点的输入/输出会落盘成运行产物
const ARTIFACT_NODE_TYPES = new Set(['script', 'http', 'tool', 'llm', 'agent', 'human'])

const safePathKey = path => String(path || 'root').replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'root'

/** 节点产物目录：<run>/nodes/<path>/ */
function artifactDirOf(ctx, path) {
  if (!ctx.artifactsDir) return null
  return join(ctx.artifactsDir, 'nodes', safePathKey(path))
}

function writeJsonFile(file, value) {
  writeFileSync(file, `${JSON.stringify(value === undefined ? null : value, null, 2)}\n`, 'utf8')
}

function appendRunLog(ctx, entry) {
  if (!ctx.artifactsDir) return
  try {
    mkdirSync(ctx.artifactsDir, { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), run_id: ctx.run && ctx.run.id, ...entry })
    writeFileSync(join(ctx.artifactsDir, 'run.log'), `${line}\n`, { flag: 'a' })
  } catch {}
}

/** 把一次节点执行的输入、输出/错误、结果元数据写入运行产物目录。 */
function writeNodeArtifacts(ctx, node, path, input, result) {
  if (!ARTIFACT_NODE_TYPES.has(node.type)) return null
  const dir = artifactDirOf(ctx, path)
  if (!dir) return null
  try {
    mkdirSync(join(dir, 'work'), { recursive: true })
    writeJsonFile(join(dir, 'input.json'), input)
    const meta = {
      node_id: node.id,
      label: node.label || node.id,
      type: node.type,
      path,
      finished_at: new Date().toISOString(),
    }
    if (result.kind === 'value') {
      writeJsonFile(join(dir, 'output.json'), result.value)
      if (result.details !== undefined) writeJsonFile(join(dir, 'details.json'), result.details)
      writeJsonFile(join(dir, 'meta.json'), { ...meta, status: 'completed' })
    } else if (result.kind === 'failure') {
      writeJsonFile(join(dir, 'error.json'), result.error || { message: '节点失败' })
      writeJsonFile(join(dir, 'meta.json'), { ...meta, status: 'failed' })
    } else if (result.kind === 'waiting') {
      writeJsonFile(join(dir, 'meta.json'), { ...meta, status: 'waiting_human', prompt: result.pending && result.pending.prompt })
    }
    appendRunLog(ctx, { path, node_id: node.id, type: node.type, status: result.kind })
    return dir
  } catch {
    return null
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

export const hashNode = node => createHash('sha256').update(JSON.stringify(canonical(node))).digest('hex')

function validateBuildPlaceholder(node, path) {
  const build = node.build
  if (!isObject(build)) throw new Error(`${path}.build 必须是对象`)
  if (typeof build.task !== 'string' || !build.task.trim()) throw new Error(`${path}.build.task 不能为空`)
  if (build.inputs !== undefined && !isObject(build.inputs)) throw new Error(`${path}.build.inputs 必须是对象`)
  if (build.workspace !== undefined && typeof build.workspace !== 'string') throw new Error(`${path}.build.workspace 必须是字符串`)
  if (build.sample_input !== undefined) JSON.stringify(build.sample_input)
}

function validateNode(node, ids, path, options = {}) {
  if (!isObject(node)) throw new Error(`${path} 必须是对象`)
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(String(node.id || ''))) {
    throw new Error(`${path}.id 必须是 ASCII 字母开头的节点 id`)
  }
  if (ids.has(node.id)) throw new Error(`节点 id 重复：${node.id}`)
  ids.add(node.id)
  if (!NODE_TYPES.has(node.type)) throw new Error(`${path}.type 不支持：${node.type}`)
  if (hasOwn(node, 'label') && typeof node.label !== 'string') throw new Error(`${path}.label 必须是字符串`)

  if (node.type === 'det') {
    if (!['expr', 'literal', 'assert'].includes(node.op)) throw new Error(`${path}.op 仅支持 expr/literal/assert`)
    if (node.op === 'expr' && !hasOwn(node, 'expr')) throw new Error(`${path}.expr 不能为空`)
    if (node.op === 'literal' && !hasOwn(node, 'value')) throw new Error(`${path}.value 不能为空`)
    if (node.op === 'assert' && !hasOwn(node, 'condition')) throw new Error(`${path}.condition 不能为空`)
  } else if (node.type === 'llm') {
    if (!['gen', 'choose'].includes(node.mode)) throw new Error(`${path}.mode 仅支持 gen/choose`)
    if (typeof node.prompt !== 'string' || !node.prompt.trim()) throw new Error(`${path}.prompt 不能为空`)
    if (node.mode === 'gen' && !['json', 'text', undefined].includes(node.output)) {
      throw new Error(`${path}.output 仅支持 json/text`)
    }
    if (node.mode === 'choose') {
      if (!hasOwn(node, 'options') && !hasOwn(node, 'options_expr')) {
        throw new Error(`${path} 需要 options 或 options_expr`)
      }
      if (hasOwn(node, 'options') && hasOwn(node, 'options_expr')) {
        throw new Error(`${path} 不能同时提供 options 与 options_expr`)
      }
      if (hasOwn(node, 'options') && (!Array.isArray(node.options) || node.options.length === 0)) {
        throw new Error(`${path}.options 必须是非空数组`)
      }
    }
  } else if (node.type === 'human') {
    if (typeof node.prompt !== 'string' || !node.prompt.trim()) throw new Error(`${path}.prompt 不能为空`)
  } else if (node.type === 'agent') {
    if (typeof node.prompt !== 'string' || !node.prompt.trim()) throw new Error(`${path}.prompt 不能为空`)
    if (!['json', 'text', undefined].includes(node.output)) throw new Error(`${path}.output 仅支持 json/text`)
    if (node.system !== undefined && typeof node.system !== 'string') throw new Error(`${path}.system 必须是字符串`)
  } else if (node.type === 'tool') {
    if (typeof node.tool !== 'string' || !node.tool.trim()) throw new Error(`${path}.tool 不能为空`)
    if (!['json', 'text', undefined].includes(node.output)) throw new Error(`${path}.output 仅支持 json/text`)
  } else if (node.type === 'script') {
    if (!SCRIPT_RUNTIMES.has(node.runtime)) throw new Error(`${path}.runtime 仅支持 ${[...SCRIPT_RUNTIMES].join('/')}`)
    if (typeof node.code !== 'string' || !node.code.trim()) throw new Error(`${path}.code 不能为空`)
    if (node.args !== undefined && (!Array.isArray(node.args) || node.args.some(item => typeof item !== 'string'))) {
      throw new Error(`${path}.args 必须是字符串数组`)
    }
    if (node.cwd !== undefined && typeof node.cwd !== 'string') throw new Error(`${path}.cwd 必须是字符串`)
    if (node.env !== undefined && (!isObject(node.env) || Object.values(node.env).some(item => typeof item !== 'string'))) {
      throw new Error(`${path}.env 必须是字符串值对象`)
    }
    if (node.timeout_ms !== undefined && (!Number.isInteger(node.timeout_ms) || node.timeout_ms < 1)) {
      throw new Error(`${path}.timeout_ms 必须是正整数`)
    }
    if (!['json', 'text', undefined].includes(node.output)) throw new Error(`${path}.output 仅支持 json/text`)
  } else if (node.type === 'http') {
    if (!hasOwn(node, 'url')) throw new Error(`${path}.url 不能为空`)
    if (node.method !== undefined && !HTTP_METHODS.has(String(node.method).toUpperCase())) {
      throw new Error(`${path}.method 仅支持 ${[...HTTP_METHODS].join('/')}`)
    }
    if (node.headers !== undefined && !isObject(node.headers)) throw new Error(`${path}.headers 必须是对象`)
    if (node.timeout_ms !== undefined && (!Number.isInteger(node.timeout_ms) || node.timeout_ms < 1)) {
      throw new Error(`${path}.timeout_ms 必须是正整数`)
    }
    if (!['json', 'text', undefined].includes(node.output)) throw new Error(`${path}.output 仅支持 json/text`)
  } else if (node.type === 'subflow') {
    const sources = ['definition', 'ref', 'build', 'matrix_id'].filter(key => node[key] !== undefined)
    if (sources.length > 1) {
      throw new Error(`${path} 的 definition/ref/build/matrix_id 只能四选一`)
    }
    if (sources.length === 0) {
      throw new Error(`${path} 需要 definition、ref、build 或 matrix_id`)
    }
    if (node.matrix_id !== undefined && !/^mx_[A-Za-z0-9_-]{4,40}$/.test(String(node.matrix_id))) {
      throw new Error(`${path}.matrix_id 格式不正确：${node.matrix_id}`)
    }
    if (node.build !== undefined) {
      if (!options.allowBuildPlaceholder) {
        throw new Error(`${path} 仍是 subflow.build 占位，必须先完成构建（flow_build）才能执行`)
      }
      validateBuildPlaceholder(node, path)
    }
    if (node.definition !== undefined) validateDefinition(node.definition, options)
    if (node.ref !== undefined) {
      if (typeof node.ref === 'string') {
        if (!node.ref.trim()) throw new Error(`${path}.ref 不能为空`)
      } else if (isObject(node.ref)) {
        if (typeof node.ref.name !== 'string' || !node.ref.name.trim()) throw new Error(`${path}.ref.name 不能为空`)
        if (node.ref.version !== undefined && (!Number.isInteger(node.ref.version) || node.ref.version < 1)) {
          throw new Error(`${path}.ref.version 必须是正整数`)
        }
      } else {
        throw new Error(`${path}.ref 必须是定义名字符串或 { name, version }`)
      }
    }
    if (node.workspace !== undefined && typeof node.workspace !== 'string') throw new Error(`${path}.workspace 必须是字符串`)
    if (node.fuel !== undefined && (!Number.isInteger(node.fuel) || node.fuel < 1 || node.fuel > 10000)) {
      throw new Error(`${path}.fuel 必须是 1..10000 的整数`)
    }
    if (node.recursion !== undefined && typeof node.recursion !== 'boolean') throw new Error(`${path}.recursion 必须是 boolean`)
  } else if (node.type === 'sequence') {
    if (!Array.isArray(node.steps) || node.steps.length === 0) throw new Error(`${path}.steps 必须是非空数组`)
    node.steps.forEach((step, index) => validateNode(step, ids, `${path}.steps[${index}]`, options))
  } else if (node.type === 'branch') {
    if (!hasOwn(node, 'condition')) throw new Error(`${path}.condition 不能为空`)
    validateNode(node.then, ids, `${path}.then`, options)
    if (node.else !== undefined) validateNode(node.else, ids, `${path}.else`, options)
  } else if (node.type === 'fold') {
    if (!hasOwn(node, 'items')) throw new Error(`${path}.items 不能为空`)
    validateNode(node.body, ids, `${path}.body`, options)
  } else if (node.type === 'loop') {
    if (!hasOwn(node, 'while')) throw new Error(`${path}.while 不能为空`)
    validateNode(node.body, ids, `${path}.body`, options)
    if (node.max_iterations !== undefined && (!Number.isInteger(node.max_iterations) || node.max_iterations < 1)) {
      throw new Error(`${path}.max_iterations 必须是正整数`)
    }
  } else if (node.type === 'or_else') {
    validateNode(node.primary, ids, `${path}.primary`, options)
    validateNode(node.fallback, ids, `${path}.fallback`, options)
  } else if (node.type === 'fanout') {
    const max = fanoutMax()
    if (!Array.isArray(node.branches) || !node.branches.length) throw new Error(`${path}.branches 必须是非空数组`)
    if (node.branches.length > max) throw new Error(`${path}.branches 不能超过 ${max} 个（RMS_FLOW_FANOUT_MAX）`)
    if (node.collect !== undefined && !['keyed', 'array'].includes(node.collect)) {
      throw new Error(`${path}.collect 仅支持 keyed/array`)
    }
    if (node.collect !== 'array' && (!isObject(node.outputs) || !Object.keys(node.outputs).length)) {
      throw new Error(`${path}.outputs 必须是对象，且 keyed 模式下覆盖所有分支 id`)
    }
    const carry = node.carry === undefined ? [] : node.carry
    if (!Array.isArray(carry) || carry.some(key => typeof key !== 'string' || !key.trim())) {
      throw new Error(`${path}.carry 必须是非空字段名字符串数组`)
    }
    if (new Set(carry).size !== carry.length) throw new Error(`${path}.carry 字段名不能重复`)
    if (carry.length && node.collect === 'array') {
      throw new Error(`${path}.carry 只支持 collect=keyed`)
    }
    node.branches.forEach((branch, index) => {
      if (!isObject(branch)) throw new Error(`${path}.branches[${index}] 必须是对象`)
      if (branch.type === 'fanout' || branch.type === 'merge' || CONTROL_NODE_TYPES.has(branch.type)) {
        throw new Error(`${path}.branches[${index}] 只能是叶子节点，不能嵌套控制流：${branch.type}`)
      }
      validateNode(branch, ids, `${path}.branches[${index}]`, options)
    })
    if (carry.length) {
      if (!isObject(node.inputs)) throw new Error(`${path}.carry 需要 inputs 是字段对象`)
      const missing = carry.filter(key => !hasOwn(node.inputs, key))
      if (missing.length) throw new Error(`${path}.carry 字段不在 fanout 输入中：${missing.join('、')}`)
      const collisions = carry.filter(key => node.branches.some(branch => branch.id === key))
      if (collisions.length) throw new Error(`${path}.carry 字段不能与分支 id 重名：${collisions.join('、')}`)
    }
    if (node.collect !== 'array') {
      const missing = node.branches.map(branch => branch.id).concat(carry)
        .filter(key => !hasOwn(node.outputs, key))
      if (missing.length) throw new Error(`${path}.outputs 缺少分支或 carry 输出：${missing.join('、')}`)
    }
  } else if (node.type === 'merge') {
    if (!isObject(node.mapping) || !Object.keys(node.mapping).length) throw new Error(`${path}.mapping 必须是非空对象`)
    if (!isObject(node.outputs) || !Object.keys(node.outputs).length) throw new Error(`${path}.outputs 必须是非空对象`)
    const outputKeys = Object.keys(node.outputs)
    const mappingKeys = Object.keys(node.mapping)
    const missing = outputKeys.filter(key => !mappingKeys.includes(key))
    const extra = mappingKeys.filter(key => !outputKeys.includes(key))
    if (missing.length || extra.length) {
      throw new Error(`${path}.mapping 与 outputs 必须一一对应（缺少：${missing.join('、') || '无'}；多出：${extra.join('、') || '无'}）`)
    }
  } else if (node.type === 'persist') {
    if (!/^mdl_[A-Za-z0-9_-]{4,40}$/.test(String(node.model_id || ''))) {
      throw new Error(`${path}.model_id 必须是 mdl_ 开头的 model id`)
    }
    if (!PERSIST_OPERATIONS.has(node.operation)) {
      throw new Error(`${path}.operation 仅支持 ${[...PERSIST_OPERATIONS].join('/')}`)
    }
    if (node.key !== undefined && typeof node.key !== 'string') throw new Error(`${path}.key 必须是字符串`)
    if (node.where !== undefined && !isObject(node.where)) throw new Error(`${path}.where 必须是对象`)
  } else if (node.type === 'stub') {
    if (!/^stb_[A-Za-z0-9_-]{4,40}$/.test(String(node.stub_id || ''))) {
      throw new Error(`${path}.stub_id 必须是 stb_ 开头的 stub id`)
    }
    if (typeof node.operation !== 'string' || !node.operation.trim()) throw new Error(`${path}.operation 不能为空`)
    if (!/^mx_[A-Za-z0-9_-]{4,40}$/.test(String(node.matrix_id || ''))) {
      throw new Error(`${path}.matrix_id 必须是 stub 根 matrix 的 mx_ id`)
    }
    for (const field of ['request_model_ids', 'response_model_ids']) {
      if (node[field] !== undefined && (!Array.isArray(node[field]) || node[field].some(id => typeof id !== 'string'))) {
        throw new Error(`${path}.${field} 必须是字符串数组`)
      }
    }
  }
}

function checkInputValue(name, spec, value) {
  const type = spec.type
  const valid = type === 'json' ? true
    : type === 'string' ? typeof value === 'string'
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'integer' ? Number.isInteger(value)
          : type === 'boolean' ? typeof value === 'boolean'
            : type === 'array' ? Array.isArray(value)
              : isObject(value)
  if (!valid) throw new Error(`输入 ${name} 必须是 ${type}`)
  if (Array.isArray(spec.enum) && !spec.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`输入 ${name} 必须是 ${spec.enum.map(item => JSON.stringify(item)).join(' / ')} 之一`)
  }
  if (typeof value === 'number') {
    if (typeof spec.min === 'number' && value < spec.min) throw new Error(`输入 ${name} 不能小于 ${spec.min}`)
    if (typeof spec.max === 'number' && value > spec.max) throw new Error(`输入 ${name} 不能大于 ${spec.max}`)
  }
}

function validateInputSchema(schema) {
  if (!isObject(schema) || !Object.keys(schema).length) throw new Error('definition.inputs 必须是非空对象')
  for (const [name, spec] of Object.entries(schema)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`inputs 字段名不合法：${name}`)
    const path = `definition.inputs.${name}`
    if (!isObject(spec)) throw new Error(`${path} 必须是对象`)
    if (!INPUT_TYPES.has(spec.type)) throw new Error(`${path}.type 仅支持 ${[...INPUT_TYPES].join('/')}`)
    if (spec.judge !== undefined && !INPUT_JUDGES.has(spec.judge)) throw new Error(`${path}.judge 仅支持 ${[...INPUT_JUDGES].join('/')}`)
    if (spec.required !== undefined && typeof spec.required !== 'boolean') throw new Error(`${path}.required 必须是 boolean`)
    if (spec.description !== undefined && typeof spec.description !== 'string') throw new Error(`${path}.description 必须是字符串`)
    if (spec.enum !== undefined && (!Array.isArray(spec.enum) || !spec.enum.length)) throw new Error(`${path}.enum 必须是非空数组`)
    for (const bound of ['min', 'max']) {
      if (spec[bound] !== undefined && typeof spec[bound] !== 'number') throw new Error(`${path}.${bound} 必须是数字`)
    }
    if (hasOwn(spec, 'default')) checkInputValue(name, spec, spec.default)
  }
}

function hasLlmNode(node) {
  if (!isObject(node) || typeof node.type !== 'string') return false
  if (node.type === 'llm' || node.type === 'agent') return true
  if (node.type === 'sequence') return (node.steps || []).some(hasLlmNode)
  if (node.type === 'branch') return hasLlmNode(node.then) || hasLlmNode(node.else)
  if (node.type === 'fold' || node.type === 'loop') return hasLlmNode(node.body)
  if (node.type === 'or_else') return hasLlmNode(node.primary) || hasLlmNode(node.fallback)
  if (node.type === 'fanout') return (node.branches || []).some(hasLlmNode)
  return false
}

export function validateInput(definition, input) {
  const schema = definition && definition.inputs
  if (!schema) return input === undefined ? null : clone(input)
  const source = input === undefined || input === null ? {} : input
  if (!isObject(source)) throw new Error('input 必须是对象')
  for (const key of Object.keys(source)) {
    if (!hasOwn(schema, key)) throw new Error(`未知输入字段：${key}`)
  }
  const result = {}
  for (const [name, spec] of Object.entries(schema)) {
    if (hasOwn(source, name) && source[name] !== undefined) {
      checkInputValue(name, spec, source[name])
      result[name] = clone(source[name])
      continue
    }
    if (hasOwn(spec, 'default')) {
      result[name] = clone(spec.default)
      continue
    }
    if (spec.required) throw new Error(`缺少必填输入：${name}`)
  }
  return result
}

export function validateDefinition(definition, options = {}) {
  if (!isObject(definition)) throw new Error('definition 必须是对象')
  if (definition.version !== 1) throw new Error('definition.version 必须为 1')
  if (definition.fuel !== undefined && (!Number.isInteger(definition.fuel) || definition.fuel < 1 || definition.fuel > 10000)) {
    throw new Error('definition.fuel 必须是 1..10000 的整数')
  }
  validateNode(definition.entry, new Set(), 'definition.entry', options)
  if (definition.inputs !== undefined) {
    validateInputSchema(definition.inputs)
    const needsLlm = Object.values(definition.inputs).some(spec => spec.judge === 'llm')
    if (needsLlm && !hasLlmNode(definition.entry)) {
      throw new Error('definition.inputs 声明了 judge=llm 字段，但 entry 里没有 llm/agent 节点负责解析')
    }
  }
  JSON.stringify(definition)
  return definition
}

function nodeChildren(node) {
  if (!isObject(node)) return []
  if (node.type === 'sequence') return Array.isArray(node.steps) ? node.steps.map(step => ({ node: step, path: step?.id })) : []
  if (node.type === 'branch') {
    return [['then', node.then], ['else', node.else]].filter(([, child]) => isObject(child))
      .map(([key, child]) => ({ node: child, path: child.id || key }))
  }
  if (node.type === 'fold' || node.type === 'loop') return isObject(node.body) ? [{ node: node.body, path: node.body.id }] : []
  if (node.type === 'or_else') {
    return [['primary', node.primary], ['fallback', node.fallback]].filter(([, child]) => isObject(child))
      .map(([key, child]) => ({ node: child, path: child.id || key }))
  }
  if (node.type === 'fanout') {
    return (Array.isArray(node.branches) ? node.branches : [])
      .filter(branch => isObject(branch))
      .map(branch => ({ node: branch, path: branch.id }))
  }
  if (node.type === 'subflow' && isObject(node.definition?.entry)) {
    return [{ node: node.definition.entry, path: node.definition.entry.id || 'entry', prefix: 'subflow' }]
  }
  return []
}

function visitNodes(root, visit, path = 'entry') {
  if (!isObject(root)) return
  visit(root, path)
  for (const child of nodeChildren(root)) {
    const nextPath = child.prefix ? `${path}.${child.prefix}.${child.path}` : `${path}.${child.path}`
    visitNodes(child.node, visit, nextPath)
  }
}

export function collectBuildPlaceholders(definition) {
  const found = []
  if (!isObject(definition)) return found
  visitNodes(definition.entry, (node, path) => {
    if (node.type === 'subflow' && node.build !== undefined && node.definition === undefined && node.ref === undefined) {
      found.push({ node_id: node.id, label: node.label || node.id, path, build: clone(node.build) })
    }
  })
  return found
}

export function assertExecutable(definition) {
  const placeholders = collectBuildPlaceholders(definition)
  if (!placeholders.length) return definition
  const ids = placeholders.map(item => item.node_id).join('、')
  throw new Error(`存在未构建的子流程占位：${ids}；请先用 flow_build 以 from_run_id+node_id 完成构建再执行`)
}

function replaceDeep(node, nodeId, replacement, state) {
  if (!isObject(node)) return node
  if (node.id === nodeId && node.type === 'subflow'
    && (node.build !== undefined || node.definition !== undefined || node.ref !== undefined)) {
    state.replaced = true
    return typeof replacement === 'function' ? replacement(node) : clone(replacement)
  }
  const copy = { ...node }
  if (Array.isArray(node.steps)) copy.steps = node.steps.map(step => replaceDeep(step, nodeId, replacement, state))
  if (isObject(node.then)) copy.then = replaceDeep(node.then, nodeId, replacement, state)
  if (isObject(node.else)) copy.else = replaceDeep(node.else, nodeId, replacement, state)
  if (isObject(node.body)) copy.body = replaceDeep(node.body, nodeId, replacement, state)
  if (isObject(node.primary)) copy.primary = replaceDeep(node.primary, nodeId, replacement, state)
  if (isObject(node.fallback)) copy.fallback = replaceDeep(node.fallback, nodeId, replacement, state)
  if (Array.isArray(node.branches)) copy.branches = node.branches.map(branch => replaceDeep(branch, nodeId, replacement, state))
  if (node.type === 'subflow' && isObject(node.definition?.entry)) {
    const entry = replaceDeep(node.definition.entry, nodeId, replacement, state)
    if (entry !== node.definition.entry) copy.definition = { ...node.definition, entry }
  }
  return copy
}

export function replaceBuildPlaceholder(definition, nodeId, builtDefinition) {
  const state = { replaced: false }
  const next = clone(definition)
  next.entry = replaceDeep(next.entry, nodeId, placeholder => ({
    id: placeholder.id,
    type: 'subflow',
    label: placeholder.label || placeholder.id,
    ...(placeholder.input !== undefined ? { input: clone(placeholder.input) } : {}),
    ...(placeholder.workspace !== undefined ? { workspace: placeholder.workspace } : {}),
    ...(placeholder.fuel !== undefined ? { fuel: placeholder.fuel } : {}),
    ...(placeholder.recursion !== undefined ? { recursion: placeholder.recursion } : {}),
    definition: clone(builtDefinition),
  }), state)
  if (!state.replaced) throw new Error(`没有找到待回填的子流程占位：${nodeId}`)
  validateDefinition(next, { allowBuildPlaceholder: true })
  return next
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

export function evaluateExpression(expression, data) {
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

const valueResult = (value, details) => ({ kind: 'value', value: clone(value), details })
const failureResult = (node, path, message) => ({
  kind: 'failure',
  error: { node_id: node.id, label: node.label || node.id, path, message: String(message || '节点失败') },
})
const waitingResult = (node, path, input) => ({
  kind: 'waiting',
  pending: {
    node_id: node.id,
    label: node.label || node.id,
    kind: node.type,
    path,
    prompt: node.prompt,
    input: clone(input),
  },
})

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

async function executeLlm(ctx, node, input) {
  if (!ctx.llm || typeof ctx.llm.complete !== 'function') throw new Error('LLM 执行器不可用')
  if (node.mode === 'gen') {
    const response = await ctx.llm.complete({
      system: node.output === 'text'
        ? '你是工作流中的 gen 判定核。根据指令和输入生成结果，只输出结果正文。'
        : '你是工作流中的 gen 判定核。根据指令和输入生成结果，只输出合法 JSON，不要输出 Markdown 代码围栏。',
      user: JSON.stringify({ instructions: node.prompt, input }, null, 2),
    })
    const output = node.output === 'text' ? String(response.content).trim() : parseJson(response.content)
    return valueResult(output, { llm_mode: 'gen', model: response.model || null })
  }

  const options = hasOwn(node, 'options_expr')
    ? evaluateExpression(node.options_expr, input)
    : clone(node.options)
  if (!Array.isArray(options) || options.length === 0) throw new Error('choose 候选集必须是非空数组')
  const choices = options.map((option, index) => {
    const object = isObject(option) ? option : {}
    return {
      id: String(hasOwn(object, 'id') ? object.id : index),
      label: String(hasOwn(object, 'label') ? object.label : (isObject(option) ? `选项 ${index + 1}` : option)),
      description: object.description ? String(object.description) : undefined,
      option,
    }
  })
  if (new Set(choices.map(choice => choice.id)).size !== choices.length) throw new Error('choose 候选 id 必须唯一')
  const response = await ctx.llm.complete({
    system: '你是工作流中的 choose 选项判定核。只能选择一个候选，只输出 {"choice":"候选id"} 的合法 JSON。',
    user: JSON.stringify({ instructions: node.prompt, input, options: choices }, null, 2),
  })
  const parsed = parseJson(response.content)
  const selectedId = String(parsed.choice ?? parsed.id ?? '')
  const selected = choices.find(choice => choice.id === selectedId)
  if (!selected) throw new Error(`choose 返回了未知候选 id：${selectedId}`)
  const output = isObject(selected.option) && hasOwn(selected.option, 'value')
    ? selected.option.value
    : selected.option
  return valueResult(output, { llm_mode: 'choose', choice_id: selectedId, model: response.model || null })
}

async function executeAgent(ctx, node, input) {
  if (typeof ctx.agent !== 'function') {
    throw new Error('agent 节点需要 dsh 宿主的 agent 运行时；当前平面未提供 agentRunner')
  }
  const response = await ctx.agent({
    system: node.system || '你是工作流中的只读调查节点：可以读取代码与轨迹，但不要修改仓库文件。',
    prompt: node.prompt,
    input,
    workspace: ctx.workspace || undefined,
  })
  const text = String(response?.text ?? response?.content ?? response ?? '').trim()
  if (!text) throw new Error('agent 节点没有返回内容')
  const output = node.output === 'text' ? text : parseJson(text)
  return valueResult(output, { agent_mode: 'loop', messages: response?.messages ?? 1 })
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

function scriptExtension(runtime, code = '') {
  if (runtime === 'python' || runtime === 'python3') return 'py'
  if (runtime === 'node') {
    // node 脚本可能是 CommonJS（require/module.exports）或 ESM（import/export）。
    // 用 .mjs 运行 CJS 会报 “require is not defined”；按语法选择扩展名，两种写法都能跑。
    const text = String(code || '')
    const esm = /(^|\n)\s*(?:import\s+[\w*{'"]|import\s*\(|export\s+(?:default|const|let|var|function|class|async|{))/m.test(text)
    return esm ? 'mjs' : 'cjs'
  }
  if (runtime === 'ts') return 'ts'
  if (runtime === 'powershell' || runtime === 'pwsh') return 'ps1'
  return 'sh'
}

function runProcess({ command, args, cwd, env, timeoutMs, stdin }) {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`${command} 启动失败：${error.message}`))
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timedOut) reject(new Error(`${command} 超过 ${timeoutMs}ms 未结束`))
      else if (code !== 0) reject(new Error(`${command} 退出码 ${code}：${(stderr || stdout).trim().slice(0, 800) || '无输出'}`))
      else resolve({ stdout, stderr, code })
    })
    if (child.stdin) child.stdin.end(stdin === undefined ? '' : stdin)
  })
}

async function executeScript(node, input, ctx, path) {
  const runtime = node.runtime
  const base = ctx.workspace || process.cwd()
  const ioMode = ctx.ioMode || 'files'
  const artifactDir = artifactDirOf(ctx, path)
  // 文件式 I/O：本次运行共享一个 workspace，节点之间的数据通过文件传递；
  // 每个节点另有自己的 work 目录存放脚本本体与日志。
  const runWorkspace = ctx.artifactsDir ? join(ctx.artifactsDir, 'workspace') : null
  if (runWorkspace) mkdirSync(runWorkspace, { recursive: true })
  const workDir = artifactDir ? join(artifactDir, 'work') : null
  if (workDir) mkdirSync(workDir, { recursive: true })
  const dir = ioMode === 'files' && workDir
    ? workDir
    : await mkdtemp(join(tmpdir(), 'rms-flow-script-'))
  const cwd = node.cwd
    ? (isAbsolute(node.cwd) ? node.cwd : resolve(base, node.cwd))
    // files 模式用本次运行共享目录；inline 模式保持旧行为：matrix 工作目录
    : (ioMode === 'files' && runWorkspace ? runWorkspace : base)
  const file = join(dir, `main.${scriptExtension(runtime, node.code)}`)
  const inputFile = artifactDir ? join(artifactDir, 'input.json') : null
  const outputFile = artifactDir ? join(artifactDir, 'output.json') : null
  try {
    await writeFile(file, node.code, 'utf8')
    if (ioMode === 'files' && inputFile) writeJsonFile(inputFile, input)
    const env = {
      ...(node.env || {}),
      RMS_NODE_ID: String(node.id),
      RMS_RUN_ID: String(ctx.run && ctx.run.id || ''),
      RMS_NODE_DIR: dir,
      ...(runWorkspace ? { RMS_RUN_DIR: runWorkspace } : {}),
      ...(artifactDir ? { RMS_ARTIFACT_DIR: artifactDir } : {}),
      ...(ioMode === 'files' && inputFile ? { RMS_INPUT_FILE: inputFile } : {}),
      ...(ioMode === 'files' && outputFile ? { RMS_OUTPUT_FILE: outputFile } : {}),
    }
    const { command, args } = runtimeCommand(runtime, file)
    const started = Date.now()
    const result = await runProcess({
      command,
      args: [...args, ...(node.args || [])],
      cwd,
      env,
      timeoutMs: node.timeout_ms || execTimeout(),
      // 文件模式也保留 stdin，旧脚本不改也能跑
      stdin: JSON.stringify(input ?? null),
    })
    if (artifactDir) {
      try {
        writeFileSync(join(artifactDir, 'stdout.log'), result.stdout || '', 'utf8')
        writeFileSync(join(artifactDir, 'stderr.log'), result.stderr || '', 'utf8')
      } catch {}
    }
    let output
    if (ioMode === 'files' && outputFile && existsSync(outputFile)) {
      const text = readFileSync(outputFile, 'utf8').trim()
      if (!text) throw new Error(`${runtime} 脚本写入的 output.json 是空的`)
      output = node.output === 'text' ? text : parseJson(text)
    } else {
      const text = result.stdout.trim()
      if (!text) {
        throw new Error(`${runtime} 脚本没有输出内容${ioMode === 'files' ? '（请写 output.json 或打印到 stdout）' : ''}`)
      }
      output = node.output === 'text' ? result.stdout : parseJson(text)
    }
    return valueResult(output, {
      runtime,
      cwd,
      exit_code: result.code,
      duration_ms: Date.now() - started,
      io_mode: ioMode,
      artifact_dir: artifactDir,
    })
  } finally {
    if (ioMode !== 'files' || !workDir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function executeHttp(node, input) {
  const url = String(typeof node.url === 'string' ? node.url : evaluateExpression(node.url, input) ?? '')
  if (!/^https?:\/\//i.test(url)) throw new Error('http.url 必须是 http/https 地址')
  const method = String(node.method || 'GET').toUpperCase()
  const rawHeaders = node.headers ? evaluateExpression(node.headers, input) : {}
  const headers = {}
  for (const [key, value] of Object.entries(rawHeaders || {})) headers[key] = String(value ?? '')
  const body = hasOwn(node, 'body') ? evaluateExpression(node.body, input) : undefined
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
  if (node.output === 'text') return valueResult(text, details)
  if (!/json/i.test(contentType)) throw new Error(`http 响应不是 JSON（${contentType || 'unknown'}）：${text.slice(0, 200)}`)
  return valueResult(parseJson(text), details)
}

async function executeTool(ctx, node, input) {
  if (typeof ctx.tool !== 'function') {
    throw new Error('tool 节点需要宿主提供 toolRunner；MCP 平面请改用 script 或 http 节点')
  }
  const args = hasOwn(node, 'args') ? evaluateExpression(node.args, input) : input
  const response = await ctx.tool({ name: node.tool, args, input })
  const value = isObject(response) && hasOwn(response, 'value') ? response.value : response
  const output = node.output === 'text' ? String(value ?? '') : (typeof value === 'string' ? parseJson(value) : value)
  return valueResult(output, { tool: node.tool })
}

async function executeSubflow(ctx, node, input, path) {
  if (typeof ctx.subflow !== 'function') {
    throw new Error('subflow 节点需要宿主提供子流程执行器')
  }
  if (ctx.resume && ctx.resume.path === path && !ctx.resumeConsumed) {
    ctx.resumeConsumed = true
    if (ctx.resume.failed) {
      return failureResult(node, path, ctx.resume.error?.message || '子流程失败')
    }
    return valueResult(ctx.resume.value, { resumed: true, subflow_run_id: ctx.resume.subflow_run_id || null })
  }
  const childInput = hasOwn(node, 'input') ? evaluateExpression(node.input, input) : input
  const response = await ctx.subflow({ node, input: childInput, path, parent: ctx.run })
  const runId = response?.run_id || null
  if (response?.status === 'completed') {
    return valueResult(response.output, { subflow_run_id: runId, depth: response.depth ?? null })
  }
  if (response?.status === 'waiting_human') {
    return {
      kind: 'waiting',
      pending: {
        node_id: node.id,
        label: node.label || node.id,
        kind: 'subflow',
        path,
        prompt: response.pending?.prompt || '子流程等待人工输入',
        input: clone(childInput),
        subflow_run_id: runId,
        subflow_path: response.pending?.path || null,
      },
    }
  }
  return failureResult(node, path, `子流程 ${runId || ''} 失败：${response?.error?.message || '未知错误'}`)
}

function executeDet(node, input) {
  if (node.op === 'literal') return valueResult(node.value)
  if (node.op === 'expr') return valueResult(evaluateExpression(node.expr, input))
  if (!evaluateExpression(node.condition, input)) {
    return failureResult(node, '', node.message || 'Det assert 条件不满足')
  }
  return valueResult(input)
}

async function executeNodeBody(ctx, node, input, path) {
  if (node.type === 'det') return executeDet(node, input)
  if (node.type === 'llm') return executeLlm(ctx, node, input)
  if (node.type === 'agent') return executeAgent(ctx, node, input)
  if (node.type === 'tool') return executeTool(ctx, node, input)
  if (node.type === 'script') return executeScript(node, input, ctx, path)
  if (node.type === 'http') return executeHttp(node, input)
  if (node.type === 'subflow') return executeSubflow(ctx, node, input, path)
  if (node.type === 'human') {
    if (ctx.resume && ctx.resume.path === path && !ctx.resumeConsumed) {
      ctx.resumeConsumed = true
      return valueResult(ctx.resume.value, { resumed: true })
    }
    return waitingResult(node, path, input)
  }
  if (node.type === 'sequence') {
    let current = input
    for (const step of node.steps) {
      const result = await executeNode(ctx, step, current, `${path}/${step.id}`)
      if (result.kind !== 'value') return result
      current = result.value
    }
    return valueResult(current)
  }
  if (node.type === 'branch') {
    const condition = evaluateExpression(node.condition, input)
    const child = condition ? node.then : node.else
    if (!child) return valueResult(input, { branch: false })
    const result = await executeNode(ctx, child, input, `${path}/${child.id}`)
    return result.kind === 'value' ? { ...result, details: { branch: Boolean(condition) } } : result
  }
  if (node.type === 'fold') {
    const items = evaluateExpression(node.items, input)
    if (!Array.isArray(items)) throw new Error('fold.items 必须求值为数组')
    let acc = hasOwn(node, 'initial') ? clone(node.initial) : null
    for (let index = 0; index < items.length; index += 1) {
      const bodyInput = { acc, item: items[index], index }
      const result = await executeNode(ctx, node.body, bodyInput, `${path}/item:${index}/${node.body.id}`)
      if (result.kind !== 'value') return result
      acc = result.value
    }
    return valueResult(acc, { iterations: items.length })
  }
  if (node.type === 'loop') {
    let current = input
    let iteration = 0
    while (evaluateExpression(node.while, current)) {
      if (node.max_iterations !== undefined && iteration >= node.max_iterations) {
        throw new Error(`loop 达到 max_iterations=${node.max_iterations}`)
      }
      const result = await executeNode(ctx, node.body, current, `${path}/iter:${iteration}/${node.body.id}`)
      if (result.kind !== 'value') return result
      current = result.value
      iteration += 1
    }
    return valueResult(current, { iterations: iteration })
  }
  if (node.type === 'or_else') {
    const primary = await executeNode(ctx, node.primary, input, `${path}/${node.primary.id}`)
    if (primary.kind !== 'failure') return primary
    const fallback = await executeNode(ctx, node.fallback, input, `${path}/${node.fallback.id}`)
    return fallback.kind === 'value'
      ? { ...fallback, details: { recovered_from: primary.error } }
      : fallback
  }
  if (node.type === 'fanout') {
    const branchInput = hasOwn(node, 'input') ? evaluateExpression(node.input, input) : input
    const results = await mapLimit(node.branches, fanoutConcurrency(), branch =>
      executeNode(ctx, branch, branchInput, `${path}/${branch.id}`))
    const interrupted = results.find(result => result.kind !== 'value')
    if (interrupted) return interrupted
    const values = results.map(result => result.value)
    const output = node.collect === 'array'
      ? values
      : Object.fromEntries(node.branches.map((branch, index) => [branch.id, values[index]]))
    return valueResult(output, { branches: node.branches.map(branch => branch.id) })
  }
  if (node.type === 'merge') {
    return valueResult(evaluateExpression(node.mapping, input), { op: 'merge' })
  }
  throw new Error(`未知节点类型：${node.type}`)
}

async function persist(ctx) {
  ctx.run.updated_at = new Date().toISOString()
  if (ctx.onChange) await ctx.onChange(ctx.run)
}

async function beginTrace(ctx, node, path, input) {
  let entry = ctx.entries.get(path)
  if (!entry) {
    entry = {
      seq: ctx.run.trace.length + 1,
      node_id: node.id,
      label: node.label || node.id,
      kind: node.type,
      node_hash: hashNode(node),
      path,
      status: 'running',
      started_at: new Date().toISOString(),
      input: clone(input),
    }
    ctx.run.trace.push(entry)
    ctx.entries.set(path, entry)
  } else {
    entry.status = 'running'
    entry.resumed_at = new Date().toISOString()
    entry.input = clone(input)
    delete entry.output
    delete entry.error
    delete entry.details
    delete entry.prompt
    delete entry.waiting_node
    delete entry.finished_at
  }
  entry.node_hash = hashNode(node)
  if (ARTIFACT_NODE_TYPES.has(node.type)) {
    const dir = artifactDirOf(ctx, path)
    if (dir) {
      entry.artifact_dir = dir
      try { mkdirSync(join(dir, 'work'), { recursive: true }) } catch {}
    }
  }
  ctx.run.current = { node_id: node.id, label: node.label || node.id, kind: node.type, path }
  await persist(ctx)
  return entry
}

async function reuseCached(ctx, node, input, path) {
  const cached = ctx.cache.get(path)
  if (!cached || cached.status !== 'completed') return null
  if (cached.node_hash && cached.node_hash !== hashNode(node)) return null
  if (!isDeepStrictEqual(cached.input, input)) return null
  if (!ctx.entries.has(path)) {
    const entry = clone(cached)
    entry.seq = ctx.run.trace.length + 1
    entry.node_hash = cached.node_hash || hashNode(node)
    entry.reused_at = new Date().toISOString()
    delete entry.resumed_at
    ctx.run.trace.push(entry)
    ctx.entries.set(path, entry)
    await persist(ctx)
  }
  return valueResult(cached.output, cached.details)
}

async function executeNode(ctx, node, input, path) {
  const reused = await reuseCached(ctx, node, input, path)
  if (reused) return reused

  const exhausted = ctx.run.fuel.remaining <= 0
  if (!exhausted) ctx.run.fuel.remaining -= 1
  const entry = await beginTrace(ctx, node, path, input)
  if (exhausted) {
    const result = failureResult(node, path, 'fuel 已耗尽')
    entry.status = 'failed'
    entry.error = result.error
    entry.finished_at = new Date().toISOString()
    await persist(ctx)
    return result
  }

  let result
  try {
    result = await executeNodeBody(ctx, node, input, path)
  } catch (error) {
    result = failureResult(node, path, error && error.message ? error.message : error)
  }
  // 输入/输出/错误落盘，供面板与 agent 审计
  const written = writeNodeArtifacts(ctx, node, path, input, result)
  if (written) entry.artifact_dir = written

  if (result.kind === 'waiting') {
    entry.status = 'waiting_human'
    entry.prompt = result.pending.prompt
    entry.waiting_node = result.pending.node_id
    await persist(ctx)
    return result
  }
  entry.finished_at = new Date().toISOString()
  if (result.kind === 'failure') {
    if (!result.error.path) result.error.path = path
    entry.status = 'failed'
    entry.error = result.error
    await persist(ctx)
    return result
  }
  entry.status = 'completed'
  entry.output = clone(result.value)
  if (result.details !== undefined) entry.details = clone(result.details)
  delete entry.waiting_node
  await persist(ctx)
  return result
}

export async function advanceRun(run, options = {}) {
  if (['completed', 'failed', 'cancelled', 'superseded'].includes(run.status)) return run
  if (!['running', 'waiting_human', 'paused'].includes(run.status)) throw new Error(`运行状态不可推进：${run.status}`)
  const wasWaiting = run.status === 'waiting_human'
  const wasPaused = run.status === 'paused'
  if (wasWaiting && (!options.resume || !run.pending)) throw new Error('等待人工输入的运行必须提供 resume')

  const resume = options.resume && run.pending && (wasWaiting || wasPaused)
    ? {
      path: run.pending.path,
      value: clone(options.resume.value),
      failed: Boolean(options.resume.failed),
      error: options.resume.error || null,
      subflow_run_id: options.resume.subflow_run_id || null,
    }
    : null
  run.status = 'running'
  run.pending = null
  run.paused_from = null
  run.error = null
  run.output = null
  run.completed_at = null

  const ctx = {
    run,
    workspace: options.workspace || null,
    artifactsDir: options.artifactsDir || run.artifacts_dir || null,
    ioMode: run.io_mode || 'files',
    llm: options.llm,
    agent: options.agent,
    tool: options.tool,
    subflow: options.subflow || null,
    onChange: options.onChange,
    resume,
    resumeConsumed: false,
    cache: new Map(),
    entries: new Map(),
  }
  for (const entry of options.cache || []) {
    if (entry.status === 'completed') ctx.cache.set(entry.path, entry)
  }
  for (const entry of run.trace) {
    ctx.entries.set(entry.path, entry)
    if (entry.status === 'completed') ctx.cache.set(entry.path, entry)
  }
  await persist(ctx)

  const entryNode = run.definition.entry
  const result = await executeNode(ctx, entryNode, run.input, `/${entryNode.id}`)
  if (resume && !ctx.resumeConsumed && result.kind !== 'failure') {
    run.status = 'failed'
    run.error = {
      node_id: run.pending?.node_id || null,
      path: resume.path,
      message: '恢复路径未到达；流程可能已发生漂移，未注入本次人工输入',
    }
  } else if (result.kind === 'waiting') {
    run.status = 'waiting_human'
    run.pending = result.pending
    run.current = { ...result.pending }
  } else if (result.kind === 'failure') {
    run.status = 'failed'
    run.error = result.error
    run.current = {
      node_id: result.error.node_id,
      label: result.error.label,
      path: result.error.path,
      kind: 'failure',
    }
  } else {
    run.status = 'completed'
    run.output = clone(result.value)
    run.current = null
    run.completed_at = new Date().toISOString()
  }
  await persist(ctx)
  return run
}
