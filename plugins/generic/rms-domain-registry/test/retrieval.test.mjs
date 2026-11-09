import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checksumOf } from '../lib/registry.mjs'
import { discover, tokenize, validateJudgeResult } from '../lib/retrieval.mjs'
import { registryDiscover, registryGet, registryList } from '../lib/discover.mjs'

function makePackage(overrides) {
  const base = {
    export_id: 'exp_order_v1',
    domain_id: 'dom_order',
    version: 1,
    name: '订单履约能力',
    summary: '下单时编排履约流程',
    models: [],
    stubs: [],
    created_at: '2026-11-05T00:00:00.000Z',
    ...overrides,
  }
  return { ...base, checksum: checksumOf(base) }
}

function writeRegistry(dir, packages) {
  const registry = join(dir, 'registry', 'domain-exports')
  mkdirSync(registry, { recursive: true })
  for (const pkg of packages) writeFileSync(join(registry, `${pkg.export_id}.json`), JSON.stringify(pkg), 'utf8')
}

const orderPackage = makePackage({
  export_id: 'exp_order_v1',
  domain_id: 'dom_order',
  name: '订单履约能力',
  summary: '下单时调用库存预留，完成订单履约',
  models: ['PlaceOrderRequest', 'PlaceOrderResponse'].map((name, index) => ({
    id: `mdl_order_${index}`,
    name,
    type: index === 0 ? 'request' : 'response',
    kind: 'dto',
    attributes: [{ name: 'orderId', type: 'string', required: true }],
  })),
  stubs: [{
    id: 'stb_order_1',
    name: 'OrderPort',
    kind: 'domain_service',
    operations: [{ name: 'createOrder', request_model_ids: ['mdl_order_0'], response_model_ids: ['mdl_order_1'] }],
  }],
})

const inventoryPackage = makePackage({
  export_id: 'exp_inventory_v1',
  domain_id: 'dom_inventory',
  version: 1,
  name: '库存预留能力',
  summary: '扣减与释放可用库存',
  models: ['InventoryRequest', 'InventoryResponse'].map((name, index) => ({
    id: `mdl_inventory_${index}`,
    name,
    type: index === 0 ? 'request' : 'response',
    kind: 'dto',
    attributes: [{ name: 'sku', type: 'string', required: true }],
  })),
  stubs: [{
    id: 'stb_inventory_1',
    name: 'InventoryPort',
    kind: 'domain_service',
    operations: [{ name: 'reserve', request_model_ids: ['mdl_inventory_0'], response_model_ids: ['mdl_inventory_1'] }],
  }],
})

test('分词覆盖中文 n-gram 与英文 operation', () => {
  const terms = tokenize('下单后锁定货品，调用 reserve').map(item => item.term)
  assert.ok(terms.includes('下单'))
  assert.ok(terms.includes('货品'))
  assert.ok(terms.includes('reserve'))
  const generic = tokenize('调用库存').find(item => item.term === '调用')
  assert.ok(generic && generic.weight < 0.5, '泛化词应被降权而不是参与主排序')
})

test('多轮扩散：首轮只命中订单域，扩散后召回库存域', () => {
  const retrieval = discover([orderPackage, inventoryPackage], '下单后锁定货品', {
    topK: 5,
    maxRounds: 2,
  })
  assert.ok(retrieval.rounds.length >= 2, '应执行至少两轮检索')
  assert.deepEqual(
    retrieval.rounds[0].hits.map(hit => hit.export_id),
    ['exp_order_v1'],
    '首轮不应直接命中库存域',
  )
  assert.ok(
    retrieval.expanded_terms.some(item => ['库存', '预留'].includes(item.term)),
    '应从订单域扩展出库存/预留术语',
  )
  const ids = retrieval.candidates.map(candidate => candidate.export_id)
  assert.ok(ids.includes('exp_order_v1'))
  assert.ok(ids.includes('exp_inventory_v1'), '二轮应召回库存域')
})

