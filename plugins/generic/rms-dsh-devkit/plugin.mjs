/**
 * rms-dsh-devkit — 插件开发工具集（可移植清单 + 零依赖实现）。
 *
 * 把 docs/dsh-plugin-spec.md 的工作流做成三个可调用工具：
 *   classify_plugin  按 §1 判据判定 generic / project
 *   scaffold_plugin  按 §2/§3/§4 生成骨架并登记进 dsh/cordis.yml
 *   validate_plugin  按 §8/§9 校验契约与不变量
 *
 * 约束同 §3：零依赖，只允许 node: 内置导入与相对路径导入；不做宿主绑定。
 *
 * @module rms-dsh-devkit
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件标识。 */
export const id = 'rms-dsh-devkit'

/** 通用插件：不依赖本项目特定领域知识。 */
export const kind = 'generic'

/** 一句话说明。 */
export const description = 'dsh 插件开发工具集：分类判定、骨架生成、契约校验，对应 docs/dsh-plugin-spec.md 的标准工作流。'

/** 项目根目录（本文件位于 plugins/generic/rms-dsh-devkit/plugin.mjs）。 */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 规约文件（相对项目根）。 */
const SPEC_FILE = 'docs/dsh-plugin-spec.md'

/** 项目级 dsh 覆盖层（相对项目根）。 */
const OVERLAY_FILE = 'dsh/cordis.yml'

/** 插件落位根（相对项目根）。 */
const PLUGIN_ROOTS = ['plugins/generic', 'plugins/project']

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 规整为 kebab-case。 */
function toKebab(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 规整为带 rms- 前缀的插件 id；无 ASCII 字母/数字时返回 null。 */
function deriveId(name) {
  const kebab = toKebab(name)
  if (kebab === '') return null
  return kebab.startsWith('rms-') ? kebab : `rms-${kebab}`
}

/** 覆盖层是否已登记该 id（按行精确匹配，避免 rms-a 命中 rms-a-b）。 */
function isRegistered(overlay, pluginId) {
  return overlay.split(/\r?\n/).some(line => line.trim() === `- id: ${pluginId}`)
}

/** 插件目录绝对路径。 */
function pluginDir(kind, pluginId) {
  return join(projectRoot, 'plugins', kind, pluginId)
}

/** 递归收集目录下指定后缀的文件（返回绝对路径）。 */
function collectFiles(dir, suffix) {
  const found = []
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectFiles(full, suffix))
    else if (entry.name.endsWith(suffix)) found.push(full)
  }
  return found
}

/** 从源码文本中提取全部 import 说明符。 */
function importSpecifiers(source) {
  const specs = []
  const re = /(?:^|\n)\s*import\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g
  let match
  while ((match = re.exec(source)) !== null) specs.push(match[1])
  return specs
}

/** 说明符是否自足（node: 内置或相对路径）。 */
function isSelfContainedSpecifier(spec) {
  return spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')
}

/** 扫描全部插件的 plugin.mjs。 */
async function discoverPlugins() {
  const plugins = []
  for (const rel of PLUGIN_ROOTS) {
    const root = join(projectRoot, rel)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = join(root, entry.name, 'plugin.mjs')
      if (!existsSync(manifest)) continue
      plugins.push({
        id: entry.name,
        kindPath: rel === 'plugins/generic' ? 'generic' : 'project',
        dir: join(root, entry.name),
        manifest,
      })
    }
  }
  return plugins
}

