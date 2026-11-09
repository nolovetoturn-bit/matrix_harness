const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => value === undefined ? null : structuredClone(value)

const NODE_TYPES = new Set(['det', 'llm', 'human', 'agent', 'tool', 'script', 'http', 'subflow', 'sequence', 'branch', 'fold', 'loop', 'or_else'])
const SCRIPT_RUNTIMES = new Set(['bash', 'sh', 'powershell', 'pwsh', 'node', 'ts', 'python', 'python3'])
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const INPUT_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'json', 'array', 'object'])
const INPUT_JUDGES = new Set(['deterministic', 'llm'])
const OUTPUT_LIMIT = 10 * 1024 * 1024
const execTimeout = () => Number(process.env.RMS_FLOW_EXEC_TIMEOUT_MS || 120000)

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
    const sources = ['definition', 'ref', 'build'].filter(key => node[key] !== undefined)
    if (sources.length > 1) {
      throw new Error(`${path} 的 definition/ref/build 只能三选一`)
    }
    if (sources.length === 0) {
      throw new Error(`${path} 需要 definition、ref 或 build`)
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

function scriptExtension(runtime) {
  if (runtime === 'python' || runtime === 'python3') return 'py'
  if (runtime === 'node') return 'mjs'
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

async function executeScript(node, input, ctx) {
  const runtime = node.runtime
  const base = ctx.workspace || process.cwd()
  const cwd = node.cwd ? (isAbsolute(node.cwd) ? node.cwd : resolve(base, node.cwd)) : base
  const dir = await mkdtemp(join(tmpdir(), 'rms-flow-script-'))
  const file = join(dir, `main.${scriptExtension(runtime)}`)
  try {
    await writeFile(file, node.code, 'utf8')
    const { command, args } = runtimeCommand(runtime, file)
    const started = Date.now()
    const result = await runProcess({
      command,
      args: [...args, ...(node.args || [])],
      cwd,
      env: node.env,
      timeoutMs: node.timeout_ms || execTimeout(),
      stdin: JSON.stringify(input ?? null),
    })
    const text = result.stdout.trim()
    if (!text) throw new Error(`${runtime} 脚本没有输出内容`)
    const output = node.output === 'text' ? result.stdout : parseJson(text)
    return valueResult(output, { runtime, cwd, exit_code: result.code, duration_ms: Date.now() - started })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
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
  if (node.type === 'script') return executeScript(node, input, ctx)
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
