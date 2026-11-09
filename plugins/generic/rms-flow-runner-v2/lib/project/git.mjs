import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { loadAll, listRuns, matrixWorkDir } from '../matrix/store.mjs'
import { domainWorkDir, loadDomain } from '../domain/store.mjs'
import { domainBrief } from '../domain/session.mjs'
import { exportFile, registryExportDir } from '../domain/registry.mjs'
import { appendProjectOperation, loadProject, projectDataDir, saveProject } from './store.mjs'
import { projectBrief } from './session.mjs'

const execFileAsync = promisify(execFile)
const now = () => new Date().toISOString()

/** 项目仓库根目录：与项目 work 同级，state/ 下保存可回滚的项目状态快照。 */
export function projectRepoDir(dataDir, projectId) {
  return join(dataDir, 'projects', projectId)
}

export function projectGitEnabled(dataDir, projectId) {
  return existsSync(join(projectRepoDir(dataDir, projectId), '.git'))
}

async function git(cwd, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    if (allowFail) return null
    throw new Error(`git ${args.join(' ')} 失败：${String(error && error.stderr ? error.stderr : error && error.message ? error.message : error).trim()}`)
  }
}

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function copyDir(src, dest) {
  await rm(dest, { recursive: true, force: true })
  await cp(src, dest, { recursive: true, force: true })
}

/** 初始化仓库（幂等）。 */
export async function initProjectRepo(dataDir, projectId) {
  const repo = projectRepoDir(dataDir, projectId)
  await mkdir(repo, { recursive: true })
  if (!existsSync(join(repo, '.git'))) {
    await git(repo, ['init', '-b', 'main'])
  }
  return repo
}

/** 收集项目快照：项目元数据、matrix 定义、matrix work、运行记录、dsh 会话事件。 */
async function collectSnapshot(dataDir, project, dependencies = {}) {
  const repo = projectRepoDir(dataDir, project.id)
  const stateDir = join(repo, 'state')
  await rm(stateDir, { recursive: true, force: true })
  await mkdir(join(stateDir, 'matrices'), { recursive: true })
  await mkdir(join(stateDir, 'runs'), { recursive: true })
  await mkdir(join(stateDir, 'sessions'), { recursive: true })
  await mkdir(join(stateDir, 'domains'), { recursive: true })
  await mkdir(join(stateDir, 'exports'), { recursive: true })
  await mkdir(join(stateDir, 'imports'), { recursive: true })

  await writeJson(join(stateDir, 'project.json'), project)
  const matrices = [...loadAll(dataDir).values()].filter(matrix => matrix.project_id === project.id)
  const domains = (project.domain_ids || [])
    .map(id => {
      try { return loadDomain(dataDir, id) } catch { return null }
    })
    .filter(Boolean)
  for (const domain of domains) {
    await writeJson(join(stateDir, 'domains', `${domain.id}.json`), domain)
    const work = domainWorkDir(dataDir, domain)
    if (existsSync(work)) {
      await cp(work, join(stateDir, 'domains', domain.id, 'work'), { recursive: true, force: true })
    }
    // 导出/导入包副本：registry 是全局资源，项目快照保留引用副本用于恢复
    for (const item of domain.exports || []) {
      try {
        const file = exportFile(dataDir, item.id)
        if (existsSync(file)) await cp(file, join(stateDir, 'exports', `${item.id}.json`), { force: true })
      } catch {}
    }
    for (const item of domain.imports || []) {
      try {
        const file = exportFile(dataDir, item.export_id)
        if (existsSync(file)) await cp(file, join(stateDir, 'imports', `${item.export_id}.json`), { force: true })
      } catch {}
    }
  }
  const runIds = new Set()
  for (const matrix of matrices) {
    await writeJson(join(stateDir, 'matrices', `${matrix.id}.json`), matrix)
    const work = matrixWorkDir(dataDir, matrix.id)
    if (existsSync(work)) {
      await cp(work, join(stateDir, 'matrices', matrix.id, 'work'), { recursive: true, force: true })
    }
    for (const run of listRuns(dataDir, matrix.id)) runIds.add(run.id)
  }
  for (const runId of runIds) {
    const dir = join(dataDir, 'runs', runId)
    if (existsSync(dir)) await cp(dir, join(stateDir, 'runs', runId), { recursive: true, force: true })
  }

  // persist 数据：<project>/data → state/data，随 checkpoint 一起版本化
  const liveData = projectDataDir(dataDir, project.id)
  if (existsSync(liveData)) {
    await cp(liveData, join(stateDir, 'data'), { recursive: true, force: true })
  }

  // dsh 会话事件快照：项目会话 + 领域会话 + 所有 matrix 会话
  const sessionOwners = new Map()
  if (project.dsh_session_id) sessionOwners.set(project.dsh_session_id, { kind: 'project', project_id: project.id })
  for (const domain of domains) {
    if (domain.dsh_session_id) sessionOwners.set(domain.dsh_session_id, { kind: 'domain', domain_id: domain.id })
  }
  for (const matrix of matrices) {
    if (matrix.dsh_session_id) sessionOwners.set(matrix.dsh_session_id, { kind: 'matrix', matrix_id: matrix.id })
  }
  for (const [sessionId, owner] of sessionOwners) {
    let events = []
    if (typeof dependencies.sessionEvents === 'function') {
      try {
        const snapshot = await dependencies.sessionEvents({ sessionId, sinceSeq: 0 })
        events = (snapshot && snapshot.events) || []
      } catch {}
    }
    await writeJson(join(stateDir, 'sessions', `${sessionId}.json`), {
      session_id: sessionId,
      ...owner,
      exported_at: now(),
      event_count: events.length,
      events,
    })
  }
  return { matrices: matrices.length, domains: domains.length, runs: runIds.size, sessions: sessionOwners.size }
}