/** 读取项目覆盖层文本。 */
function readOverlay() {
  const file = join(projectRoot, OVERLAY_FILE)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** 生成 dsh/host.mjs 内容。 */
function hostTemplate() {
  return `/**
 * dsh 适配器：把 plugin.mjs 的 tools 注册到 ctx.tools。
 * 由 rms-dsh-devkit 生成，只做宿主绑定，业务逻辑留在 plugin.mjs。
 *
 * @module dsh-host
 */

import * as core from '../plugin.mjs'

/** 插件标识，供 Loader 行与日志识别。 */
export const name = core.id

/** 依赖的服务：工具注册表就绪后再调用 apply。 */
export const inject = ['tools']

/**
 * 注册本插件的全部工具。
 * @param {object} ctx Cordis 上下文；\`ctx.tools\` 已由 inject 保证就绪。
 */
export function apply(ctx) {
  for (const tool of core.tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
      execute: args => tool.run(args),
    })
  }
  console.log(\`[\${core.id}] plugin loaded (\${core.tools.length} tools)\`)
}
`
}

/** 生成 plugin.mjs 内容。 */
function manifestTemplate(pluginId, pluginKind, pluginDescription, toolSpecs) {
  const toolBlocks = toolSpecs
    .map(
      spec => `  {
    name: ${JSON.stringify(spec.name)},
    description: ${JSON.stringify(spec.description)},
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    run(_args) {
      // TODO: 实现 ${spec.name}
      throw new Error('${spec.name} 尚未实现')
    },
  },`,
    )
    .join('\n')

  return `/**
 * ${pluginId} — 可移植清单 + 零依赖实现。由 rms-dsh-devkit 生成，契约见 docs/dsh-plugin-spec.md §3。
 *
 * @module ${pluginId}
 */

/** 插件标识，kebab-case，与目录名一致。 */
export const id = '${pluginId}'

/** 插件类别。 */
export const kind = '${pluginKind}'

/** 一句话说明。 */
export const description = ${JSON.stringify(pluginDescription)}

/** 模型可见工具清单。 */
export const tools = [
${toolBlocks}
]
`
}

/** 生成 README.md 内容。 */
function readmeTemplate(pluginId, pluginKind, pluginDescription, toolSpecs) {
  const rows = toolSpecs.map(spec => `| \`${pluginId}__${spec.name}\` | ${spec.description} |`).join('\n')
  return `# ${pluginId}（${pluginKind === 'generic' ? '通用插件' : '面向项目的特定插件'}）

${pluginDescription}

规约见 [\`docs/dsh-plugin-spec.md\`](../../../docs/dsh-plugin-spec.md)。

## 文件

| 文件 | 角色 |
|---|---|
| \`plugin.mjs\` | 可移植清单 + 零依赖实现 |
| \`dsh/host.mjs\` | dsh 适配器：把 \`tools\` 注册到 \`ctx.tools\` |

## 工具（MCP 全名）

| 工具 | 说明 |
|---|---|
${rows}

## 接入与验证

dsh 侧由项目覆盖层 [\`dsh/cordis.yml\`](../../../dsh/cordis.yml) 登记；MCP 侧由 \`mcp/server.mjs\` 自动扫描。

\`\`\`powershell
# dsh 冒烟（cwd 必须是 deepseek-harness/）
"" | pnpm dsh acp --patch "C:/Users/admin/Documents/trae_projects/rms_dsh/dsh/cordis.yml"

# MCP 平面
node "C:/Users/admin/Documents/trae_projects/rms_dsh/mcp/server.mjs"
\`\`\`
`
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/** classify_plugin：按 §1 三问判定类别。 */
function classifyPlugin(args) {
  const pluginId = deriveId(args.name)
  const rationale = []
  let pluginKind

  if (args.touches_project_state === true) {
    pluginKind = 'project'
    rationale.push('命中判据 1：读写本项目特有领域数据/路径/业务流程 → project')
  } else if (args.reusable_outside_project === true) {
    pluginKind = 'generic'
    rationale.push('命中判据 2：可跨项目原样复用，只依赖通用能力 → generic')
  } else {
    pluginKind = 'generic'
    rationale.push('判据 1/2 均未命中 → 按 §1 判据 3 默认 generic')
    rationale.push('例外：若该插件脱离项目上下文就会给出错误结果，应改判 project 并说明理由')
  }

  if (pluginId === null) {
    rationale.push('插件名不含 ASCII 字母/数字，无法自动规整出 id；请显式给出 ASCII 名（如 "rms-order-export"）')
  } else if (pluginId !== toKebab(args.name)) {
    rationale.push(`id 已规整为 ${pluginId}（kebab-case + rms- 前缀）`)
  }

  const report = [
    `需求：${args.description}`,
    `判定：**${pluginKind}**（${pluginKind === 'generic' ? '通用插件' : '面向项目的特定插件'}）`,
    `落位：plugins/${pluginKind}/${pluginId ?? '<请指定 ASCII 插件名>'}/`,
    '',
    '理由：',
    ...rationale.map(line => `- ${line}`),
    '',
    '后续步骤（§7）：',
    pluginId === null
      ? '1. 先确定 ASCII 插件名，再调用 scaffold_plugin'
      : `1. scaffold_plugin({ id: "${pluginId}", kind: "${pluginKind}", description: …, tools: [...] })`,
    '2. 实现 plugin.mjs 中各工具的 run / render',
    '3. validate_plugin({ id })',
    '4. 跑 §8 的 dsh 与 MCP 两条验证命令',
  ].join('\n')

  return {
    kind: pluginKind,
    id: pluginId,
    dir: pluginId === null ? null : `plugins/${pluginKind}/${pluginId}`,
    report,
  }
}

/** scaffold_plugin：生成骨架并登记覆盖层。 */
function scaffoldPlugin(args) {
  const pluginId = deriveId(args.id ?? args.name ?? '')
  if (pluginId === null) {
    throw new Error('需要一个含 ASCII 字母/数字的插件名，例如 id: "rms-my-tool"')
  }
  const pluginKind = args.kind ?? 'generic'
  if (pluginKind !== 'generic' && pluginKind !== 'project') {
    throw new Error(`kind 必须是 'generic' 或 'project'，收到 '${pluginKind}'`)
  }
  const toolSpecs = (args.tools ?? []).map(spec => ({
    name: toKebab(spec.name ?? '').replace(/-/g, '_'),
    description: spec.description ?? '',
  }))
  if (toolSpecs.length === 0) throw new Error('至少需要一个工具：tools: [{ name, description }]')
  const duplicate = toolSpecs.map(s => s.name).filter((n, i, all) => all.indexOf(n) !== i)
  if (duplicate.length > 0) throw new Error(`工具名重复：${duplicate.join(', ')}`)

  const dir = pluginDir(pluginKind, pluginId)
  const created = []
  const skipped = []

  const writes = [
    ['plugin.mjs', manifestTemplate(pluginId, pluginKind, args.description ?? '', toolSpecs)],
    [join('dsh', 'host.mjs'), hostTemplate()],
    ['README.md', readmeTemplate(pluginId, pluginKind, args.description ?? '', toolSpecs)],
  ]
  for (const [rel, content] of writes) {
    const target = join(dir, rel)
    if (existsSync(target)) {
      skipped.push(rel)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
    created.push(rel)
  }

  // 登记覆盖层：按 id 幂等，避免重复插入行。
  const overlayPath = join(projectRoot, OVERLAY_FILE)
  let overlayNote
  if (!existsSync(overlayPath)) {
    overlayNote = `覆盖层不存在，已跳过登记：请手工创建 ${OVERLAY_FILE}`
  } else if (isRegistered(readOverlay(), pluginId)) {
    overlayNote = `${OVERLAY_FILE} 已包含 ${pluginId}，未改动`
  } else {
    const url = pathToFileURL(join(dir, 'dsh', 'host.mjs')).href
    const before = readFileSync(overlayPath, 'utf8')
    const separator = before.endsWith('\n') ? '' : '\n'
    writeFileSync(
      overlayPath,
      `${before}${separator}    - id: ${pluginId}\n      name: '${url}'\n`,
      'utf8',
    )
    overlayNote = `已在 ${OVERLAY_FILE} 的 insert 块追加 ${pluginId} 行`
  }

  const report = [
    `已生成 ${pluginId}（${pluginKind}）于 plugins/${pluginKind}/${pluginId}/`,
    created.length > 0 ? `新建：${created.join(', ')}` : '新建：无',
    skipped.length > 0 ? `已存在、未覆盖：${skipped.join(', ')}` : '',
    overlayNote,
    '',
    '下一步：实现 plugin.mjs 里各工具的 run / render，然后 validate_plugin + 跑 §8 验证命令。',
    `告警：${pluginId} 的工具 run() 目前是 TODO 桩，直接调用会抛错。`,
  ]
    .filter(Boolean)
    .join('\n')

  return { id: pluginId, kind: pluginKind, dir: `plugins/${pluginKind}/${pluginId}`, created, skipped, report }
}

/** validate_plugin：校验契约与不变量。 */
async function validatePlugin(args) {
  const all = await discoverPlugins()
  const targets = args.id ? all.filter(p => p.id === deriveId(args.id)) : all
  if (targets.length === 0) {
    throw new Error(args.id ? `未找到插件 ${deriveId(args.id)}` : '未发现任何插件')
  }

  const overlay = readOverlay()
  const reports = []
  let failures = 0

  for (const target of targets) {
    const issues = []
    const notes = []

    // 静态：目录内容与导入自足性
    const mjsFiles = collectFiles(target.dir, '.mjs')
    if (mjsFiles.length === 0) issues.push('目录下没有任何 .mjs 文件')
    for (const file of mjsFiles) {
      const source = readFileSync(file, 'utf8')
      const rel = relative(target.dir, file).replace(/\\/g, '/')
      for (const spec of importSpecifiers(source)) {
        if (!isSelfContainedSpecifier(spec)) {
          issues.push(`${rel}: 非自足导入 '${spec}'（只允许 node: 内置或相对路径）`)
        }
      }
      if (/from\s+['"]@deepseek-ai\//.test(source)) {
        issues.push(`${rel}: 禁止导入 @deepseek-ai/*（仓库外解析不到，见 §0）`)
      }
    }
    if (!existsSync(join(target.dir, 'dsh', 'host.mjs'))) issues.push('缺少 dsh/host.mjs')
    if (!existsSync(join(target.dir, 'README.md'))) issues.push('缺少 README.md')

    // 动态：清单契约
    let manifest
    try {
      manifest = await import(`${pathToFileURL(target.manifest).href}?v=${Date.now()}`)
    } catch (error) {
      issues.push(`plugin.mjs 加载失败：${error.message}`)
    }
    if (manifest) {
      if (manifest.id !== target.id) issues.push(`导出 id '${manifest.id}' 与目录名 '${target.id}' 不一致`)
      if (!/^rms-[a-z0-9-]+$/.test(String(manifest.id))) issues.push(`id '${manifest.id}' 不是 rms- 前缀的 kebab-case`)
      if (manifest.kind !== target.kindPath) issues.push(`导出 kind '${manifest.kind}' 与目录分类 '${target.kindPath}' 不一致`)
      if (!manifest.description) issues.push('缺少 description')
      if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) issues.push('tools 必须是非空数组')

      const seen = new Set()
      for (const tool of manifest.tools ?? []) {
        const label = `tool '${tool?.name}'`
        if (!/^[a-z][a-z0-9_]*$/.test(String(tool?.name))) issues.push(`${label}: name 必须是 snake_case`)
        if (seen.has(tool?.name)) issues.push(`${label}: 插件内工具名重复`)
        seen.add(tool?.name)
        if (!tool?.description) issues.push(`${label}: 缺少 description`)
        if (tool?.parameters?.type !== 'object') issues.push(`${label}: parameters 根必须是 type: 'object'`)
        if (typeof tool?.run !== 'function') issues.push(`${label}: 缺少 run()`)
        if (typeof tool?.output?.render !== 'function') issues.push(`${label}: 缺少 output.render()`)
        if (typeof tool?.output?.schema !== 'object') issues.push(`${label}: 缺少 output.schema`)
      }
      if (seen.size > 0) notes.push(`工具 ${seen.size} 个：${[...seen].join(', ')}`)
    }

    // 跨插件重名
    const others = new Set()
    for (const other of all) {
      if (other.id === target.id) continue
      try {
        const mod = await import(pathToFileURL(other.manifest).href)
        for (const tool of mod.tools ?? []) others.add(`${other.id}__${tool.name}`)
      } catch {
        /* 其它插件自身的问题由它自己那一轮报告 */
      }
    }
    for (const tool of manifest?.tools ?? []) {
      if (others.has(`${target.id}__${tool.name}`)) issues.push(`tool '${tool.name}' 与其它插件重名`)
    }

    // 覆盖层登记
    if (!isRegistered(overlay, target.id)) {
      issues.push(`${OVERLAY_FILE} 未登记该插件（缺少 "- id: ${target.id}" 行）`)
    } else {
      notes.push(`${OVERLAY_FILE} 已登记`)
    }

    failures += issues.length
    reports.push(
      [
        `### ${target.id}（${target.kindPath}）— ${issues.length === 0 ? '通过' : `${issues.length} 项问题`}`,
        ...notes.map(n => `- ${n}`),
        ...issues.map(i => `- ❌ ${i}`),
      ].join('\n'),
    )
  }

  const report = [
    `校验范围：${targets.length} 个插件（规约 ${SPEC_FILE} §8/§9）`,
    failures === 0 ? '结论：全部通过' : `结论：共 ${failures} 项问题待修`,
    '',
    ...reports,
  ].join('\n')

  return { ok: failures === 0, checked: targets.length, failures, report }
}

// ---------------------------------------------------------------------------
// 导出契约
// ---------------------------------------------------------------------------

export const tools = [
  {
    name: 'classify_plugin',
    description:
      '按 docs/dsh-plugin-spec.md §1 的三条判据，判定待开发插件属于通用插件(generic)还是面向项目的特定插件(project)，并给出落位与后续步骤。' +
      '触发场景：新建或改造 dsh 插件前的分类判定。' +
      'Keywords: classify plugin, generic or project, plugin classification.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '插件名（任意写法，工具会规整为 rms- 前缀的 kebab-case id）' },
        description: { type: 'string', description: '需求描述' },
        touches_project_state: {
          type: 'boolean',
          description: '是否读写本项目特有的领域数据、路径或业务流程（rms 业务实体、项目目录约定、专有配置）',
        },
        reusable_outside_project: {
          type: 'boolean',
          description: '是否可跨项目/跨仓库原样复用（只依赖通用能力）',
        },
      },
      required: ['name', 'description'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          id: { type: 'string' },
          dir: { type: 'string' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    run: classifyPlugin,
  },
  {
    name: 'scaffold_plugin',
    description:
      '按 docs/dsh-plugin-spec.md §2/§3/§4 生成插件骨架（plugin.mjs / dsh/host.mjs / README.md），并把该插件幂等登记进项目覆盖层 dsh/cordis.yml。已存在的文件不会被覆盖。' +
      '触发场景：新建一个 dsh 插件骨架。' +
      'Keywords: scaffold plugin, create dsh plugin, generate plugin skeleton.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '插件 id（缺省时由 name 规整）' },
        name: { type: 'string', description: '插件名，当 id 缺省时用于规整出 id' },
        kind: { type: 'string', enum: ['generic', 'project'], description: '插件类别，默认 generic' },
        description: { type: 'string', description: '插件用途说明' },
        tools: {
          type: 'array',
          description: '要生成的工具清单（至少一个）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工具名，snake_case' },
              description: { type: 'string', description: '工具用途' },
            },
            required: ['name', 'description'],
          },
        },
      },
      required: ['tools'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          dir: { type: 'string' },
          created: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    run: scaffoldPlugin,
  },
  {
    name: 'validate_plugin',
    description:
      '按 docs/dsh-plugin-spec.md §8/§9 校验插件：零依赖与 import 自足性、id/kind/目录一致性、工具契约完整性、跨插件重名、覆盖层登记情况。省略 id 则校验全部插件。' +
      '触发场景：校验 dsh 插件是否合规 / 契约自检。' +
      'Keywords: validate plugin, lint dsh plugin, contract check.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要校验的插件 id（省略则校验全部插件）' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          checked: { type: 'number' },
          failures: { type: 'number' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    run: validatePlugin,
  },
]
