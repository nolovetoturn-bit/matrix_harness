/**
 * rms-worklog — 工作日志记录与检索。契约见 docs/dsh-plugin-spec.md §3。
 *
 * 作用：让任意会话中的 Agent 把用户要求记录的工作日志写成结构化条目，并提供
 * 关键词 + 元数据过滤的检索能力（时间 / 项目 / 标签 / 人员 / 类型）。
 *
 * 存储：Markdown 条目为唯一真源，SQLite FTS5(trigram) 为可重建索引。
 * 分工：本文件只做参数校验与渲染，存储/索引实现见 lib/store.mjs。
 *
 * @module rms-worklog
 */

import * as store from './lib/store.mjs'
import * as logkeeper from './lib/logkeeper.mjs'

/** 插件标识，kebab-case，与目录名一致。 */
export const id = 'rms-worklog'

/** 插件类别：与 rms 领域无关、脱离本项目仍可原样复用 → generic。 */
export const kind = 'generic'

/** 一句话说明。 */
export const description =
  '记录与检索本机工作日志：把会话内容沉淀为结构化 Markdown 条目（标题/正文/项目/标签/人员/类型），' +
  '并按关键词 + 时间/项目/标签过滤检索。数据存储在本地，不依赖外部服务。'

/* ------------------------------------------------------------------ */
/* 渲染辅助                                                            */
/* ------------------------------------------------------------------ */

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

function line(...parts) {
  return parts.filter(p => p !== undefined && p !== null && p !== '').join('  ')
}

function tagText(tags) {
  return (tags || []).length ? tags.map(t => `#${t}`).join(' ') : ''
}

function errorText(title, err) {
  return `${title}失败：${err && err.message ? err.message : String(err)}`
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

const worklogAdd = {
  name: 'worklog_add',
  description:
    '把一段工作内容记录为结构化工作日志（Markdown 条目 + 本地索引）。由 Agent 先提炼标题与正文，再调用本工具落盘；' +
    '同一日期 + 标题 + 正文重复写入会自动去重并返回已有 id。正文中的 `- [ ] xxx` 或「待办/下一步」小节列表项会被提取为待推进任务。' +
    '触发场景：记录工作日志、写日报素材、记录完成事项/决定/问题、把本次会话沉淀成日志、帮我记一下今天做了什么。' +
    'Keywords: worklog add, write journal, daily log, record work, memo, note, 记日志 工作记录',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '日志标题（一句话，建议不超过 40 字）' },
      content: { type: 'string', description: '日志正文（Markdown；写清完成情况、结论、待办）' },
      date: { type: 'string', description: '日志归属日期 YYYY-MM-DD；缺省 = 今天（本地时区）' },
      project: { type: 'string', description: '所属项目/模块，如 rms_dsh' },
      kind: {
        type: 'string',
        description: '日志类型，如 done（完成）/ decision（决定）/ issue（问题）/ meeting（会议）/ note（随手记）；缺省 note',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签数组（建议小写、短词），用于后续过滤',
      },
      people: {
        type: 'array',
        items: { type: 'string' },
        description: '相关人员姓名数组',
      },
      source: { type: 'string', description: '来源标记，如 trae-session:<会话标识> 或任务号' },
      force: { type: 'boolean', description: '为 true 时跳过内容去重，强制新增一条' },
    },
    required: ['title', 'content'],
  },
  output: textOutput,
  async run(args) {
    try {
      const entry = store.addEntry(args || {})
      return [
        entry.duplicate ? '工作日志已存在（内容相同，未重复写入）。' : '工作日志已写入。',
        line('· id：', entry.id),
        line('· 日期：', entry.date),
        line('· 标题：', entry.title),
        line('· 项目/类型：', entry.project || '(未填)', '/', entry.kind || 'note'),
        line('· 标签：', tagText(entry.tags) || '(无)'),
        line('· 人员：', (entry.people || []).join('、') || '(无)'),
        line('· 文件：', entry.path),
        line('· 索引：', entry.indexed ? '已同步' : '未同步（可调用 worklog_reindex 重建）'),
      ].join('\n')
    } catch (err) {
      return errorText('写入工作日志', err)
    }
  },
}

