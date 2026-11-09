/**
 * 领域能力检索：分词 → 倒排索引 → 首轮召回 → 领域术语扩散 → 二轮召回。
 * 全部为纯函数，便于测试；LLM 只负责最后的契约复核。
 */

const LATIN = /[a-z][a-z0-9_]{1,}/g
const CJK_RUN = /[\u4e00-\u9fff]+/g

const STOP_TERMS = new Set([
  '我们', '你们', '他们', '这个', '那个', '一个', '一种', '一些', '需要', '可以', '应该', '必须',
  '以及', '并且', '然后', '最后', '如果', '因为', '所以', '进行', '通过', '使用', '基于', '对于',
  '关于', '根据', '按照', '其中', '时候', '问题', '情况', '方式', '目前', '现在', '之后', '之前',
])

/** 泛化词仍参与匹配，但权重很低，避免“系统/服务”主导排序。 */
const GENERIC_TERMS = new Set([
  '能力', '系统', '服务', '业务', '功能', '数据', '流程', '管理', '平台', '支持', '提供', '实现',
  '处理', '信息', '内容', '相关', '需求', '要求', '希望', '完成', '得到', '返回', '结果', '请求',
  '响应', '领域', '模型', '接口', '调用', '操作', '定义', '设计',
])

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, ' ')
    .trim()
}

/**
 * 中文无分词器时使用 2-4 字 n-gram：宁可多召回，后续靠 IDF 与契约复核收敛。
 * @returns {{term:string, weight:number}[]}
 */
export function tokenize(value) {
  const text = normalizeText(value)
  const terms = []
  const seen = new Set()
  const add = (term, bonus = 0) => {
    if (!term || STOP_TERMS.has(term) || seen.has(term)) return
    seen.add(term)
    terms.push({ term, weight: (GENERIC_TERMS.has(term) ? 0.35 : 1) + bonus })
  }
  for (const match of text.matchAll(LATIN)) add(match[0])
  for (const run of text.match(CJK_RUN) || []) {
    if (run.length < 2) continue
    if (run.length <= 6) add(run, 0.2)
    for (const size of [2, 3, 4]) {
      if (size > run.length) continue
      for (let index = 0; index + size <= run.length; index += 1) {
        add(run.slice(index, index + size))
      }
    }
  }
  return terms
}

const fieldOf = (kind, weight, text) => ({ kind, weight, text: String(text || '') })

function fieldsOfPackage(pkg) {
  const fields = [
    fieldOf('name', 3.2, pkg.name),
    fieldOf('summary', 1.2, pkg.summary),
  ]
  for (const model of pkg.models || []) {
    fields.push(fieldOf('model', 2.1, [
      model.name,
      ...(model.attributes || []).map(attribute => attribute.name),
    ].join(' ')))
  }
  for (const stub of pkg.stubs || []) {
    fields.push(fieldOf('stub', 2.3, stub.name))
    for (const operation of stub.operations || []) {
      fields.push(fieldOf('operation', 2.6, `${operation.name} ${operation.description || ''}`))
    }
  }
  return fields
}

/** 构建内存倒排索引：term → { export_id → 字段最高权重 }。 */
export function buildIndex(packages) {
  const docs = new Map()
  const postings = new Map()
  for (const pkg of packages) {
    const fields = fieldsOfPackage(pkg)
    const termWeights = new Map()
    for (const field of fields) {
      for (const token of tokenize(field.text)) {
        const weight = field.weight * token.weight
        if (weight > (termWeights.get(token.term) || 0)) termWeights.set(token.term, weight)
      }
    }
    docs.set(pkg.export_id, { pkg, fields, termWeights })
    for (const [term, weight] of termWeights) {
      if (!postings.has(term)) postings.set(term, new Map())
      postings.get(term).set(pkg.export_id, weight)
    }
  }
  const df = new Map([...postings.entries()].map(([term, map]) => [term, map.size]))
  return { docs, postings, df, total: packages.length }
}

/**
 * @param {{term:string, weight:number}[]|string[]} terms
 * @returns {{export_id:string, score:number, terms:string[]}[]}
 */
