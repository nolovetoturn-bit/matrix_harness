import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

export const BRIDGE_KINDS = Object.freeze(['llm', 'agent', 'tool', 'subflow'])

const RUN_ID = /^run-[A-Za-z0-9_-]+$/

export function bridgeError(code, message) {
  return { error: { code: String(code || 'BRIDGE_FAILED'), message: String(message || 'bridge 调用失败') } }
}

export function bridgeTokenPath(runDir) {
  return join(runDir, 'state', 'bridge-token')
}

/** 读取 per-run bridge token；缺失时返回空字符串。 */
export function readBridgeToken(runDir) {
  const file = bridgeTokenPath(runDir)
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function tokenEquals(expected, received) {
  const left = Buffer.from(String(expected || ''))
  const right = Buffer.from(String(received || ''))
  if (!left.length || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * bridge 只允许本机来源：loopback，或本机网卡地址（dsh 绑定 LAN IP 时同机请求的 remoteAddress 是网卡 IP）。
 * 远程机器来源会被拒绝；此外每次调用还需 per-run token。
 */
export function isLoopbackRequest(request) {
  const address = String((request && request.socket && request.socket.remoteAddress) || '')
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address
  if (plain === '127.0.0.1' || plain === '::1') return true
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry && entry.address === plain) return true
    }
  }
  return false
}

/**
 * 校验 token 并把 bridge 请求分派给注入的 handlers。
 * handlers 形如 { llm, agent, tool, subflow }，每个是 async (body, context) => result。
 * 所有错误统一返回 { error: { code, message } }。
 */
export async function dispatchBridge({ dataDir, runId, kind, token, body, handlers = {} } = {}) {
  try {
    if (!BRIDGE_KINDS.includes(kind)) {
      return bridgeError('BRIDGE_UNKNOWN_KIND', `不支持的 bridge 类型：${kind}`)
    }
    if (!RUN_ID.test(String(runId || ''))) {
      return bridgeError('BRIDGE_BAD_REQUEST', `run_id 不合法：${runId}`)
    }
    const runDir = join(dataDir, 'runs', runId)
    const expected = readBridgeToken(runDir)
    if (!expected) {
      return bridgeError('BRIDGE_UNAUTHORIZED', `运行 ${runId} 缺少 bridge token`)
    }
    if (!tokenEquals(expected, token)) {
      return bridgeError('BRIDGE_UNAUTHORIZED', 'bridge token 校验失败')
    }
    const handler = handlers && handlers[kind]
    if (typeof handler !== 'function') {
      return bridgeError('BRIDGE_UNAVAILABLE', `宿主未注入 ${kind} bridge handler`)
    }
    return await handler(body || {}, { dataDir, runId, runDir, kind })
  } catch (error) {
    return bridgeError(error && error.code ? error.code : 'BRIDGE_FAILED', error && error.message ? error.message : String(error))
  }
}
