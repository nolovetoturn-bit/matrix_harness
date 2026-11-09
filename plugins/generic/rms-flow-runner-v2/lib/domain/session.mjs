import { domainMemoryMarkdown } from './memory.mjs'
import { domainWorkDir } from './store.mjs'
import { ensureProjectSession } from '../project/session.mjs'
import { projectWorkDir, saveProject } from '../project/store.mjs'

/**
 * 领域会话挂在项目会话下面；workspace 必须与项目会话一致，dsh 侧栏才能按
 * 「项目会话 → 领域会话 → 元素根 matrix 会话」嵌套。
 */
export function domainBrief(domain, project) {
  const memory = domainMemoryMarkdown(domain)
  return [
    `【Flow 领域会话】${domain.name}`,
    `domain_id: ${domain.id}`,
    `所属项目：${project ? `${project.name}（${project.id}）` : '（未知）'}`,
    `限界上下文：${domain.bounded_context || domain.name}`,
    `领域目标：${domain.brief || '（未填写）'}`,
    '',
    memory,
    '',
    `你是该领域（限界上下文）的常驻 DDD 分析 agent。用户在此会话中的输入就是领域建模指令：`,
    '- 先调用 domain_get 读取当前 models / stubs / interacts / 记忆，再增量修改，不要整表覆盖；',
    '- model 必须声明 type=request/response/persistence；request/response 的 kind 固定为 dto，persistence 使用 entity/value_object/domain_event；',
    '- stub operation 用 request_model_ids / response_model_ids 声明契约，禁止引用 persistence model；',
    '- interact 用 request_model_ids / response_model_ids / stub_ids 引用已有元素，禁止引用 persistence model；先建模型与服务再建交互；',
    '- 每个 model / stub / interact 只允许一个根 matrix，必须用 domain_matrix_intake 创建；已有 matrix 时不要重复创建；',
    '- 复合元素（需要多个子流程）必须在元素根 matrix 的 DAG 内部用 group 节点拆分，由预构建生成子 matrix，不要拆成多个根 matrix；',
    '- 长期约束、术语与关键决策用 domain_memory 记录；',
    '- 不生成技术栈、数据库表、HTTP 接口等实现细节，这些留给 matrix 的 DAG/预构建阶段；',
    '- 除 destructive 删除外可以自行推进，完成后向用户报告领域目录变化。',
  ].join('\n')
}

export async function ensureDomainSession(domain, project, dependencies = {}) {
  if (domain.dsh_session_id) return domain
  const dataDir = dependencies.dataDir
  domain.cwd = domain.cwd || domainWorkDir(dataDir, domain)
  if (!project.dsh_session_id) {
    project.cwd = project.cwd || projectWorkDir(dataDir, project.id)
    await ensureProjectSession(project, { ...dependencies, dataDir })
    saveProject(dataDir, project)
    domain.parent_session_id = project.dsh_session_id
  }
  if (typeof dependencies.sessionMirror !== 'function') return domain
  const brief = domainBrief(domain, project)
  const mirrored = await dependencies.sessionMirror({
    sessionId: domain.id,
    matrixId: domain.id,
    workspace: project.cwd || projectWorkDir(dataDir, project.id),
    title: domain.name,
    task: domain.brief,
    parentSessionId: project.dsh_session_id || null,
    brief,
  })
  domain.dsh_session_id = mirrored.session_id || domain.id
  domain.parent_session_id = project.dsh_session_id || null
  return domain
}