/** 生成快照并提交；没有变化时跳过，返回提交信息。 */
export async function commitProjectCheckpoint(dataDir, project, { message = 'checkpoint', dependencies = {} } = {}) {
  const repo = projectRepoDir(dataDir, project.id)
  if (!existsSync(join(repo, '.git'))) throw new Error('项目尚未初始化 Git 仓库')
  const snapshot = await collectSnapshot(dataDir, project, dependencies)
  await git(repo, ['add', '-A'])
  const status = (await git(repo, ['status', '--porcelain'], { allowFail: true }) || '').trim()
  if (!status) return { skipped: true, message, snapshot }
  await git(repo, [
    '-c', 'user.name=rms-flow-runner',
    '-c', 'user.email=rms-flow-runner@local',
    'commit', '-m', String(message || 'checkpoint').slice(0, 500),
  ])
  const commit = (await git(repo, ['rev-parse', '--short', 'HEAD'], { allowFail: true }) || '').trim()
  return { skipped: false, commit, message, snapshot }
}

/** 关键操作后的自动 checkpoint；未启用 Git 时静默跳过。 */
export async function autoCheckpoint(dataDir, projectId, message, dependencies = {}) {
  if (!projectId) return null
  try {
    if (!projectGitEnabled(dataDir, projectId)) return null
    const project = loadProject(dataDir, projectId)
    return await commitProjectCheckpoint(dataDir, project, { message, dependencies })
  } catch (error) {
    console.error(`[project-git] auto checkpoint failed: ${error && error.message ? error.message : error}`)
    return null
  }
}

export async function projectGitStatus(dataDir, project) {
  const repo = projectRepoDir(dataDir, project.id)
  if (!existsSync(join(repo, '.git'))) {
    return { enabled: false, repo, head: null, branch: null, changed_files: 0 }
  }
  const head = (await git(repo, ['rev-parse', '--short', 'HEAD'], { allowFail: true }) || '').trim() || null
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || '').trim() || null
  const status = (await git(repo, ['status', '--porcelain'], { allowFail: true }) || '').trim()
  return {
    enabled: true,
    repo,
    head,
    branch,
    changed_files: status ? status.split('\n').length : 0,
  }
}

