import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import {
  acceptBuild, answerFlow, configureWorkspace, confirmBuildDag, confirmFlow, evaluateFlow, getFlow, getSession, getSessionRuns,
  instructFlow, intakeFlow, invokeFlow, listFlow, listSessionGroups, planFlow, prebuildFlow, resumeFlow, retryBuild, reviseFlow,
  sessionMail, startBuildSession,
} from './service.mjs'
import { resolveDataDir } from './store.mjs'

let activePanel = null
let startingPanel = null

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求体超过 1 MiB')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function handler(dataDir, html, dependencies = {}, prefix = '') {
  const base = prefix ? prefix.replace(/\/$/, '') : ''
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (base) {
        // 挂到宿主路由前缀下：/flow-runner 重定向到 /flow-runner/，其余路径去掉前缀再匹配
        if (url.pathname === base) {
          response.writeHead(302, { Location: `${base}/${url.search}` })
          response.end()
          return
        }
        if (!url.pathname.startsWith(`${base}/`)) {
          sendJson(response, 404, { error: 'Not Found' })
          return
        }
        url.pathname = url.pathname.slice(base.length)
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': html.length,
          'Cache-Control': 'no-store',
        })
        response.end(html)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { service: 'rms-flow-runner', ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(response, 200, listSessionGroups({
          data_dir: dataDir,
          limit: Number(url.searchParams.get('limit')) || 200,
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/sessions') {
        if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
          sendJson(response, 415, { error: '受理请求必须使用 application/json' })
          return
        }
        const body = await readJson(request)
        sendJson(response, 200, await intakeFlow({ ...body, data_dir: dataDir }, dependencies))
        return
      }
      const mailMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/mail$/)
      if (mailMatch && request.method === 'GET') {
        sendJson(response, 200, sessionMail({
          data_dir: dataDir,
          session_id: mailMatch[1],
          limit: Number(url.searchParams.get('limit')) || undefined,
        }))
        return
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/)
      if (sessionMatch && request.method === 'GET') {
        sendJson(response, 200, getSession({ data_dir: dataDir, session_id: sessionMatch[1] }))
        return
      }
      if (sessionMatch && request.method === 'POST'
        && ['answer', 'revise', 'evaluate', 'workspace', 'start-build', 'confirm-dag', 'retry-build', 'accept-build'].includes(url.searchParams.get('action'))) {
        if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
          sendJson(response, 415, { error: '写请求必须使用 application/json' })
          return
        }
        const body = await readJson(request)
        const action = url.searchParams.get('action')
        const common = { data_dir: dataDir, session_id: sessionMatch[1], ...body }
        let result
        if (action === 'answer') result = await answerFlow(common, dependencies)
        else if (action === 'revise') result = await reviseFlow(common, dependencies)
        else if (action === 'workspace') result = await configureWorkspace(common, dependencies)
        else if (action === 'start-build') result = await startBuildSession(common, dependencies)
        else if (action === 'confirm-dag') result = await confirmBuildDag(common, dependencies)
        else if (action === 'retry-build') result = await retryBuild(common, dependencies)
        else if (action === 'accept-build') result = await acceptBuild(common, dependencies)
        else result = await evaluateFlow(common, dependencies)
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/runs') {
        sendJson(response, 200, listFlow({
          data_dir: dataDir,
          parent_session_id: url.searchParams.get('parent_session_id') || '',
          limit: 200,
        }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/session') {
        sendJson(response, 200, getSessionRuns({
          data_dir: dataDir,
          parent_session_id: url.searchParams.get('parent_session_id') || '',
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/plan') {
        if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
          sendJson(response, 415, { error: '规划请求必须使用 application/json' })
          return
        }
        const body = await readJson(request)
        sendJson(response, 200, await planFlow({ ...body, data_dir: dataDir }, dependencies))
        return
      }
      const match = url.pathname.match(/^\/api\/runs\/(flow-[A-Za-z0-9_-]+)$/)
      if (match && request.method === 'GET') {
        sendJson(response, 200, getFlow({ data_dir: dataDir, run_id: match[1] }))
        return
      }
      if (match && request.method === 'POST'
        && ['resume', 'supervise', 'confirm', 'invoke', 'prebuild'].includes(url.searchParams.get('action'))) {
        if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
          sendJson(response, 415, { error: '写请求必须使用 application/json' })
          return
        }
        const body = await readJson(request)
        const action = url.searchParams.get('action')
        let result
        if (action === 'prebuild') {
          result = await prebuildFlow({
            data_dir: dataDir, run_id: match[1], step: body.step !== false,
            // 面板请求后台推进：立即返回，进度由轮询刷新
            background: body.background === true,
          }, dependencies)
        } else if (action === 'resume') {
          const input = Object.prototype.hasOwnProperty.call(body, 'input') ? { input: body.input } : {}
          result = await resumeFlow({ data_dir: dataDir, run_id: match[1], ...input }, dependencies)
        } else if (action === 'supervise') {
          result = await instructFlow({ data_dir: dataDir, run_id: match[1], instruction: body.instruction }, dependencies)
        } else if (action === 'invoke') {
          const input = Object.prototype.hasOwnProperty.call(body, 'input') ? { input: body.input } : {}
          result = await invokeFlow({ data_dir: dataDir, run_id: match[1], ...input }, dependencies)
        } else {
          result = await confirmFlow({
            data_dir: dataDir, run_id: match[1], action_id: body.action_id, approved: body.approved,
          }, dependencies)
        }
        sendJson(response, 200, result)
        return
      }
      sendJson(response, 404, { error: 'Not Found' })
    } catch (error) {
      sendJson(response, 400, { error: error && error.message ? error.message : String(error) })
    }
  }
}

/**
 * 创建可挂到宿主 HTTP 服务上的面板处理器（不改端口、不启动服务）。
 * @param {{data_dir?: string, dependencies?: object, prefix?: string}} options
 */
export function createPanelHandler(options = {}) {
  const dataDir = resolveDataDir(options.data_dir)
  const html = readFileSync(new URL('../panel/index.html', import.meta.url))
  return handler(dataDir, html, options.dependencies || {}, options.prefix || '')
}

export async function startPanel(args = {}, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  if (activePanel) {
    if (activePanel.data_dir !== dataDir) throw new Error(`面板已绑定另一数据目录：${activePanel.data_dir}`)
    return activePanel
  }
  if (startingPanel) return startingPanel

  startingPanel = (async () => {
    const html = readFileSync(new URL('../panel/index.html', import.meta.url))
    const server = createServer(handler(dataDir, html, dependencies))
    const port = args.port ?? (Number(process.env.RMS_FLOW_UI_PORT) || 0)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    const address = server.address()
    const url = `http://127.0.0.1:${address.port}`
    activePanel = { url, data_dir: dataDir, server }
    server.unref()
    server.on('close', () => {
      activePanel = null
      startingPanel = null
    })
    return activePanel
  })()

  try {
    return await startingPanel
  } catch (error) {
    startingPanel = null
    throw error
  }
}

export async function stopPanel() {
  if (!activePanel) return
  const { server } = activePanel
  await new Promise(resolve => server.close(resolve))
  activePanel = null
  startingPanel = null
}
