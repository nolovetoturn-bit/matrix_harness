import { memoryMarkdown } from './memory.mjs'
import { projectWorkDir } from './store.mjs'

/**
 * 项目常驻会话的固定语境：项目级操作走 project_* 工具，根 matrix 仍走 matrix_*。
 * 项目记忆只注入项目会话，不注入 matrix 会话。
 */
export function projectBrief(project) {
  const memory = memoryMarkdown(project)
  return [
    `【Flow 项目会话】${project.name}`,
    `project_id: ${project.id}`,
    `项目说明：${project.brief || '（未填写）'}`,
    `工作目录：${project.cwd || '（未设置）'}`,
    '',
    memory,
    '',
    `你是该项目的常驻 agent。用户在此会话中的自然语言输入就是对项目 ${project.id} 的操作指令：`,
    '- 先调用 project_get / project_tree / project_summary 了解项目现状；',
    '- 新建根 matrix 用 project_create_matrix（自动挂到本项目）；用 matrix_intake 时必须带 project_id；',
    '- 根 matrix 的受理、DAG、预构建、运行、验收仍由对应 matrix 会话或 matrix_* 工具推进；',
    '- 项目记忆用 project_memory 维护（add/update/remove），写入后会同步到 PROJECT_MEMORY.md；',
    '- 需要跨根推进时用 project_nav，批量运行可运行根矩阵用 project_run_runnable；',
    '- 除验收、终止等需要用户明确同意外，其余动作可以自行推进，完成后向用户报告结果。',
  ].join('\n')
}

/**
 * 每个项目一个 dsh 会话，parentSessionId 固定为 null（项目会话是顶层）。
 * 同一项目的所有根 matrix 会话会把 sessionWorkspace 归到项目 cwd（仅侧栏分组）。
 */
export async function ensureProjectSession(project, dependencies = {}) {
  if (project.dsh_session_id) return project
  project.cwd = project.cwd || projectWorkDir(dependencies.dataDir, project.id)
  if (typeof dependencies.sessionMirror !== 'function') return project
  const brief = projectBrief(project)
  const mirrored = await dependencies.sessionMirror({
    sessionId: project.id,
    matrixId: project.id,
    workspace: project.cwd,
    title: project.name,
    task: project.brief,
    parentSessionId: null,
    brief,
  })
  project.dsh_session_id = mirrored.session_id || project.id
  return project
}