export async function projectGitLog(dataDir, project, limit = 20) {
  const repo = projectRepoDir(dataDir, project.id)
  if (!existsSync(join(repo, '.git'))) return []
  const text = (await git(repo, ['log', `-n`, String(Math.min(Math.max(Number(limit) || 20, 1), 100)), '--pretty=format:%h%x1f%ad%x1f%s', '--date=iso'], { allowFail: true }) || '').trim()
  if (!text) return []
  return text.split('\n').map(line => {
    const [commit, date, subject] = line.split('\x1f')
    return { commit, date, subject }
  })
}

export async function projectGitShow(dataDir, project, commit) {
  const repo = projectRepoDir(dataDir, project.id)
  if (!existsSync(join(repo, '.git'))) throw new Error('项目尚未初始化 Git 仓库')
  const rev = (await git(repo, ['rev-parse', String(commit || 'HEAD')], { allowFail: true }) || '').trim()
  if (!rev) throw new Error(`提交不存在：${commit}`)
  const stat = await git(repo, ['show', '--stat', '--format=fuller', rev], { allowFail: true })
  return { commit: rev, stat: stat || '' }
}

async function extractState(repo, commit, destination) {
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', commit, 'state'], { cwd: repo, windowsHide: true })
    const tar = spawn('tar', ['-xf', '-', '-C', destination], { windowsHide: true })
    let stderr = ''
    archive.stderr.on('data', chunk => { stderr += chunk })
    tar.stderr.on('data', chunk => { stderr += chunk })
    archive.on('error', reject)
    tar.on('error', reject)
    archive.stdout.pipe(tar.stdin)
    tar.on('close', code => (code === 0 ? resolve() : reject(new Error(`解包快照失败：${stderr}`))))
  })
}

async function seedFromSnapshot(dependencies, snap, context) {
  if (!snap || !Array.isArray(snap.events) || !snap.events.length) return null
  if (typeof dependencies.sessionSeed !== 'function') return null
  try {
    const seeded = await dependencies.sessionSeed({
      sessionId: snap.session_id,
      events: snap.events,
      eventCount: snap.events.length,
      ...context,
    })
    return seeded && seeded.session_id ? seeded.session_id : null
  } catch (error) {
    console.error(`[project-git] session seed failed for ${snap.session_id}: ${error && error.message ? error.message : error}`)
    return null
  }
}

/**
 * 恢复到某个提交（checkpoint 回滚）：
 * - 项目元数据、matrix 记录、matrix work、运行记录全部回滚；
 * - dsh 会话按快照事件重建为新会话（旧会话保留在 dsh 侧栏，记录改绑到新会话）；
 * - 恢复完成后自动提交一条 restore checkpoint。
 */
