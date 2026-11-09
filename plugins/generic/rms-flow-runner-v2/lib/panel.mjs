import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import {
  accept,
  answer,
  answerTicket,
  answerUserQuestion,
  cancelUserQuestion,
  cancel,
  cancelTicket,
  chat,
  confirmDagAction,
  ensureSession,
  evaluate,
  generateDag,
  get,
  intake,
  kickoff,
  mail,
  nav,
  prebuild,
  recordAction,
  reopenDag,
  retry,
  revise,
  rewindPoints,
  rewindSession,
  resume,
  run,
  runArtifacts,
  runDetail,
  runs,
  setExecutionMode,
  submitInput,
  supervise,
  tickets,
  tree,
  list,
} from './matrix/service.mjs'
import { resolveDataDir } from './matrix/store.mjs'
import {
  archiveMatrix,
  moveMatrix,
  projectArchive,
  projectChat,
  projectCreate,
  projectGet,
  projectGit,
  projectList,
  projectMemory,
  projectOpen,
  projectRunRunnable,
  projectSummary,
  projectTree,
  projectUpdate,
} from './project/service.mjs'
import { bridgeError, isLoopbackRequest } from './engine/bridge.mjs'
import {
  domainArchive,
  domainBindMatrix,
  domainChat,
  domainCreate,
  domainElementRemove,
  domainElementUpsert,
  domainExportCreate,
  domainExportList,
  domainGet,
  domainImportApply,
  domainImportList,
  domainImportRemove,
  domainImportUpgrade,
  domainList,
  domainMatrixIntake,
  domainMemory,
  domainSummary,
  domainUpdate,
} from './domain/service.mjs'
import { listExports } from './domain/registry.mjs'

const MATRIX_ID = 'mx_[A-Za-z0-9_-]+'
const PROJECT_ID = 'pj_[A-Za-z0-9_-]+'
const DOMAIN_ID = 'dom_[A-Za-z0-9_-]+'
const RUN_ID = 'run-[A-Za-z0-9_-]+'

