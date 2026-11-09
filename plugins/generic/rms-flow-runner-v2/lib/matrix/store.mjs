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
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { archiveEntry } from './messages.mjs'

const MATRIX_FILE = /^matrix-(mx_[A-Za-z0-9_-]+)\.json$/
const RUN_FILE = /^run-([A-Za-z0-9_-]+)\.json$/

export function resolveDataDir(value) {
  const configured = String(value || process.env.RMS_MATRIX_DATA_DIR || '').trim()
  if (configured) return resolve(configured)
  const base = process.env.LOCALAPPDATA || homedir()
  return join(base, 'rms-flow-runner', 'matrix')
}

const now = () => new Date().toISOString()

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

function assertMatrixId(id) {
  if (!/^mx_[A-Za-z0-9_-]{4,40}$/.test(String(id || ''))) throw new Error(`matrix_id 格式不正确：${id}`)
}

function assertRunId(id) {
  if (!/^run-[A-Za-z0-9_-]{4,40}$/.test(String(id || ''))) throw new Error(`run_id 格式不正确：${id}`)
}

const matrixFile = (dataDir, id) => {
  assertMatrixId(id)
  return join(dataDir, `matrix-${id}.json`)
}
const runFile = (dataDir, id) => {
  assertRunId(id)
  return join(dataDir, 'runs', `${id}.json`)
}

export function matrixWorkDir(dataDir, id) {
  assertMatrixId(id)
  return join(dataDir, id, 'work')
}

export function nodeDir(workDir, nodePath) {
  const safe = String(nodePath || 'entry').replace(/^entry\/?/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || 'root'
  return join(workDir, '.nodes', safe)
}

function atomicWrite(file, value) {
  ensureDir(join(file, '..'))
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return value
}

export function saveMatrix(dataDir, matrix) {
  const file = matrixFile(dataDir, matrix.id)
  // 状态变化统一进归档，避免每个动作各自记一份
  let previousState = null
  if (existsSync(file)) {
    try {
      previousState = JSON.parse(readFileSync(file, 'utf8')).state || null
    } catch {}
  }
  if (previousState && previousState !== matrix.state) {
    archiveEntry(matrix, {
      type: 'state',
      source: 'matrix',
      text: `${previousState} → ${matrix.state}`,
      data: { from: previousState, to: matrix.state },
    })
  }
  matrix.updated_at = now()
  return atomicWrite(file, matrix)
}

export function loadMatrix(dataDir, id) {
  const file = matrixFile(dataDir, id)
  if (!existsSync(file)) throw new Error(`matrix 不存在：${id}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export const matrixExists = (dataDir, id) => existsSync(matrixFile(dataDir, id))

export function listMatrices(dataDir) {
  if (!existsSync(dataDir)) return []
  const result = []
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    const match = entry.isFile() && entry.name.match(MATRIX_FILE)
    if (!match) continue
    try {
      result.push(JSON.parse(readFileSync(join(dataDir, entry.name), 'utf8')))
    } catch {}
  }
  return result.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

export function loadAll(dataDir) {
  return new Map(listMatrices(dataDir).map(matrix => [matrix.id, matrix]))
}

export function saveRun(dataDir, run) {
  run.updated_at = now()
  return atomicWrite(runFile(dataDir, run.id), run)
}

export function loadRun(dataDir, id) {
  const file = runFile(dataDir, id)
  if (!existsSync(file)) throw new Error(`运行不存在：${id}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function listRuns(dataDir, matrixId) {
  const dir = join(dataDir, 'runs')
  if (!existsSync(dir)) return []
  const runs = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !RUN_FILE.test(entry.name)) continue
    try {
      const run = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'))
      if (matrixId && run.matrix_id !== matrixId) continue
      runs.push(run)
    } catch {}
  }
  return runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
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

/**
 * 文件锁：拿不到时短暂等待而不是立刻报错。
 * 面板“动作归档”与后台预构建会同时抢同一把锁，立即失败会把预构建异常吞掉。
 */
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

export function withMatrixLock(dataDir, matrixId, operation) {
  assertMatrixId(matrixId)
  return withFileLock(dataDir, `matrix-${matrixId}`, `matrix ${matrixId}`, operation)
}

/**
 * 加锁读取 → 修改 → 落盘。mutator 返回值会原样返回，异常时不会写入。
 */
export async function updateMatrix(dataDir, matrixId, mutator) {
  return withMatrixLock(dataDir, matrixId, async () => {
    const matrix = loadMatrix(dataDir, matrixId)
    const result = await mutator(matrix)
    saveMatrix(dataDir, matrix)
    return result === undefined ? matrix : result
  })
}

/**
 * 子验收后自底向上重算父链。幂等：只有状态真正变化才落盘。
 * @returns {string[]} 被升级为 runnable 的 matrix id
 */
export function recomputeAncestors(dataDir, matrixId, recompute) {
  const matrices = loadAll(dataDir)
  const upgraded = []
  const guard = new Set()
  let cursor = matrices.get(matrixId)
  while (cursor && cursor.parent_id && !guard.has(cursor.parent_id)) {
    guard.add(cursor.parent_id)
    const parent = matrices.get(cursor.parent_id)
    if (!parent) break
    if (recompute(parent, matrices)) {
      saveMatrix(dataDir, parent)
      upgraded.push(parent.id)
    }
    cursor = parent
  }
  return upgraded
}