export async function restoreProjectCheckpoint(dataDir, projectId, commit, dependencies = {}) {
  const current = loadProject(dataDir, projectId)
  const repo = projectRepoDir(dataDir, projectId)
  if (!existsSync(join(repo, '.git'))) throw new Error('项目尚未初始化 Git 仓库')
  const rev = (await git(repo, ['rev-parse', String(commit || 'HEAD')], { allowFail: true }) || '').trim()
  if (!rev) throw new Error(`提交不存在：${commit}`)
  const stateEntry = (await git(repo, ['ls-tree', '--name-only', rev, 'state'], { allowFail: true }) || '').trim()
  if (!stateEntry) throw new Error('该提交没有项目快照，无法恢复')

  const temp = await mkdtemp(join(tmpdir(), 'rms-project-restore-'))
  try {
    await extractState(repo, rev, temp)
    const snapshotProject = JSON.parse(await readFile(join(temp, 'state', 'project.json'), 'utf8'))
    if (snapshotProject.id !== projectId) throw new Error('快照项目 id 与当前项目不一致')

    const matrixDir = join(temp, 'state', 'matrices')
    const matrixFiles = existsSync(matrixDir) ? (await readdir(matrixDir)).filter(name => name.endsWith('.json')) : []
    const snapshotMatrices = []
    for (const file of matrixFiles) {
      snapshotMatrices.push(JSON.parse(await readFile(join(matrixDir, file), 'utf8')))
    }

    const domainDir = join(temp, 'state', 'domains')
    const domainFiles = existsSync(domainDir) ? (await readdir(domainDir)).filter(name => name.endsWith('.json')) : []
    const snapshotDomains = []
    for (const file of domainFiles) {
      snapshotDomains.push(JSON.parse(await readFile(join(domainDir, file), 'utf8')))
    }
    if (!Array.isArray(snapshotProject.domain_ids)) snapshotProject.domain_ids = snapshotDomains.map(domain => domain.id)

    const sessionDir = join(temp, 'state', 'sessions')
    const sessionFiles = existsSync(sessionDir) ? (await readdir(sessionDir)).filter(name => name.endsWith('.json')) : []
    const snapshotSessions = []
    for (const file of sessionFiles) {
      snapshotSessions.push(JSON.parse(await readFile(join(sessionDir, file), 'utf8')))
    }

    // 运行中的会话不能回滚，避免覆盖正在写入的对话
    if (typeof dependencies.agentStatus === 'function') {
      for (const snap of snapshotSessions) {
        try {
          const status = await dependencies.agentStatus({ sessionId: snap.session_id })
          if (status && status.running) throw new Error(`会话 ${snap.session_id} 仍在执行，请等待结束后再恢复`)
        } catch (error) {
          if (/仍在执行/.test(error.message)) throw error
        }
      }
    }

    // dsh 会话：按快照事件重建，记录改绑到新会话
    const projectCwd = snapshotProject.cwd || current.cwd
    const sessionMap = new Map()
    const projectSnap = snapshotSessions.find(snap => snap.kind === 'project' && snap.session_id === snapshotProject.dsh_session_id)
    const newProjectSession = await seedFromSnapshot(dependencies, projectSnap, {
      cwd: projectCwd,
      title: snapshotProject.name,
      task: snapshotProject.brief,
      brief: projectBrief(snapshotProject),
      matrixId: snapshotProject.id,
      parentSessionId: null,
    })
    if (newProjectSession) sessionMap.set(snapshotProject.dsh_session_id, newProjectSession)
    snapshotProject.dsh_session_id = newProjectSession || snapshotProject.dsh_session_id

    // 领域会话挂在恢复后的项目会话下；元素 matrix 会再挂到领域会话下
    for (const domain of snapshotDomains.slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))) {
      const snap = snapshotSessions.find(item => item.kind === 'domain' && item.session_id === domain.dsh_session_id)
      const newSession = await seedFromSnapshot(dependencies, snap, {
        cwd: projectCwd,
        title: domain.name,
        task: domain.brief,
        brief: domainBrief(domain, snapshotProject),
        matrixId: domain.id,
        parentSessionId: snapshotProject.dsh_session_id,
      })
      if (newSession) sessionMap.set(domain.dsh_session_id, newSession)
      domain.dsh_session_id = newSession || domain.dsh_session_id
      domain.parent_session_id = snapshotProject.dsh_session_id || null
      domain.project_id = projectId
    }

    const sorted = snapshotMatrices.slice().sort((a, b) => (a.depth || 0) - (b.depth || 0))
    for (const matrix of sorted) {
      const snap = snapshotSessions.find(item => item.kind === 'matrix' && item.session_id === matrix.dsh_session_id)
      const parent = matrix.parent_id ? snapshotMatrices.find(item => item.id === matrix.parent_id) : null
      const bindingDomain = matrix.domain_binding
        ? snapshotDomains.find(domain => domain.id === matrix.domain_binding.domain_id)
        : null
      const parentSessionId = parent
        ? (sessionMap.get(parent.dsh_session_id) || parent.dsh_session_id)
        : bindingDomain
          ? (sessionMap.get(bindingDomain.dsh_session_id) || bindingDomain.dsh_session_id)
          : null
      const newSession = await seedFromSnapshot(dependencies, snap, {
        cwd: matrix.cwd || null,
        title: matrix.name,
        task: matrix.task,
        matrixId: matrix.id,
        parentSessionId,
      })
      if (newSession) sessionMap.set(matrix.dsh_session_id, newSession)
      matrix.dsh_session_id = newSession || matrix.dsh_session_id
      matrix.project_id = projectId
    }
    if (snapshotProject.dsh_session_id) {
      // 项目会话 id 在快照里可能已改绑，回写 root 列表无关字段保持原样
    }

    // matrix 记录与 work：按快照覆盖；当前项目里快照不存在的 matrix 记录移除
    const snapshotIds = new Set(sorted.map(matrix => matrix.id))
    const liveMatrices = [...loadAll(dataDir).values()].filter(matrix => matrix.project_id === projectId)
    for (const matrix of liveMatrices) {
      if (snapshotIds.has(matrix.id)) continue
      await rm(join(dataDir, `matrix-${matrix.id}.json`), { force: true })
    }
    for (const matrix of sorted) {
      await writeJson(join(dataDir, `matrix-${matrix.id}.json`), matrix)
      const snapWork = join(matrixDir, matrix.id, 'work')
      if (existsSync(snapWork)) await copyDir(snapWork, matrixWorkDir(dataDir, matrix.id))
    }

    // 领域记录与 work：按快照覆盖；快照里不存在的领域文件移除
    const snapshotDomainIds = new Set(snapshotDomains.map(domain => domain.id))
    for (const domainId of current.domain_ids || []) {
      if (!snapshotDomainIds.has(domainId)) await rm(join(dataDir, `domain-${domainId}.json`), { force: true })
    }
    for (const domain of snapshotDomains) {
      await writeJson(join(dataDir, `domain-${domain.id}.json`), domain)
      const snapWork = join(domainDir, domain.id, 'work')
      if (existsSync(snapWork)) await copyDir(snapWork, domainWorkDir(dataDir, domain))
    }

    // 运行记录：按快照覆盖
    const runsDir = join(temp, 'state', 'runs')
    if (existsSync(runsDir)) {
      for (const runId of await readdir(runsDir)) {
        await copyDir(join(runsDir, runId), join(dataDir, 'runs', runId))
      }
    }

    // 导出/导入包：registry 是全局资源，恢复时把快照副本写回，保证导入关系可解析
    const registryDir = registryExportDir(dataDir)
    for (const folder of ['exports', 'imports']) {
      const sourceDir = join(temp, 'state', folder)
      if (!existsSync(sourceDir)) continue
      await mkdir(registryDir, { recursive: true })
      for (const file of await readdir(sourceDir)) {
        if (!file.endsWith('.json')) continue
        await cp(join(sourceDir, file), join(registryDir, file), { force: true })
      }
    }

    // persist 数据：按快照覆盖；快照没有 data 时清空，保证回滚后的数据一致性
    const snapshotData = join(temp, 'state', 'data')
    const liveDataDir = projectDataDir(dataDir, projectId)
    if (existsSync(snapshotData)) await copyDir(snapshotData, liveDataDir)
    else await rm(liveDataDir, { recursive: true, force: true })

    // 项目工作区（新项目 work 在仓库内，按快照恢复）
    const snapshotWork = join(temp, 'work')
    if (existsSync(snapshotWork) && projectCwd) await copyDir(snapshotWork, projectCwd)

    snapshotProject.updated_at = now()
    appendProjectOperation(snapshotProject, {
      action: 'git_restore',
      target_type: 'project',
      target_id: projectId,
      target_name: snapshotProject.name,
      detail: { commit: rev.slice(0, 7), sessions: sessionMap.size },
    })
    await writeJson(join(dataDir, `project-${projectId}.json`), snapshotProject)

    const committed = await commitProjectCheckpoint(dataDir, snapshotProject, {
      message: `restore checkpoint ${rev.slice(0, 7)}`,
      dependencies,
    })
    return {
      restored_commit: rev,
      checkpoint_commit: committed.commit || null,
      project: snapshotProject,
      matrices: sorted.length,
      domains: snapshotDomains.length,
      sessions_rebound: sessionMap.size,
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