const worklogSearch = {
  name: 'worklog_search',
  description:
    '检索工作日志：关键词（中文子串可用）+ 时间范围 + 项目 + 标签 + 人员 + 类型过滤，返回匹配条目的 id、摘要片段与路径。' +
    '多关键词用空格分隔，要求全部命中。触发场景：查工作日志、搜索之前做过什么、按项目/标签找记录、整理某段时间的工作、找历史决定或问题。' +
    'Keywords: worklog search, query logs, find journal, history, filter by tag project date, 搜索日志 查工作记录',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词；多个词用空格分隔（全部命中）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
      project: { type: 'string', description: '按项目精确过滤' },
      kind: { type: 'string', description: '按日志类型精确过滤' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签过滤（多个标签要求全部命中）',
      },
      people: {
        type: 'array',
        items: { type: 'string' },
        description: '人员过滤（多个人员要求全部命中）',
      },
      limit: { type: 'integer', description: '最多返回多少条（默认 10，最大 50）' },
    },
  },
  output: textOutput,
  async run(args) {
    try {
      const res = store.searchEntries(args || {})
      if (!res.total) {
        return [
          '工作日志检索：没有匹配条目。',
          line('· 关键词：', res.query || '(无)'),
          '提示：可减少关键词、放宽日期范围或去掉标签过滤后再试。',
        ].join('\n')
      }
      const head = `工作日志检索：命中 ${res.total} 条` +
        (res.query ? `（关键词：${res.query}）` : '（最近条目）')
      const body = res.items.map(item => {
        const meta = line(
          `[${item.date}]`,
          item.project ? `{${item.project}}` : '',
          item.kind ? `<${item.kind}>` : '',
          tagText(item.tags),
        ).replace(/\s+/g, ' ').trim()
        return [
          `· ${item.title}`,
          `  ${meta}`,
          `  id: ${item.id}`,
          item.snippet ? `  ${item.snippet}` : '',
        ].filter(Boolean).join('\n')
      }).join('\n')
      return `${head}\n${body}`
    } catch (err) {
      return errorText('检索工作日志', err)
    }
  },
}

const worklogGet = {
  name: 'worklog_get',
  description:
    '按 id 读取一篇工作日志的完整正文与元信息，可选返回同一天前后若干条。触发场景：打开某篇日志、查看日志全文、看某天前后记录、获取日志详情。' +
    'Keywords: worklog get, read entry, full text, detail, 日志详情 查看日志',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '日志 id（worklog_search / worklog_recent 返回）' },
      neighbors: { type: 'integer', description: '附带同一天前后各多少条（0-5，默认 0）' },
    },
    required: ['id'],
  },
  output: textOutput,
  async run(args) {
    try {
      const entry = store.getEntry(args.id, args.neighbors)
      if (!entry) return `未找到工作日志：${args.id}`
      const lines = [
        `# ${entry.title}`,
        line('· id：', entry.id),
        line('· 日期：', entry.date),
        line('· 创建时间：', entry.created_at),
        line('· 项目/类型：', entry.project || '(未填)', '/', entry.kind || 'note'),
        line('· 标签：', tagText(entry.tags) || '(无)'),
        line('· 人员：', (entry.people || []).join('、') || '(无)'),
        line('· 来源：', entry.source || '(未填)'),
        line('· 文件：', entry.path, entry.from_disk ? '' : '（文件缺失，显示索引副本）'),
        '',
        entry.content,
      ]
      if ((entry.neighbors || []).length) {
        lines.push('', '同一天前后条目：')
        for (const n of entry.neighbors) {
          lines.push(`· ${n.current ? '▶ ' : '  '}[${n.date}] ${n.title}  (${n.id})`)
        }
      }
      return lines.join('\n')
    } catch (err) {
      return errorText('读取工作日志', err)
    }
  },
}

