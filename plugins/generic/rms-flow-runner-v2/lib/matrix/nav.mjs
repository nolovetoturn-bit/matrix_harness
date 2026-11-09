import { childrenOf, deriveState, STATES } from './state.mjs'

const isSkippable = matrix => matrix && [STATES.ACCEPTED, STATES.CANCELLED].includes(matrix.state)

/**
 * “可操作叶子”：尚未验收，且没有尚未验收的后代。
 * 已验收/已终止子树整体跳过。
 */
function findActionable(matrix, matrices) {
  if (!matrix || isSkippable(matrix)) return null
  const children = childrenOf(matrix, matrices)
  for (const child of children) {
    const found = findActionable(child, matrices)
    if (found) return found
  }
  return children.every(child => isSkippable(child)) ? matrix : null
}

/**
 * 「下一个未验收」：
 * 1) 先在当前 matrix 的子分支里按先序、左→右找最深最左的可操作叶子；
 * 2) 当前子树已全部验收时，沿父链向上，按兄弟分支左→右找最近的可操作叶子；
 * 3) 整棵树都验收则返回 null。
 */
export function nextUnaccepted({ currentId, matrices }) {
  const current = matrices.get ? matrices.get(currentId) : matrices[currentId]
  if (!current) throw new Error(`matrix 不存在：${currentId}`)
  for (const child of childrenOf(current, matrices)) {
    const found = findActionable(child, matrices)
    if (found) return { id: found.id, name: found.name, state: deriveState(found, matrices), via: 'child' }
  }
  let cursor = current
  while (cursor && cursor.parent_id) {
    const parent = matrices.get ? matrices.get(cursor.parent_id) : matrices[cursor.parent_id]
    if (!parent) break
    for (const sibling of childrenOf(parent, matrices)) {
      if (sibling.id === cursor.id) continue
      const found = findActionable(sibling, matrices)
      if (found) return { id: found.id, name: found.name, state: deriveState(found, matrices), via: 'sibling' }
    }
    cursor = parent
  }
  return null
}

/** 某棵子树里最深最左的可操作叶子（用于项目级跨根导航）。 */
export function firstActionable(rootId, matrices) {
  const root = matrices.get ? matrices.get(rootId) : matrices[rootId]
  return root ? findActionable(root, matrices) : null
}

/** 面包屑：根 → … → 当前。 */
export function breadcrumb(matrixId, matrices) {
  const path = []
  let cursor = matrices.get ? matrices.get(matrixId) : matrices[matrixId]
  const guard = new Set()
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id)
    path.unshift({ id: cursor.id, name: cursor.name, state: cursor.state })
    cursor = cursor.parent_id ? (matrices.get ? matrices.get(cursor.parent_id) : matrices[cursor.parent_id]) : null
  }
  return path
}

/** 子树视图：供 GET /api/matrix/tree 与面板渲染。 */
export function treeView(rootId, matrices) {
  const build = matrix => {
    const children = childrenOf(matrix, matrices).map(build)
    const acceptedCount = children.filter(child => child.state === STATES.ACCEPTED).length
    return {
      id: matrix.id,
      name: matrix.name,
      state: deriveState(matrix, matrices),
      stored_state: matrix.state,
      parent_id: matrix.parent_id,
      depth: matrix.depth,
      task: matrix.task,
      prebuild_done: Boolean(matrix.prebuild_done),
      runnable: deriveState(matrix, matrices) === STATES.RUNNABLE,
      children_total: children.length,
      children_accepted: acceptedCount,
      updated_at: matrix.updated_at,
      children,
    }
  }
  const root = matrices.get ? matrices.get(rootId) : matrices[rootId]
  return root ? build(root) : null
}

/** 深度优先收集子树里所有 matrix id（含自身）。 */
export function subtreeIds(rootId, matrices) {
  const root = matrices.get ? matrices.get(rootId) : matrices[rootId]
  if (!root) return []
  const ids = []
  const visit = matrix => {
    ids.push(matrix.id)
    for (const child of childrenOf(matrix, matrices)) visit(child)
  }
  visit(root)
  return ids
}