export function search(index, terms) {
  const query = terms
    .map(item => (typeof item === 'string' ? { term: item, weight: 1 } : item))
    .filter(item => item && item.term)
  const scores = new Map()
  for (const item of query) {
    const posting = index.postings.get(item.term)
    if (!posting) continue
    const idf = Math.log(1 + index.total / (1 + posting.size))
    for (const [exportId, weight] of posting) {
      const row = scores.get(exportId) || { export_id: exportId, score: 0, terms: [] }
      row.score += weight * idf * (Number(item.weight) || 1)
      if (!row.terms.includes(item.term)) row.terms.push(item.term)
      scores.set(exportId, row)
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score)
}

/**
 * 从首轮命中的领域里挖领域术语：只用名称、Model、Stub、operation，且跳过泛化词。
 * @returns {{term:string, from_export_id:string, field:string, score:number}[]}
 */
export function expandTerms(index, hits, { existing = new Set(), limit = 8 } = {}) {
  if (!hits.length) return []
  const topScore = hits[0].score || 1
  const candidates = new Map()
  for (const hit of hits.slice(0, 3)) {
    const doc = index.docs.get(hit.export_id)
    if (!doc) continue
    for (const field of doc.fields) {
      for (const token of tokenize(field.text)) {
        if (existing.has(token.term) || GENERIC_TERMS.has(token.term)) continue
        const df = index.df.get(token.term) || 0
        // 扩散词必须能桥接到其它领域：只出现在当前领域的词扩不出新召回
        if (index.total > 1 && df < 2) continue
        const idf = Math.log(1 + index.total / (1 + df))
        const score = field.weight * token.weight * idf * (hit.score / topScore)
        const previous = candidates.get(token.term)
        if (!previous || score > previous.score) {
          candidates.set(token.term, {
            term: token.term,
            from_export_id: hit.export_id,
            field: field.kind,
            score,
          })
        }
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * 多轮扩散检索。
 * 停止条件：达到 maxRounds、扩展无新词、或新一轮没有新领域。
 */
export function discover(packages, requirement, { topK = 5, maxRounds = 2, expandLimit = 8 } = {}) {
  const seedTerms = tokenize(requirement).slice(0, 12)
  const index = buildIndex(packages)
  const query = new Map(seedTerms.map(item => [item.term, item.weight]))
  const visited = new Set()
  const accumulated = new Map()
  const termsById = new Map()
  const rounds = []
  const expandedTerms = []

  for (let round = 0; round <= maxRounds; round += 1) {
    if (!query.size) break
    const hits = search(index, [...query.entries()].map(([term, weight]) => ({ term, weight })))
    const fresh = hits.filter(hit => !visited.has(hit.export_id))
    rounds.push({
      round,
      query_terms: [...query.keys()],
      hits: hits.slice(0, topK).map(hit => ({
        export_id: hit.export_id,
        score: Number(hit.score.toFixed(2)),
        terms: hit.terms.slice(0, 8),
      })),
      new_domains: fresh.length,
    })
    for (const hit of hits) {
      visited.add(hit.export_id)
      const decayed = hit.score * (0.7 ** round)
      accumulated.set(hit.export_id, Math.max(accumulated.get(hit.export_id) || 0, decayed))
      termsById.set(hit.export_id, [...new Set([...(termsById.get(hit.export_id) || []), ...hit.terms])])
    }
    if (round >= maxRounds || !fresh.length) break
    const additions = expandTerms(index, hits, {
      existing: new Set(query.keys()),
      limit: expandLimit,
    })
    if (!additions.length) break
    for (const item of additions) {
      query.set(item.term, 0.6 / (2 ** round))
      expandedTerms.push(item)
    }
  }

  const candidates = [...accumulated.entries()]
    .map(([exportId, score]) => ({ export_id: exportId, score, terms: termsById.get(exportId) || [] }))
    .sort((a, b) => b.score - a.score)

  return {
    seed_terms: seedTerms.map(item => item.term),
    rounds,
    expanded_terms: expandedTerms,
    candidates,
  }
}

const modelNameOf = (pkg, modelId) => (pkg.models || []).find(model => model.id === modelId)?.name || modelId

/** 无 LLM 时的兜底：只声明关键词能对上的 stub operation，不假装理解契约。 */
export function inferStubMatches(pkg, queryTerms) {
  const matches = []
  const terms = (queryTerms || []).filter(term => String(term).length >= 2)
  for (const stub of pkg.stubs || []) {
    for (const operation of stub.operations || []) {
      const texts = [
        stub.name,
        operation.name,
        ...(operation.request_model_ids || []).map(id => modelNameOf(pkg, id)),
        ...(operation.response_model_ids || []).map(id => modelNameOf(pkg, id)),
      ].map(normalizeText)
      const term = terms.find(item => texts.some(text => text.includes(normalizeText(item))))
      if (!term) continue
      matches.push({
        stub_id: stub.id,
        operation: operation.name,
        reason: `关键词「${term}」命中 ${stub.name}.${operation.name}`,
      })
      if (matches.length >= 5) return matches
    }
  }
  return matches
}

export function deterministicMatches(packages, retrieval, { topK = 5 } = {}) {
  const byId = new Map(packages.map(pkg => [pkg.export_id, pkg]))
  const topScore = retrieval.candidates[0]?.score || 0
  const terms = retrieval.seed_terms.concat(retrieval.expanded_terms.map(item => item.term))
  const matches = retrieval.candidates.slice(0, topK).map(candidate => {
    const pkg = byId.get(candidate.export_id)
    if (!pkg) return null
    const matchedStubs = inferStubMatches(pkg, terms)
    const relative = topScore ? candidate.score / topScore : 0
    return {
      export_id: pkg.export_id,
      domain_id: pkg.domain_id,
      version: pkg.version,
      score: Number(relative.toFixed(2)),
      matched_stubs: matchedStubs,
      missing: [],
      suggested_import: matchedStubs.length > 0 || relative >= 0.75,
    }
  }).filter(Boolean)
  return {
    matches,
    no_match_reason: matches.length ? '' : '注册表中没有匹配的领域能力',
    degraded: true,
    requires_review: true,
  }
}

export function parseJsonLoose(text) {
  const source = String(text || '').trim()
  const candidates = [source]
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {}
  }
  throw new Error(`LLM 未返回合法 JSON：${source.slice(0, 120) || '空内容'}`)
}

/** 严格校验子会话输出：未知 export_id / stub / operation 一律拒绝。 */
export function validateJudgeResult(parsed, packages, { topK = 5 } = {}) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.matches)) {
    throw new Error('检索结果缺少 matches 数组')
  }
  const byId = new Map(packages.map(pkg => [pkg.export_id, pkg]))
  const matches = []
  for (const raw of parsed.matches.slice(0, topK)) {
    const pkg = byId.get(String(raw && raw.export_id))
    if (!pkg) throw new Error(`检索结果含未知 export_id：${raw && raw.export_id}`)
    const matchedStubs = []
    for (const item of (Array.isArray(raw.matched_stubs) ? raw.matched_stubs : []).slice(0, 8)) {
      const stub = (pkg.stubs || []).find(entry => entry.id === item.stub_id)
      if (!stub) throw new Error(`检索结果含未知 stub_id：${item.stub_id}`)
      const operation = (stub.operations || []).find(entry => entry.name === item.operation)
      if (!operation) throw new Error(`检索结果含未知 operation：${stub.name}.${item.operation}`)
      matchedStubs.push({
        stub_id: stub.id,
        operation: operation.name,
        reason: String(item.reason || '').slice(0, 300),
      })
    }
    const score = Number(raw.score)
    matches.push({
      export_id: pkg.export_id,
      domain_id: pkg.domain_id,
      version: pkg.version,
      score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
      matched_stubs: matchedStubs,
      missing: (Array.isArray(raw.missing) ? raw.missing : [])
        .map(item => String(item || '').trim()).filter(Boolean).slice(0, 8),
      suggested_import: raw.suggested_import !== false,
    })
  }
  return {
    matches,
    no_match_reason: String(parsed.no_match_reason || '').trim()
      || (matches.length ? '' : '未找到匹配的领域能力'),
    degraded: false,
    requires_review: false,
  }
}

export function buildJudgeMessages({ requirement, candidates, packages, topK = 5 }) {
  const byId = new Map(packages.map(pkg => [pkg.export_id, pkg]))
  const selected = candidates.slice(0, topK).map(candidate => {
    const pkg = byId.get(candidate.export_id)
    return pkg ? {
      export_id: pkg.export_id,
      domain_id: pkg.domain_id,
      version: pkg.version,
      retrieval_score: Number(candidate.score.toFixed(2)),
      name: pkg.name,
      summary: pkg.summary,
      models: pkg.models,
      stubs: pkg.stubs,
    } : null
  }).filter(Boolean)
  return {
    system: `你是领域能力检索评审员。根据需求判断候选领域是否真正可用，只输出 JSON。
判断依据：
- 需求中的业务动作是否能由候选 Stub 的某个 operation 完成；
- request/response Model 契约是否覆盖需求需要的字段；
- 不能只因为关键词相同就判定匹配，要指出契约缺口。
输出结构：
{"matches":[{"export_id":"","domain_id":"","version":1,"score":0.0,"matched_stubs":[{"stub_id":"","operation":"","reason":""}],"missing":["契约缺口"],"suggested_import":true}],"no_match_reason":""}
约束：
- export_id/stub_id/operation 只能使用候选里真实存在的值；
- 没有匹配时 matches 为空，并填写 no_match_reason；
- 不要输出 Markdown 或解释。`.trim(),
    user: JSON.stringify({ requirement, candidates: selected }, null, 2),
  }
}