const worklogRecent = {
  name: 'worklog_recent',
  description:
    '列出最近若干天的工作日志（按日期倒序），用于写日报/周报或回顾近期工作。触发场景：最近日志、本周做了什么、写日报素材、近期工作总结。' +
    'Keywords: recent worklogs, latest entries, weekly report, daily summary, 最近日志 近期工作',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '回溯天数（默认 7，最大 365）' },
      limit: { type: 'integer', description: '最多返回多少条（默认 20，最大 100）' },
      project: { type: 'string', description: '按项目精确过滤' },
    },
  },
  output: textOutput,
  async run(args) {
    try {
      const res = store.recentEntries(args || {})
      if (!res.total) return `最近 ${res.days} 天（${res.from} 起）没有工作日志。`
      const lines = [`最近 ${res.days} 天工作日志：${res.total} 条（${res.from} 起）`]
      for (const item of res.items) {
        lines.push(line(
          `· [${item.date}]`,
          item.title,
          item.project ? `{${item.project}}` : '',
          item.kind ? `<${item.kind}>` : '',
          tagText(item.tags),
        ).replace(/\s+/g, ' ').trim())
      }
      return lines.join('\n')
    } catch (err) {
      return errorText('读取最近工作日志', err)
    }
  },
}

const worklogStats = {
  name: 'worklog_stats',
  description:
    '统计工作日志：总条数，以及按项目 / 标签 / 类型 / 月份分组计数。触发场景：工作统计、日志概览、哪个项目记录最多、月度回顾、标签分布。' +
    'Keywords: worklog stats, statistics, count by project tag month, overview, 日志统计 工作概览',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
      project: { type: 'string', description: '只看某个项目' },
      group_by: {
        type: 'string',
        enum: ['project', 'tag', 'kind', 'month'],
        description: '分组维度（默认 project）',
      },
    },
  },
  output: textOutput,
  async run(args) {
    try {
      const res = store.stats(args || {})
      const head = `工作日志统计：共 ${res.total} 条（按 ${res.group_by} 分组）`
      if (!res.total) return `${head}\n（范围内没有日志）`
      const body = res.groups.map(g => `· ${g.name || '(未填)'}：${g.count}`).join('\n')
      return `${head}\n${body}`
    } catch (err) {
      return errorText('统计工作日志', err)
    }
  },
}

const worklogTodo = {
  name: 'worklog_todo',
  description:
    '查看或关闭「待推进任务」：从所有日志正文提取未完成的 `- [ ]` 复选框，以及「待办/下一步/TODO」小节下的列表项。' +
    'action=list 列出未完成项（最早写入的在前）；action=done 把指定项在源 Markdown 里勾选并同步索引。' +
    '触发场景：有哪些待办、待推进任务、把某件事标记完成、勾掉这条待办。' +
    'Keywords: todo list, pending tasks, mark done, checkbox, 待办 待推进 标记完成',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'done'],
        description: 'list（默认）=列出未完成；done=标记完成',
      },
      todo_id: { type: 'string', description: 'action=done 时必填，形如 <entryId>#<seq>' },
      days: { type: 'integer', description: 'list：只看最近多少天的日志（0=不限，默认 0）' },
      limit: { type: 'integer', description: 'list：最多返回多少条（默认 20，最大 100）' },
      project: { type: 'string', description: '按项目精确过滤' },
    },
    required: [],
  },
  output: textOutput,
  async run(args) {
    try {
      const action = String(args.action || 'list')
      if (action === 'done') {
        if (!args.todo_id) return '标记完成失败：缺少 todo_id（形如 <entryId>#<seq>）'
        const res = store.completeTodo(args.todo_id)
        return [
          res.already_done ? '该待办已经是完成状态。' : '已标记完成。',
          line('· 待办：', res.text),
          line('· 日志：', `[${res.date}] ${res.entry_title}`),
          line('· 文件：', res.path),
        ].join('\n')
      }

      const res = store.listTodos(args || {})
      if (!res.total) {
        return '没有未完成的待办。\n提示：在日志正文里写 `- [ ] 任务内容`（或放到「## 待办」小节）后再查。'
      }
      const groups = new Map()
      for (const item of res.items) {
        const key = item.project || '(未填项目)'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(item)
      }
      const lines = [`待推进任务：共 ${res.total} 条未完成${res.total > res.items.length ? `，显示前 ${res.items.length} 条` : ''}（最早写入的在前）`]
      for (const [project, items] of groups) {
        lines.push(`{${project}}`)
        for (const item of items) {
          lines.push(`· [${item.date} · ${item.age_days} 天前] ${item.text}`)
          lines.push(`  todo: ${item.id}  日志：[${item.date}] ${item.entry_title}`)
        }
      }
      return lines.join('\n')
    } catch (err) {
      return errorText('处理待办', err)
    }
  },
}

