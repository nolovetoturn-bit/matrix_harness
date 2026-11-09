/**
 * rms-domain-registry — 领域能力检索插件（只读）。
 *
 * 读取 flow-runner 产出的能力注册表，执行：
 *   需求关键词 → 首轮召回 → 领域术语扩散 → 二轮召回 → LLM 契约复核。
 *
 * 约束：本插件没有任何写入领域数据 / 导出包的能力。
 *
 * @module rms-domain-registry
 */
import { registryDiscover, registryGet, registryList } from './lib/discover.mjs'

export const id = 'rms-domain-registry'
export const kind = 'generic'
export const description = '只读检索已导出的领域能力：多轮关键词扩散召回，并由只读子会话按契约复核匹配度。'

const dataDir = {
  type: 'string',
  description: '可选数据目录；默认 RMS_MATRIX_DATA_DIR 或 <LOCALAPPDATA>/rms-flow-runner/matrix',
}

const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const tool = (name, description, properties, required, run) => ({
  name,
  description,
  parameters: {
    type: 'object',
    properties: { ...properties, data_dir: dataDir },
    required,
  },
  output,
  run(args, dependencies = {}, context = {}) {
    return run(args, dependencies, context)
  },
})

export const tools = [
  tool(
    'domain_registry_list',
    '列出能力注册表中的领域导出包，可按关键词或领域过滤。只读。Keywords: domain registry, 能力检索, 领域能力列表',
    {
      query: { type: 'string', description: '按能力名 / Model / Stub / operation 过滤' },
      domain_id: { type: 'string', description: '只看某个 provider 领域' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    [],
    (args, _dependencies, _context) => registryList(args),
  ),
  tool(
    'domain_registry_get',
    '读取一个导出包的完整契约（models / stubs / operations），并校验 checksum。只读。Keywords: domain export, 能力契约, get export',
    {
      export_id: { type: 'string', description: 'exp_... 导出包 id' },
    },
    ['export_id'],
    (args, _dependencies, _context) => registryGet(args),
  ),
  tool(
    'domain_discover',
    '按需求检索合适的领域能力：关键词首轮召回 → 领域术语扩散二轮召回 → 只读子会话按 request/response/operation 契约复核。只读，不会导入。Keywords: discover domain, 能力检索, 领域匹配',
    {
      requirement: { type: 'string', description: '业务需求原文' },
      project_id: { type: 'string', description: '可选当前项目 id，仅用于审计' },
      top_k: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回候选数，默认 5' },
      max_rounds: { type: 'integer', minimum: 0, maximum: 3, description: '扩散轮数，默认 2' },
    },
    ['requirement'],
    (args, dependencies, context) => registryDiscover(args, dependencies, context),
  ),
]
