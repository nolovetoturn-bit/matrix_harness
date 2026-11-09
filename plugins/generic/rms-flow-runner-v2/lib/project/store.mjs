import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { loadAll, listMatrices, matrixWorkDir, saveMatrix } from '../matrix/store.mjs'
import { assertProjectId, createProjectRecord, newProjectId } from './schema.mjs'

const PROJECT_FILE = /^project-(pj_[A-Za-z0-9_-]+)\.json$/

const now = () => new Date().toISOString()

const ensureDir = path => {
  mkdirSync(path, { recursive: true })
  return path
}

const projectFile = (dataDir, id) => {
  assertProjectId(id)
  return join(dataDir, `project-${id}.json`)
}

export function projectWorkDir(dataDir, id) {
  assertProjectId(id)
  return join(dataDir, 'projects', id, 'work')
}

/** 项目持久化数据目录（persist 节点），随项目 Git 快照版本化。 */
export function projectDataDir(dataDir, id) {
  assertProjectId(id)
  return join(dataDir, 'projects', id, 'data')
}

function atomicWrite(file, value) {
  ensureDir(join(file, '..'))
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return value
}

export function saveProject(dataDir, project) {
  project.updated_at = now()
  return atomicWrite(projectFile(dataDir, project.id), project)
}

export function loadProject(dataDir, id) {
  const file = projectFile(dataDir, id)
  if (!existsSync(file)) throw new Error(`项目不存在：${id}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export const projectExists = (dataDir, id) => existsSync(projectFile(dataDir, id))

export function listProjects(dataDir) {
  if (!existsSync(dataDir)) return []
  const rows = []
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !PROJECT_FILE.test(entry.name)) continue
    try {
      rows.push(JSON.parse(readFileSync(join(dataDir, entry.name), 'utf8')))
    } catch {}
  }
  return rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function withFileLock(dataDir, key, label, operation) {
  const lockDir = ensureDir(join(dataDir, '.locks'))
  const lockFile = join(lockDir, `${key}.lock`)
  const deadline = Date.now() + Number(process.env.RMS_MATRIX_LOCK_WAIT_MS || 5000)
  let acquired = false
  while (!acquired) {
    try {
      const fd = openSync(lockFile, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: now() }), 'utf8')
      closeSync(fd)
      acquired = true
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      let stale = false
      try {
        stale = !processAlive(Number(JSON.parse(readFileSync(lockFile, 'utf8')).pid))
      } catch {}
      if (stale) {
        try { unlinkSync(lockFile) } catch {}
        continue
      }
      if (Date.now() >= deadline) throw new Error(`${label} 正在另一个进程中推进，请稍后重试`)
      await sleep(25)
    }
  }
  try {
    return await operation()
  } finally {
    if (existsSync(lockFile)) unlinkSync(lockFile)
  }
}

export function withProjectLock(dataDir, projectId, operation) {
  assertProjectId(projectId)
  return withFileLock(dataDir, `project-${projectId}`, `项目 ${projectId}`, operation)
}

export async function updateProject(dataDir, projectId, mutator) {
  return withProjectLock(dataDir, projectId, async () => {
    const project = loadProject(dataDir, projectId)
    const result = await mutator(project)
    saveProject(dataDir, project)
    return result === undefined ? project : result
  })
}

/** 子树 id：根自身 + 所有后代（children 引用与 parent_id 两条线索都覆盖）。 */
function subtreeOf(dataDir, rootId) {
  const matrices = loadAll(dataDir)
  const ids = []
  const seen = new Set()
  const visit = id => {
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
    const matrix = matrices.get(id)
    for (const ref of (matrix && matrix.children) || []) visit(ref.matrix_id)
    for (const item of matrices.values()) {
      if (item.parent_id === id) visit(item.id)
    }
  }
  visit(rootId)
  return ids
}

function bindSubtree(dataDir, rootId, projectId) {
  const matrices = loadAll(dataDir)
  for (const id of subtreeOf(dataDir, rootId)) {
    const matrix = matrices.get(id)
    if (!matrix || matrix.project_id === projectId) continue
    matrix.project_id = projectId
    saveMatrix(dataDir, matrix)
  }
}

/** 迁移/移动后把整棵子树回填到目标项目。 */
export function bindSubtreeToProject(dataDir, rootId, projectId) {
  bindSubtree(dataDir, rootId, projectId)
}

/** 项目操作日志：只留可追踪字段，按时间累积，最多 500 条。 */
export function appendProjectOperation(project, {
  action,
  target_type = 'project',
  target_id = null,
  target_name = null,
  detail = null,
  ok = true,
  error = null,
  source = 'panel',
} = {}) {
  if (!Array.isArray(project.oplog)) project.oplog = []
  project.oplog_seq = (project.oplog_seq || 0) + 1
  const entry = {
    id: `op-${project.oplog_seq}`,
    seq: project.oplog_seq,
    at: now(),
    action: String(action || 'unknown'),
    target_type,
    target_id,
    target_name,
    ok: ok !== false,
    error: error || null,
    source,
    ...(detail && typeof detail === 'object' ? { detail } : {}),
  }
  project.oplog = [...project.oplog, entry].slice(-500)
  return entry
}

/** 独立写项目操作日志（不占用已有项目锁时使用）。 */
export async function logProjectOperation(dataDir, projectId, entry) {
  if (!projectId) return null
  try {
    return await updateProject(dataDir, projectId, project => appendProjectOperation(project, entry))
  } catch {
    return null
  }
}

/** 迁移：历史根 matrix 各自成为一个同名项目，子树回填 project_id。
 * 幂等；已绑定项目的根只补齐项目文件与 root_matrix_ids。
 */
export function ensureProjectsMigrated(dataDir) {
  const matrices = listMatrices(dataDir)
  // 老项目补齐 domain_ids 等新字段
  for (const project of listProjects(dataDir)) {
    if (!Array.isArray(project.domain_ids)) {
      project.domain_ids = []
      saveProject(dataDir, project)
    }
  }
  const created = []
  for (const matrix of matrices) {
    if (matrix.parent_id) continue
    if (matrix.project_id && projectExists(dataDir, matrix.project_id)) {
      const project = loadProject(dataDir, matrix.project_id)
      if (!project.root_matrix_ids.includes(matrix.id)) {
        project.root_matrix_ids = [...project.root_matrix_ids, matrix.id]
        saveProject(dataDir, project)
      }
      bindSubtree(dataDir, matrix.id, project.id)
      continue
    }
    const project = createProjectRecord({
      id: matrix.project_id || newProjectId(),
      name: matrix.name,
      brief: matrix.task,
      cwd: matrixWorkDir(dataDir, matrix.id),
    })
    project.root_matrix_ids = [matrix.id]
    saveProject(dataDir, project)
    bindSubtree(dataDir, matrix.id, project.id)
    created.push(project.id)
  }
  return created
}

/** 新建根 matrix 时挂到一个项目（不存在则按 matrix 名称建新项目）。 */
export function attachRootMatrix(dataDir, matrix, projectId = null) {
  if (projectId) {
    assertProjectId(projectId)
    if (!projectExists(dataDir, projectId)) throw new Error(`项目不存在：${projectId}`)
    const project = loadProject(dataDir, projectId)
    if (!project.root_matrix_ids.includes(matrix.id)) {
      project.root_matrix_ids = [...project.root_matrix_ids, matrix.id]
      saveProject(dataDir, project)
    }
    matrix.project_id = project.id
    saveMatrix(dataDir, matrix)
    return project
  }
  const project = createProjectRecord({
    name: matrix.name,
    brief: matrix.task,
  })
  project.cwd = projectWorkDir(dataDir, project.id)
  project.root_matrix_ids = [matrix.id]
  saveProject(dataDir, project)
  matrix.project_id = project.id
  saveMatrix(dataDir, matrix)
  return project
}

/** 把已有根 matrix 挂进项目（面板/工具复用）。 */
export function attachExistingRoot(dataDir, projectId, matrixId) {
  const project = loadProject(dataDir, projectId)
  if (!project.root_matrix_ids.includes(matrixId)) {
    project.root_matrix_ids = [...project.root_matrix_ids, matrixId]
    saveProject(dataDir, project)
  }
  bindSubtree(dataDir, matrixId, projectId)
  return project
}

export function removeRootFromProject(dataDir, projectId, matrixId) {
  const project = loadProject(dataDir, projectId)
  project.root_matrix_ids = project.root_matrix_ids.filter(id => id !== matrixId)
  saveProject(dataDir, project)
  return project
}

/** 项目工作目录：所有根 matrix 会话在 dsh 侧栏归到同一组，执行 cwd 仍是各自 work。 */
export function ensureProjectCwd(dataDir, project) {
  if (project.cwd) return project.cwd
  project.cwd = projectWorkDir(dataDir, project.id)
  return project.cwd
}