const worklogReview = {
  name: 'worklog_review',
  description:
    '「现在该干嘛」：由插件自带的日志管理员 LLM 在内部读取待办与最近日志，输出优先级排序的待推进任务和需要用户确认的问题。' +
    '日志原始内容不进入当前会话上下文，只返回蒸馏结论；LLM 不可用时自动退回结构化待办列表。' +
    '触发场景：现在该干嘛、接下来做什么、今天先做哪个、有哪些任务要推进、帮我理一下当前重点。' +
    'Keywords: what should I do now, next task, priorities, review logs, daily focus, 现在该干嘛 接下来做什么 待推进 当前重点',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '最近日志窗口（默认 14 天，最大 365）' },
      project: { type: 'string', description: '只看某个项目' },
    },
  },
  output: textOutput,
  async run(args) {
    try {
      const res = await logkeeper.review(args || {})
      const lines = ['现在该干嘛（日志管理员）', '']
      if (!res.llm_used) {
        lines.push(`· LLM 不可用：${res.error || '未知原因'}（已退回结构化待办）`)
      } else {
        lines.push(`· LLM：${res.model}`)
      }
      lines.push(`· 上下文：近 ${res.stats.days} 天 ${res.stats.recent_entries} 篇日志 / ${res.stats.open_todos} 条未完成待办`)
      lines.push('', res.summary || '(无摘要)')
      if (res.tasks.length) {
        lines.push('', '优先推进：')
        const labels = { high: '高', medium: '中', low: '低' }
        res.tasks.forEach((task, i) => {
          lines.push(`${i + 1}. [${labels[task.priority] || '中'}] ${task.title}`)
          if (task.why) lines.push(`   依据：${task.why}`)
          const refs = (task.source_ids || []).join(', ')
          lines.push(`   引用：${refs || '(无)'}${task.todo_id ? `  todo: ${task.todo_id}` : ''}`)
        })
      } else {
        lines.push('', '没有从日志中识别出需要推进的任务。')
      }
      if (res.questions.length) {
        lines.push('', '需要你确认：')
        for (const q of res.questions) lines.push(`· ${q}`)
      }
      return lines.join('\n')
    } catch (err) {
      return errorText('生成当前重点', err)
    }
  },
}

const worklogAsk = {
  name: 'worklog_ask',
  description:
    '日志问答：插件内部先检索日志，再由自带 LLM 作答，只返回结论与引用 id，不把日志原文带回当前会话。' +
    '适合「之前为什么这么定」「某项目上次做到哪」「谁提过这个问题」这类需要综合多条日志的问题。' +
    '触发场景：问日志、从日志里找答案、回忆之前的决定、查某项工作的来龙去脉。' +
    'Keywords: ask worklog, answer from logs, recall decisions, history Q&A, 日志问答 查历史 之前怎么定的',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问日志的问题（自然语言）' },
      query: { type: 'string', description: '可选的检索关键词；缺省用 question 检索' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
      project: { type: 'string', description: '按项目精确过滤' },
    },
    required: ['question'],
  },
  output: textOutput,
  async run(args) {
    try {
      const res = await logkeeper.ask(args || {})
      const lines = ['日志问答']
      if (!res.llm_used) lines.push(`· LLM 不可用：${res.error || '未知原因'}`)
      else lines.push(`· LLM：${res.model}   置信度：${res.confidence}`)
      lines.push('', res.answer || '(无答案)')
      if (res.citations.length) {
        lines.push('', '引用：')
        for (const c of res.citations) lines.push(`· [${c.date}] ${c.title}  (${c.id})`)
      }
      return lines.join('\n')
    } catch (err) {
      return errorText('日志问答', err)
    }
  },
}