test('只读 registry：list / get 与 checksum 校验', t => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-registry-'))
  try {
    writeRegistry(dir, [orderPackage])
    const listed = JSON.parse(registryList({ data_dir: dir, query: '库存' }))
    assert.equal(listed.total, 1)
    assert.equal(listed.exports[0].export_id, 'exp_order_v1')
    assert.equal(listed.exports[0].stub_count, 1)
    assert.equal(JSON.parse(registryGet({ data_dir: dir, export_id: 'exp_order_v1' })).checksum, orderPackage.checksum)

    const file = join(dir, 'registry', 'domain-exports', 'exp_order_v1.json')
    const tampered = { ...orderPackage, name: '被篡改的能力' }
    writeFileSync(file, JSON.stringify(tampered), 'utf8')
    assert.throws(() => registryGet({ data_dir: dir, export_id: 'exp_order_v1' }), /校验失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('无 LLM 时降级为关键词结果', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-discover-'))
  try {
    writeRegistry(dir, [orderPackage, inventoryPackage])
    const result = JSON.parse(await registryDiscover({
      data_dir: dir,
      requirement: '下单后锁定货品',
      top_k: 3,
      max_rounds: 2,
    }))
    assert.equal(result.degraded, true)
    assert.ok(result.warnings.some(item => item.includes('关键词')))
    assert.ok(result.matches.some(match => match.export_id === 'exp_inventory_v1'))
    assert.ok(result.retrieval.rounds.length >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LLM 复核路径：返回契约匹配与缺口', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-review-'))
  try {
    writeRegistry(dir, [orderPackage, inventoryPackage])
    const reviewer = async ({ system, user }) => {
      const payload = JSON.parse(user)
      assert.ok(system.includes('领域能力检索评审员'))
      assert.ok(payload.candidates.some(item => item.export_id === 'exp_inventory_v1'))
      return JSON.stringify({
        matches: [{
          export_id: 'exp_inventory_v1',
          score: 0.9,
          matched_stubs: [{ stub_id: 'stb_inventory_1', operation: 'reserve', reason: '可预留库存' }],
          missing: ['需求还需要释放库存 operation'],
          suggested_import: true,
        }],
        no_match_reason: '',
      })
    }
    const result = JSON.parse(await registryDiscover({
      data_dir: dir,
      requirement: '下单后锁定货品',
      top_k: 3,
    }, { reviewWithAgent: reviewer }))
    assert.equal(result.degraded, false)
    assert.equal(result.matches[0].domain_id, 'dom_inventory')
    assert.deepEqual(result.matches[0].missing, ['需求还需要释放库存 operation'])
    assert.ok(result.retrieval.expanded_terms.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LLM 结果校验拒绝不存在的 stub / operation', () => {
  assert.throws(() => validateJudgeResult({
    matches: [{
      export_id: 'exp_order_v1',
      matched_stubs: [{ stub_id: 'stb_missing', operation: 'reserve', reason: 'x' }],
    }],
  }, [orderPackage]), /未知 stub_id/)
  assert.throws(() => validateJudgeResult({
    matches: [{
      export_id: 'exp_missing',
      matched_stubs: [],
    }],
  }, [orderPackage]), /未知 export_id/)
})

test('LLM 结果通过校验后保留契约缺口', () => {
  const result = validateJudgeResult({
    matches: [{
      export_id: 'exp_order_v1',
      score: 0.8,
      matched_stubs: [{ stub_id: 'stb_order_1', operation: 'createOrder', reason: '能创建订单' }],
      missing: ['缺少库存锁定 operation'],
      suggested_import: true,
    }],
    no_match_reason: '',
  }, [orderPackage])
  assert.equal(result.degraded, false)
  assert.equal(result.matches[0].domain_id, 'dom_order')
  assert.equal(result.matches[0].version, 1)
  assert.deepEqual(result.matches[0].missing, ['缺少库存锁定 operation'])
})