function sendJson(response, status, value) {
  const body = JSON.stringify(value, null, 2)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const ACTIONS = {
  answer,
  revise,
  chat,
  kickoff,
  'generate-dag': generateDag,
  'confirm-dag': confirmDagAction,
  prebuild,
  'reopen-dag': reopenDag,
  retry,
  rewind: rewindSession,
  accept,
  run,
  evaluate,
  cancel,
  input: submitInput,
  session: ensureSession,
  resume,
  supervise,
  'run-mode': setExecutionMode,
  move: moveMatrix,
  archive: archiveMatrix,
}

const PROJECT_ACTIONS = {
  update: projectUpdate,
  archive: projectArchive,
  open: projectOpen,
  chat: projectChat,
  memory: projectMemory,
  'run-runnable': projectRunRunnable,
}

const DOMAIN_ACTIONS = {
  update: domainUpdate,
  archive: domainArchive,
  chat: domainChat,
  memory: domainMemory,
  upsert: domainElementUpsert,
  remove: domainElementRemove,
  'matrix-intake': domainMatrixIntake,
  'bind-matrix': domainBindMatrix,
  'export-create': domainExportCreate,
  'export-list': domainExportList,
  'import-apply': domainImportApply,
  'import-list': domainImportList,
  'import-remove': domainImportRemove,
  'import-upgrade': domainImportUpgrade,
}

// 这些动作自己会写归档（chat / kickoff / move / archive 由 service 写），面板层不再重复记录
const SELF_ARCHIVED = new Set(['chat', 'kickoff', 'rewind', 'move', 'archive'])

function handler(dataDir, html, dependencies = {}, prefix = '') {
  const base = prefix ? prefix.replace(/\/$/, '') : ''
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (base) {
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
      const bridgeMatch = url.pathname.match(new RegExp(`^/api/runs/(${RUN_ID})/bridge/(llm|agent|tool|subflow)$`))
      if (bridgeMatch && request.method === 'POST') {
        if (!isLoopbackRequest(request)) {
          sendJson(response, 403, bridgeError('BRIDGE_FORBIDDEN', 'bridge 只允许本机请求'))
          return
        }
        if (typeof dependencies.runBridge !== 'function') {
          sendJson(response, 503, bridgeError('BRIDGE_UNAVAILABLE', '宿主未注入 runBridge'))
          return
        }
        let body
        try {
          body = await readJson(request)
        } catch (error) {
          sendJson(response, 400, bridgeError('BRIDGE_BAD_REQUEST', error && error.message ? error.message : String(error)))
          return
        }
        let result
        try {
          result = await dependencies.runBridge({
            data_dir: dataDir,
            run_id: bridgeMatch[1],
            kind: bridgeMatch[2],
            token: String(request.headers['x-rms-run-token'] || ''),
            body,
          })
        } catch (error) {
          result = bridgeError(error && error.code ? error.code : 'BRIDGE_FAILED', error && error.message ? error.message : String(error))
        }
        const code = result && result.error && result.error.code
        const status = code === 'BRIDGE_UNAUTHORIZED'
          ? 401
          : code === 'BRIDGE_FORBIDDEN'
            ? 403
            : code === 'BRIDGE_UNAVAILABLE'
              ? 503
              : code
                ? 400
                : 200
        sendJson(response, status, result)
        return
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
        })
        response.end(html)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { service: 'rms-flow-runner-v2', ok: true, data_dir: dataDir })
        return
      }
      if (url.pathname === '/api/projects' && request.method === 'GET') {
        sendJson(response, 200, projectList({
          data_dir: dataDir,
          include_archived: url.searchParams.get('include_archived') === 'true',
        }))
        return
      }
      if (url.pathname === '/api/projects' && request.method === 'POST') {
        sendJson(response, 200, await projectCreate({ ...(await readJson(request)), data_dir: dataDir }, dependencies))
        return
      }
      const projectTreeMatch = url.pathname.match(new RegExp(`^/api/projects/(${PROJECT_ID})/tree$`))
      if (projectTreeMatch && request.method === 'GET') {
        sendJson(response, 200, projectTree({ data_dir: dataDir, project_id: projectTreeMatch[1] }, { sessionId: null }))
        return
      }
      const projectSummaryMatch = url.pathname.match(new RegExp(`^/api/projects/(${PROJECT_ID})/summary$`))
      if (projectSummaryMatch && request.method === 'GET') {
        sendJson(response, 200, projectSummary({ data_dir: dataDir, project_id: projectSummaryMatch[1] }, { sessionId: null }))
        return
      }
      const projectGitMatch = url.pathname.match(new RegExp(`^/api/projects/(${PROJECT_ID})/git$`))
      if (projectGitMatch && request.method === 'GET') {
        sendJson(response, 200, await projectGit({
          data_dir: dataDir,
          project_id: projectGitMatch[1],
          action: 'status',
        }, dependencies, { sessionId: null }))
        return
      }
      if (projectGitMatch && request.method === 'POST') {
        const body = await readJson(request)
        sendJson(response, 200, await projectGit({
          ...body,
          data_dir: dataDir,
          project_id: projectGitMatch[1],
        }, dependencies, { sessionId: null }))
        return
      }
      const projectDomainsMatch = url.pathname.match(new RegExp(`^/api/projects/(${PROJECT_ID})/domains$`))
      if (projectDomainsMatch && request.method === 'GET') {
        sendJson(response, 200, domainList({
          data_dir: dataDir,
          project_id: projectDomainsMatch[1],
          include_archived: url.searchParams.get('include_archived') === 'true',
        }, { sessionId: null }))
        return
      }
      if (projectDomainsMatch && request.method === 'POST') {
        sendJson(response, 200, await domainCreate({
          ...(await readJson(request)),
          data_dir: dataDir,
          project_id: projectDomainsMatch[1],
        }, dependencies, { sessionId: null }))
        return
      }
      const domainSummaryMatch = url.pathname.match(new RegExp(`^/api/domains/(${DOMAIN_ID})/summary$`))
      if (domainSummaryMatch && request.method === 'GET') {
        sendJson(response, 200, domainSummary({ data_dir: dataDir, domain_id: domainSummaryMatch[1] }, { sessionId: null }))
        return
      }
      const domainActionMatch = url.pathname.match(new RegExp(`^/api/domains/(${DOMAIN_ID})/([a-z-]+)$`))
      if (domainActionMatch && request.method === 'POST') {
        const name = domainActionMatch[2]
        const fn = DOMAIN_ACTIONS[name]
        if (!fn) {
          sendJson(response, 404, { error: `未知领域动作：${name}` })
          return
        }
        const body = await readJson(request)
        sendJson(response, 200, await fn({
          ...body,
          data_dir: dataDir,
          domain_id: domainActionMatch[1],
        }, dependencies, { sessionId: null }))
        return
      }
      const domainDetailMatch = url.pathname.match(new RegExp(`^/api/domains/(${DOMAIN_ID})$`))
      if (domainDetailMatch && request.method === 'GET') {
        sendJson(response, 200, await domainGet({
          data_dir: dataDir,
          domain_id: domainDetailMatch[1],
        }, dependencies, { sessionId: null }))
        return
      }
      if (url.pathname === '/api/registry/exports' && request.method === 'GET') {
        sendJson(response, 200, {
          exports: listExports(dataDir, { query: url.searchParams.get('q') || '', limit: 50 }),
        })
        return
      }
      const projectActionMatch = url.pathname.match(new RegExp(`^/api/projects/(${PROJECT_ID})/([a-z-]+)$`))
      if (projectActionMatch && request.method === 'POST') {
        const name = projectActionMatch[2]
        const fn = PROJECT_ACTIONS[name]
        if (!fn) {
          sendJson(response, 404, { error: `未知项目动作：${name}` })
          return
        }
        const body = await readJson(request)
        sendJson(response, 200, await fn({ ...body, data_dir: dataDir, project_id: projectActionMatch[1] }, dependencies))
        return
      }
      const projectDetailMatch = url.pathname.match(new RegExp(`^/api/projects/(${PROJECT_ID})$`))
      if (projectDetailMatch && request.method === 'GET') {
        sendJson(response, 200, await projectGet({
          data_dir: dataDir,
          project_id: projectDetailMatch[1],
        }, dependencies, { sessionId: null }))
        return
      }
      if (url.pathname === '/api/matrix/tree' && request.method === 'GET') {
        sendJson(response, 200, tree({
          data_dir: dataDir,
          root_id: url.searchParams.get('root_id') || '',
          project_id: url.searchParams.get('project_id') || '',
        }))
        return
      }
      if (url.pathname === '/api/matrix/list' && request.method === 'GET') {
        sendJson(response, 200, list({ data_dir: dataDir, project_id: url.searchParams.get('project_id') || '' }))
        return
      }
      if (url.pathname === '/api/matrix' && request.method === 'POST') {
        sendJson(response, 200, await intake({ ...(await readJson(request)), data_dir: dataDir }, dependencies))
        return
      }
      const ticketsMatch = url.pathname.match(new RegExp(`^/api/matrix/(${MATRIX_ID})/tickets$`))
      if (ticketsMatch && request.method === 'GET') {
        sendJson(response, 200, tickets({ data_dir: dataDir, matrix_id: ticketsMatch[1] }, dependencies))
        return
      }
      const ticketAnswerMatch = url.pathname.match(/^\/api\/tickets\/(tk_[A-Za-z0-9_-]{4,40})\/answer$/)
      if (ticketAnswerMatch && request.method === 'POST') {
        const body = await readJson(request)
        sendJson(response, 200, await answerTicket({
          ...body, data_dir: dataDir, matrix_id: body.matrix_id, ticket_id: ticketAnswerMatch[1],
        }, dependencies))
        return
      }
      const ticketCancelMatch = url.pathname.match(/^\/api\/tickets\/(tk_[A-Za-z0-9_-]{4,40})\/cancel$/)
      if (ticketCancelMatch && request.method === 'POST') {
        const body = await readJson(request)
        sendJson(response, 200, await cancelTicket({
          ...body, data_dir: dataDir, matrix_id: body.matrix_id, ticket_id: ticketCancelMatch[1],
        }, dependencies))
        return
      }
      const questionAnswerMatch = url.pathname.match(/^\/api\/questions\/(uq_[A-Za-z0-9_-]{4,40})\/answer$/)
      if (questionAnswerMatch && request.method === 'POST') {
        const body = await readJson(request)
        sendJson(response, 200, await answerUserQuestion({
          ...body, data_dir: dataDir, matrix_id: body.matrix_id, question_id: questionAnswerMatch[1],
        }, dependencies))
        return
      }
      const questionCancelMatch = url.pathname.match(/^\/api\/questions\/(uq_[A-Za-z0-9_-]{4,40})\/cancel$/)
      if (questionCancelMatch && request.method === 'POST') {
        const body = await readJson(request)
        sendJson(response, 200, await cancelUserQuestion({
          ...body, data_dir: dataDir, matrix_id: body.matrix_id, question_id: questionCancelMatch[1],
        }, dependencies))
        return
      }
      const mailMatch = url.pathname.match(new RegExp(`^/api/matrix/(${MATRIX_ID})/mail$`))
      if (mailMatch && request.method === 'POST') {
        const body = await readJson(request)
        sendJson(response, 200, await mail({ ...body, data_dir: dataDir, matrix_id: mailMatch[1] }, dependencies))
        return
      }
      const runsMatch = url.pathname.match(new RegExp(`^/api/matrix/(${MATRIX_ID})/runs$`))
      if (runsMatch && request.method === 'GET') {
        sendJson(response, 200, runs({ data_dir: dataDir, matrix_id: runsMatch[1] }))
        return
      }
      const rewindPointsMatch = url.pathname.match(new RegExp(`^/api/matrix/(${MATRIX_ID})/rewind-points$`))
      if (rewindPointsMatch && request.method === 'GET') {
        sendJson(response, 200, await rewindPoints({ data_dir: dataDir, matrix_id: rewindPointsMatch[1] }, dependencies))
        return
      }
      const navMatch = url.pathname.match(new RegExp(`^/api/matrix/(${MATRIX_ID})/nav$`))
      if (navMatch && request.method === 'GET') {
        sendJson(response, 200, nav({ data_dir: dataDir, matrix_id: navMatch[1] }))
        return
      }
      const actionMatch = url.pathname.match(new RegExp(`^/api/matrix/(${MATRIX_ID})/([a-z-]+)$`))
      if (actionMatch && request.method === 'POST') {
        const name = actionMatch[2]
        const fn = ACTIONS[name]
        if (!fn) {
          sendJson(response, 404, { error: `未知动作：${name}` })
          return
        }
        const body = await readJson(request)
        let failure = null
        let result
        try {
          result = await fn({ ...body, data_dir: dataDir, matrix_id: actionMatch[1] }, dependencies)
        } catch (error) {
          failure = error
          throw error
        } finally {
          if (!SELF_ARCHIVED.has(name)) {
            // 确定性按钮动作也进归档，保留“谁在什么状态做了什么”
            await recordAction({
              data_dir: dataDir,
              matrix_id: actionMatch[1],
              action: name,
              args: body,
              ok: !failure,
              error: failure ? (failure.message || String(failure)) : null,
            }).catch(() => {})
          }
        }
        sendJson(response, 200, result)
        return
      }
      const detailMatch = url.pathname.match(new RegExp(`^/api/matrix/(${MATRIX_ID})$`))
      if (detailMatch && request.method === 'GET') {
        sendJson(response, 200, await get({ data_dir: dataDir, matrix_id: detailMatch[1] }, dependencies))
        return
      }
      const artifactMatch = url.pathname.match(new RegExp(`^/api/runs/(${RUN_ID})/artifacts$`))
      if (artifactMatch && request.method === 'GET') {
        sendJson(response, 200, runArtifacts({
          data_dir: dataDir,
          run_id: artifactMatch[1],
          path: url.searchParams.get('path') || '',
        }))
        return
      }
      const runMatch = url.pathname.match(new RegExp(`^/api/runs/(${RUN_ID})$`))
      if (runMatch && request.method === 'GET') {
        sendJson(response, 200, runDetail({ data_dir: dataDir, run_id: runMatch[1] }))
        return
      }
      sendJson(response, 404, { error: 'Not Found' })
    } catch (error) {
      sendJson(response, 400, { error: error && error.message ? error.message : String(error) })
    }
  }
}

