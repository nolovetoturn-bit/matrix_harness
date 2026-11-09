import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readDshCredential(name) {
  const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(file)) return null
  let inRefs = false
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(raw)) {
      inRefs = true
      continue
    }
    if (inRefs && /^\S/.test(raw)) break
    if (!inRefs) continue
    const match = raw.match(new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`))
    if (!match) continue
    const value = match[1].replace(/^["']|["']$/g, '')
    if (value.startsWith('env:')) return process.env[value.slice(4)] || null
    if (value.startsWith('file:')) {
      const path = value.slice(5)
      return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null
    }
    return value || null
  }
  return null
}

function resolveConfig() {
  const env = process.env
  const explicitBase = String(env.RMS_FLOW_LLM_BASE_URL || '').trim().replace(/\/+$/, '')
  const dshKey = readDshCredential('DEEPSEEK_API_KEY')
  const apiKey = String(env.RMS_FLOW_LLM_API_KEY || env.DEEPSEEK_API_KEY || dshKey || '').trim()
  const baseUrl = explicitBase || (apiKey ? 'https://api.deepseek.com/anthropic' : 'http://127.0.0.1:11434/v1')
  const protocol = String(env.RMS_FLOW_LLM_PROTOCOL || '').trim().toLowerCase()
    || (/\/anthropic(\/|$)/i.test(baseUrl) ? 'anthropic' : 'openai')
  const model = String(env.RMS_FLOW_LLM_MODEL || (/deepseek\.com/i.test(baseUrl) ? 'deepseek-flash' : '')).trim()
  const timeoutMs = Math.min(Math.max(Number(env.RMS_FLOW_LLM_TIMEOUT_MS) || 120000, 5000), 600000)
  const maxTokens = Math.min(Math.max(Number(env.RMS_FLOW_LLM_MAX_TOKENS) || 16000, 256), 32000)
  return { baseUrl, apiKey, protocol, model, timeoutMs, maxTokens }
}

function headers(config) {
  const result = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (config.protocol === 'anthropic') {
    if (config.apiKey) result['x-api-key'] = config.apiKey
    result['anthropic-version'] = '2023-06-01'
  } else if (config.apiKey) {
    result.Authorization = `Bearer ${config.apiKey}`
  }
  return result
}

async function request(config, url, options = {}) {
  let response
  try {
    response = await fetch(url, {
      ...options,
      headers: headers(config),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    const reason = error && error.name === 'TimeoutError' ? `超时（${config.timeoutMs}ms）` : error.message
    throw new Error(`LLM 连接失败：${reason}`)
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`LLM ${response.status}：${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`LLM 返回非 JSON：${text.slice(0, 200)}`)
  }
}

async function completeOpenAi(config, system, user, overrides = {}) {
  let model = overrides.model || config.model
  if (!model) {
    const models = await request(config, `${config.baseUrl}/models`)
    model = models.data && models.data[0] && (models.data[0].id || models.data[0].name)
    if (!model) throw new Error('LLM /models 没有可用模型；请设置 RMS_FLOW_LLM_MODEL')
  }
  const data = await request(config, `${config.baseUrl}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2,
      max_tokens: overrides.maxTokens || config.maxTokens,
      stream: false,
    }),
  })
  const choice = data.choices && data.choices[0]
  const content = choice && choice.message && choice.message.content
  if (choice && choice.finish_reason === 'length') {
    // 截断残片一律不外泄：抛给上层放大额度重试，避免残缺 JSON 被当成完整结果。
    const error = new Error(`LLM 输出被 max_tokens 截断（finish_reason=length，已产出 ${String(content || '').length} 字符）`)
    error.stopReason = 'max_tokens'
    throw error
  }
  if (typeof content !== 'string' || !content.trim()) throw new Error('LLM 返回空内容')
  return { content: content.trim(), model }
}

async function completeAnthropic(config, system, user, overrides = {}) {
  if (!config.apiKey) throw new Error('Anthropic 协议缺少 API Key；请设置 DEEPSEEK_API_KEY')
  const model = overrides.model || config.model
  if (!model) throw new Error('Anthropic 协议缺少模型；请设置 RMS_FLOW_LLM_MODEL')
  const root = config.baseUrl.replace(/\/+$/, '')
  const url = /\/v1$/.test(root) ? `${root}/messages` : `${root}/v1/messages`
  const data = await request(config, url, {
    method: 'POST',
    body: JSON.stringify({
      model,
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      max_tokens: overrides.maxTokens || config.maxTokens,
    }),
  })
  const blocks = Array.isArray(data.content) ? data.content : []
  const content = blocks
    .filter(block => block && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  const kinds = blocks.map(block => block && block.type).filter(Boolean)
  if (data.stop_reason === 'max_tokens') {
    // 截断残片一律不外泄：抛给上层放大额度重试，避免残缺 JSON 被当成完整结果。
    const error = new Error(`LLM 输出被 max_tokens 截断（blocks=${kinds.join('/') || 'none'}，已产出 ${content.length} 字符）`)
    error.stopReason = 'max_tokens'
    throw error
  }
  if (!content) {
    const error = new Error(`LLM 返回空内容（stop_reason=${data.stop_reason || 'unknown'}，blocks=${kinds.join('/') || 'none'}）`)
    error.stopReason = data.stop_reason
    throw error
  }
  return { content, model: config.model }
}

export function createLlmExecutor() {
  const config = resolveConfig()
  const call = (system, user, overrides) => config.protocol === 'anthropic'
    ? completeAnthropic(config, system, user, overrides)
    : completeOpenAi(config, system, user, overrides)
  return {
    async complete({ system, user, model, maxTokens }) {
      const overrides = {}
      if (model) overrides.model = model
      if (maxTokens) overrides.maxTokens = maxTokens
      const started = Date.now()
      let result
      try {
        result = await call(system, user, overrides)
      } catch (error) {
        // 推理模型可能把 max_tokens 全部消耗在思考块上；截断（含带残片的截断）时放大额度重试一次，残片不会外泄。
        const used = overrides.maxTokens || config.maxTokens
        const bumped = Math.min(used * 2, 32000)
        if (error.stopReason !== 'max_tokens' || bumped <= used) throw error
        console.warn(`[flow-llm] 输出被 max_tokens=${used} 截断，改用 ${bumped} 重试`)
        result = await call(system, user, { ...overrides, maxTokens: bumped })
      }
      if (String(process.env.RMS_FLOW_LLM_LOG || '') === '1') {
        console.log(`[flow-llm] ${result.model} ${Date.now() - started}ms prompt_chars=${String(user || '').length}`)
      }
      return result
    },
  }
}