const worklogReindex = {
  name: 'worklog_reindex',
  description:
    '从 Markdown 条目全量重建 SQLite 索引。索引损坏、手工改过日志文件、或换机器后索引为空时使用；Markdown 始终是权威数据。' +
    '触发场景：重建日志索引、日志搜不到、索引修复、换机恢复。' +
    'Keywords: worklog reindex, rebuild index, repair, sync files, 重建索引 修复日志索引',
  parameters: { type: 'object', properties: {} },
  output: textOutput,
  async run() {
    try {
      const res = store.reindexEntries()
      const lines = [
        '工作日志索引重建完成。',
        line('· 扫描文件：', `${res.files} 个`),
        line('· 成功索引：', `${res.indexed} 条`),
        line('· 未完成待办：', `${res.open_todos} 条`),
        line('· 数据目录：', res.data_dir),
        line('· 索引文件：', res.index_path),
      ]
      if ((res.errors || []).length) {
        lines.push(`· 跳过/失败：${res.errors.length} 个`)
        for (const e of res.errors.slice(0, 10)) lines.push(`    - ${e.file}：${e.error}`)
      }
      return lines.join('\n')
    } catch (err) {
      return errorText('重建工作日志索引', err)
    }
  },
}

const worklogConfig = {
  name: 'worklog_config',
  description:
    '读取或修改工作日志配置：data_dir（日志目录）与 llm_base_url / llm_model / llm_api_key / llm_timeout_ms（日志管理员的 LLM 后端）。' +
    '不带 set 时只读，返回数据目录、索引路径、条目数、待办数与 LLM 配置（不回显密钥）。' +
    '触发场景：配置日志目录、换日志存放位置、配置本地模型、查看日志存储与 LLM 状态。' +
    'Keywords: worklog config, settings, data dir, storage, llm endpoint, model, 日志配置 存储位置 模型配置',
  parameters: {
    type: 'object',
    properties: {
      set: {
        type: 'object',
        description: '要写入的配置项，例如 { "llm_base_url": "http://127.0.0.1:11434/v1", "llm_model": "qwen2.5:7b" }',
        properties: {
          data_dir: { type: 'string', description: '日志数据目录（Markdown 条目与 .index 索引）' },
          llm_base_url: { type: 'string', description: 'API 根地址：OpenAI 兼容填 .../v1，dsh Messages 填 .../anthropic；留空自动复用 dsh' },
          llm_model: { type: 'string', description: '模型名；DeepSeek 默认 deepseek-flash，OpenAI 兼容留空则自动取 /models 第一个' },
          llm_api_key: { type: 'string', description: 'API Key（本地模型通常留空）' },
          llm_timeout_ms: { type: 'integer', description: 'LLM 超时毫秒数（默认 60000）' },
          llm_protocol: { type: 'string', enum: ['auto', 'openai', 'anthropic'], description: '协议；auto 按 URL 是否含 /anthropic 判断' },
        },
      },
    },
  },
  output: textOutput,
  async run(args) {
    try {
      const hasSet = args && args.set && typeof args.set === 'object' && Object.keys(args.set).length > 0
      const res = hasSet ? store.updateConfig(args.set) : store.status()
      return [
        hasSet ? '工作日志配置已更新。' : '工作日志配置：',
        line('· 数据目录：', res.data_dir),
        line('· 索引文件：', res.index_path),
        line('· 条目数：', res.entry_count, '· 未完成待办：', res.open_todos),
        line('· LLM 地址：', res.llm.base_url || '(未配置)'),
        line('· LLM 模型：', res.llm.model, res.llm.api_key_set ? '（已设置 API Key）' : ''),
        line('· LLM 协议：', `${res.llm.protocol}（来源：${res.llm.source}）`),
        line('· LLM 超时：', `${res.llm.timeout_ms} ms`),
        line('· 配置文件：', res.config_path, res.config_exists ? '' : '（尚未创建）'),
        line('· 解析优先级：', '环境变量 > config > dsh 托管凭据/默认端点 > 本机 Ollama'),
      ].join('\n')
    } catch (err) {
      return errorText('读取工作日志配置', err)
    }
  },
}

/** 工具清单（两平面共用的唯一契约）。 */
export const tools = [
  worklogAdd,
  worklogSearch,
  worklogGet,
  worklogRecent,
  worklogStats,
  worklogTodo,
  worklogReview,
  worklogAsk,
  worklogReindex,
  worklogConfig,
]