/**
 * 挂到 dsh webServer 的常驻路由（不启动独立端口）。
 */
export function createPanelHandler(options = {}) {
  const dataDir = resolveDataDir(options.data_dir)
  const html = readFileSync(new URL('../panel/index.html', import.meta.url))
  return handler(dataDir, html, options.dependencies || {}, options.prefix || '')
}

let activePanel = null
let startingPanel = null

export async function startPanel(args = {}, dependencies = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  if (activePanel) {
    if (activePanel.data_dir !== dataDir) throw new Error(`面板已绑定另一数据目录：${activePanel.data_dir}`)
    return activePanel
  }
  if (startingPanel) return startingPanel
  startingPanel = new Promise((resolvePromise, reject) => {
    const server = createServer(handler(dataDir, readFileSync(new URL('../panel/index.html', import.meta.url)), dependencies, ''))
    server.on('error', reject)
    server.listen(Number(args.port) || 0, '127.0.0.1', () => {
      const { port } = server.address()
      activePanel = {
        url: `http://127.0.0.1:${port}/`,
        data_dir: dataDir,
        port,
        async close() {
          await new Promise(done => server.close(done))
          activePanel = null
        },
      }
      resolvePromise(activePanel)
    })
  }).finally(() => { startingPanel = null })
  return startingPanel
}

export async function stopPanel() {
  if (!activePanel) return
  await activePanel.close()
}
