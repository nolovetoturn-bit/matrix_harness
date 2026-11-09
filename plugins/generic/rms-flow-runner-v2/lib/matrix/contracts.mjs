/**
 * 骨架 DAG 的 Cin/Cout 契约校验。
 *
 * 骨架 children 是顺序执行：根入口 inputs 只提供给第一个节点，之后每个节点的 Cin
 * 只等于上一节点的 Cout。因此下游节点需要的入口字段，必须由上游节点在 outputs 中透传，
 * 否则运行期会拿到 undefined（例如“子流程输出 {result}，校验节点却需要 {value,result}”）。
 */

const contractKeys = contract => {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null
  const keys = Object.keys(contract)
  return keys.length ? keys : null
}

function describeKeys(keys) {
  return keys && keys.length ? `[${keys.join(', ')}]` : '空'
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 收集 mapping 里所有 {var:...} 的根字段名。 */
function mappingRootVars(expression, out = []) {
  if (Array.isArray(expression)) {
    for (const item of expression) mappingRootVars(item, out)
    return out
  }
  if (!isObject(expression)) return out
  if (typeof expression.var === 'string') {
    const root = expression.var.replace(/^\$\.?/, '').split('.')[0]
    if (root && !out.includes(root)) out.push(root)
    return out
  }
  for (const value of Object.values(expression)) mappingRootVars(value, out)
  return out
}

/**
 * 计算逐节点契约问题，供确认门禁与 DAG 展示共用。
 * fanout 的每个分支与 fanout 输入对齐；merge 的 mapping 引用必须来自 fanout 汇总输出。
 * @returns {{ok:boolean, errors:string[], nodeIssues:Object<string,string[]>, rootInputs:string[]|null}}
 */
export function skeletonContractIssues(skeleton) {
  const errors = []
  const nodeIssues = {}
  const entry = skeleton && skeleton.entry
  const rootKeys = entry ? contractKeys(entry.inputs) : null
  if (!entry || !Array.isArray(entry.children) || !entry.children.length) {
    return { ok: true, errors, nodeIssues, rootInputs: rootKeys }
  }

  const recordIssue = (id, missing) => {
    nodeIssues[id] = [...new Set([...(nodeIssues[id] || []), ...missing])]
  }

  let available = rootKeys ? new Set(rootKeys) : new Set()
  for (const node of entry.children) {
    const need = contractKeys(node.inputs)
    if (need && available) {
      const missing = need.filter(key => !available.has(key))
      if (missing.length) {
        recordIssue(node.id, missing)
        errors.push(
          `节点「${node.label || node.id}」（${node.id}）的 Cin 需要 ${describeKeys(missing)}，`
          + `但上游只提供 ${describeKeys([...available])}；请让上游节点在 outputs 中透传缺失字段，`
          + '或调整本节点的 Cin，不能假设运行时会自动保留根入口字段。',
        )
      }
    }

    if (node.type === 'fanout') {
      const inputKeys = contractKeys(node.inputs)
      for (const branch of node.children || []) {
        if (!inputKeys) continue
        const missing = (contractKeys(branch.inputs) || []).filter(key => !inputKeys.includes(key))
        if (missing.length) {
          recordIssue(branch.id, missing)
          errors.push(
            `分支「${branch.label || branch.id}」（${branch.id}）的 Cin 需要 ${describeKeys(missing)}，`
            + `但 fanout 输入只提供 ${describeKeys(inputKeys)}；分支只能消费 fanout 的输入字段。`,
          )
        }
      }
      const collect = node.collect || 'keyed'
      if (collect === 'keyed') {
        const outKeys = contractKeys(node.outputs)
        if (outKeys) {
          const needed = (node.children || []).map(branch => branch.id)
            .concat(Array.isArray(node.carry) ? node.carry : [])
          const missing = needed.filter(id => !outKeys.includes(id))
          if (missing.length) {
            recordIssue(node.id, missing)
            errors.push(
              `节点「${node.label || node.id}」（${node.id}）的 Cout 缺少分支/carry 键 ${describeKeys(missing)}；`
              + 'collect=keyed 时 outputs 必须覆盖所有分支 id 与 carry 字段。',
            )
          }
        }
      }
      available = contractKeys(node.outputs) ? new Set(contractKeys(node.outputs)) : null
      continue
    }

    if (node.type === 'branch') {
      const inputKeys = contractKeys(node.inputs)
      const outputKeys = contractKeys(node.outputs)
      for (const child of [node.then, node.else].filter(isObject)) {
        if (inputKeys) {
          const missing = (contractKeys(child.inputs) || []).filter(key => !inputKeys.includes(key))
          if (missing.length) {
            recordIssue(child.id, missing)
            errors.push(
              `分支「${child.label || child.id}」（${child.id}）的 Cin 需要 ${describeKeys(missing)}，`
              + `但 branch 输入只提供 ${describeKeys(inputKeys)}；then/else 只能消费 branch 的输入字段。`,
            )
          }
        }
        if (outputKeys) {
          const childOut = contractKeys(child.outputs)
          if (childOut) {
            const missing = outputKeys.filter(key => !childOut.includes(key))
            if (missing.length) {
              recordIssue(child.id, missing)
              errors.push(
                `分支「${child.label || child.id}」（${child.id}）的 Cout 缺少 ${describeKeys(missing)}；`
                + 'then/else 都必须覆盖 branch 声明的 outputs。',
              )
            }
          }
        }
      }
      if (!node.else && outputKeys && inputKeys) {
        const missing = outputKeys.filter(key => !inputKeys.includes(key))
        if (missing.length) {
          recordIssue(node.id, missing)
          errors.push(
            `节点「${node.label || node.id}」（${node.id}）没有 else，Cout 缺少 ${describeKeys(missing)}；`
            + 'condition=false 时 branch 直接透传输入，outputs 必须由输入字段覆盖。',
          )
        }
      }
      available = outputKeys ? new Set(outputKeys) : null
      continue
    }

    if (node.type === 'merge') {
      const cinKeys = contractKeys(node.inputs)
      if (cinKeys) {
        for (const [key, expression] of Object.entries(node.mapping || {})) {
          const missing = mappingRootVars(expression).filter(name => !cinKeys.includes(name))
          if (missing.length) {
            recordIssue(node.id, missing)
            errors.push(
              `节点「${node.label || node.id}」（${node.id}）的 mapping.${key} 引用了 ${describeKeys(missing)}，`
              + `但 merge 的 Cin 只有 ${describeKeys(cinKeys)}；请让 fanout 输出对应分支键。`,
            )
          }
        }
      }
      available = contractKeys(node.outputs) ? new Set(contractKeys(node.outputs)) : null
      continue
    }

    // 无法解析的 outputs 描述（字符串/数组）视为下游契约未知，停止继续推断
    available = contractKeys(node.outputs) ? new Set(contractKeys(node.outputs)) : null
  }
  return { ok: errors.length === 0, errors, nodeIssues, rootInputs: rootKeys }
}

export function validateSkeletonContracts(skeleton) {
  const result = skeletonContractIssues(skeleton)
  return { ok: result.ok, errors: result.errors }
}

export function assertSkeletonContracts(skeleton) {
  const result = skeletonContractIssues(skeleton)
  if (!result.ok) {
    throw new Error(`骨架 DAG 的 Cin/Cout 不一致：\n- ${result.errors.join('\n- ')}`)
  }
  return skeleton
}
