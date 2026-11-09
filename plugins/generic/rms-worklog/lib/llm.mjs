/**
 * 零依赖 LLM 传输层，支持两种协议：
 *   - anthropic：DeepSeek Messages（dsh 默认使用），POST <root>/v1/messages，x-api-key；
 *   - openai：OpenAI 兼容，POST <root>/chat/completions，Bearer。
 *
 * 目标：把日志检索与推理收在插件内部，调用方会话只拿蒸馏后的结论，
 * 从而让「日志管理员」的上下文与其它会话隔离，也便于后续替换成自训小模型。
 *
 * @module rms-worklog/llm
 */

function authHeaders(apiKey, protocol) {
  const out = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (protocol === 'anthropic') {
    if (apiKey) out['x-api-key'] = apiKey
    out['anthropic-version'] = '2023-06-01'
  } else if (apiKey) {
    out.Authorization = `Bearer ${apiKey}`
  }
  return out
}

async function pickOpenAiModel({ baseUrl, apiKey, timeoutMs }) {
  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: authHeaders(apiKey, 'openai'),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 15000)),
  })
  if (!res.ok) throw new Error(`LLM /models ${res.status}：${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const first = Array.isArray(data && data.data) ? data.data[0] : null
  const id = first && (first.id || first.name)
  if (!id) throw new Error('LLM /models 没有可用模型，请在配置里填写 llm_model')
  return String(id)
}

async function callAnthropic(options) {
  const { baseUrl, apiKey, model, messages, timeoutMs, temperature, maxTokens } = options
  if (!apiKey) throw new Error('Anthropic 协议缺少 API Key：配置 llm_api_key 或设置 DEEPSEEK_API_KEY')
  const root = baseUrl.replace(/\/+$/, '')
  const url = /\/v1$/.test(root) ? `${root}/messages` : `${root}/v1/messages`
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => String(m.content || ''))
    .join('\n\n')
  const turns = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: turns,
    ...(system ? { system } : {}),
  }

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey, 'anthropic'),
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? `超时（${timeoutMs}ms）` : String(err && err.message)
    throw new Error(`LLM 连接失败：${reason}`)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`LLM ${res.status}：${text.slice(0, 300)}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`LLM 返回非 JSON：${text.slice(0, 200)}`)
  }
  const blocks = Array.isArray(data && data.content) ? data.content : []
  const content = blocks
    .filter(block => block && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (!content) throw new Error('LLM 返回空内容')
  return { content, model, usage: data.usage || null }
}

async function callOpenAi(options) {
  const { baseUrl, apiKey, messages, timeoutMs, temperature, maxTokens } = options
  let model = options.model
  if (!model) model = await pickOpenAiModel({ baseUrl, apiKey, timeoutMs })
  const url = `${baseUrl}/chat/completions`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey, 'openai'),
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? `超时（${timeoutMs}ms）` : String(err && err.message)
    throw new Error(`LLM 连接失败：${reason}`)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`LLM ${res.status}：${text.slice(0, 300)}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`LLM 返回非 JSON：${text.slice(0, 200)}`)
  }
  const content = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('LLM 返回空内容')
  return { content: content.trim(), model, usage: data.usage || null }
}

/**
 * 调用 LLM。
 * @param {{protocol?:'anthropic'|'openai', baseUrl:string, apiKey?:string, model?:string,
 *          messages:Array, timeoutMs?:number, temperature?:number, maxTokens?:number}} options
 * @returns {Promise<{content:string, model:string, usage:object|null}>}
 */
export async function chat(options) {
  const baseUrl = String(options.baseUrl || '').trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('未配置 llm_base_url')
  const protocol = options.protocol === 'anthropic' ? 'anthropic' : 'openai'
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 60000, 5000), 600000)
  const model = String(options.model || '').trim()
  if (protocol === 'anthropic' && !model) {
    throw new Error('Anthropic 协议必须配置 llm_model（例如 deepseek-flash）')
  }
  const prepared = {
    baseUrl,
    apiKey: String(options.apiKey || '').trim(),
    model,
    messages: options.messages,
    timeoutMs,
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? 1500,
  }
  return protocol === 'anthropic' ? callAnthropic(prepared) : callOpenAi(prepared)
}
