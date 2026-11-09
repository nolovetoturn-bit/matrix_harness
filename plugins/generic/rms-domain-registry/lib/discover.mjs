/**
 * 能力检索编排：只读 registry → 多轮关键词扩散 → 可选 LLM 契约复核。
 * 本模块不包含任何领域写入能力。
 */
import { listPackages, loadPackage, resolveDataDir, summarizePackage } from './registry.mjs'
import {
  buildJudgeMessages,
  deterministicMatches,
  discover,
  parseJsonLoose,
  validateJudgeResult,
} from './retrieval.mjs'

const json = value => JSON.stringify(value, null, 2)

const clampInt = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback
}

export function registryList(args = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const rows = listPackages(dataDir, {
    query: args.query || '',
    domainId: args.domain_id || null,
    limit: clampInt(args.limit, 1, 200, 50),
  })
  return json({
    data_dir: dataDir,
    total: rows.length,
    exports: rows.map(summarizePackage),
  })
}

export function registryGet(args = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const exportId = String(args.export_id || '').trim()
  if (!exportId) throw new Error('export_id 不能为空')
  return json(loadPackage(dataDir, exportId))
}

/**
 * domain_discover 主流程。
 * reviewWithAgent 由 dsh 宿主注入；MCP / 测试环境没有 LLM 时自动降级为关键词结果。
 */
export async function registryDiscover(args = {}, dependencies = {}, context = {}) {
  const dataDir = resolveDataDir(args.data_dir)
  const requirement = String(args.requirement || '').trim()
  if (!requirement) throw new Error('requirement 不能为空')
  const topK = clampInt(args.top_k, 1, 10, 5)
  const maxRounds = clampInt(args.max_rounds, 0, 3, 2)
  const packages = listPackages(dataDir, { limit: 500 })
  if (!packages.length) {
    return json({
      matches: [],
      no_match_reason: '能力注册表为空',
      degraded: false,
      retrieval: { seed_terms: [], rounds: [], expanded_terms: [] },
    })
  }

  const retrieval = discover(packages, requirement, { topK, maxRounds, expandLimit: 8 })
  const candidates = retrieval.candidates.slice(0, topK)
  const audit = {
    seed_terms: retrieval.seed_terms,
    rounds: retrieval.rounds,
    expanded_terms: retrieval.expanded_terms,
  }

  if (!candidates.length) {
    return json({
      matches: [],
      no_match_reason: '没有命中任何领域能力',
      degraded: false,
      retrieval: audit,
    })
  }

  if (typeof dependencies.reviewWithAgent !== 'function') {
    return json({
      ...deterministicMatches(packages, retrieval, { topK }),
      retrieval: audit,
      warnings: ['未启用 LLM 契约复核，当前为关键词兜底结果'],
    })
  }

  const messages = buildJudgeMessages({ requirement, candidates, packages, topK })
  try {
    const raw = await dependencies.reviewWithAgent({
      ...messages,
      parentSessionId: context.sessionId || null,
      topK,
    })
    return json({
      ...validateJudgeResult(parseJsonLoose(raw), packages, { topK }),
      retrieval: audit,
    })
  } catch (error) {
    return json({
      ...deterministicMatches(packages, retrieval, { topK }),
      retrieval: audit,
      warnings: [`LLM 复核失败，已降级为关键词结果：${error && error.message ? error.message : error}`],
    })
  }
}
