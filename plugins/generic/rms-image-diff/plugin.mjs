/**
 * rms-image-diff — 可移植清单 + 零依赖实现。
 *
 * 对两张图片做像素级比对：解码 → 裁剪到公共区域 → 逐像素判差 → 8 邻接连通域聚类
 * → 输出差异报告，并按需生成差异热力图（PNG）。
 *
 * 输入支持文件路径与 data URL 两种形态，格式原生支持 PNG（本地零依赖解码），
 * JPEG 为「尽力支持」（借系统转换器转 PNG）。详见 lib/source.mjs。
 *
 * 契约见 docs/dsh-plugin-spec.md §3：零依赖，只允许 node: 内置导入与相对路径导入；
 * 不 import cordis、不出现 ctx。渲染产物为 MCP 形状的内容块，dsh 侧由 dsh/host.mjs 投影。
 *
 * @module rms-image-diff
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { COLOR_TYPE_NAMES, decodePng, encodePngRgba, looksLikePng } from './lib/png.mjs'
import { convertToPng, loadImageSource, looksLikeJpeg } from './lib/source.mjs'
import { compareRgba, cropRgba, findRegions, renderHeatmap } from './lib/diff.mjs'

/** 插件标识，kebab-case，与目录名一致。 */
export const id = 'rms-image-diff'

/** 插件类别：通用插件（只依赖通用图像算法，不含本项目领域知识）。 */
export const kind = 'generic'

/** 一句话说明。 */
export const description = '对两张输入图片做像素级比对，定位差异像素与差异区域，并生成差异热力图。'

/** 热力图默认输出目录（系统临时目录下的固定子目录）。 */
const HEATMAP_DIR = 'rms-image-diff'

/** 默认容差（严格相等）。 */
const DEFAULT_TOLERANCE = 0

/** 默认报告区域数上限。 */
const DEFAULT_MAX_REGIONS = 200

/** 热处理标注包围框的最大区域数（与 lib/diff.mjs 保持一致的口径说明）。 */
const OUTLINE_LIMIT = 24

/** 解析为有限整数并夹到区间内。 */
function clampInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** 比例格式化为百分比。 */
function formatRatio(ratio) {
  return `${(ratio * 100).toFixed(3)}%`
}

/**
 * 读入并解码一张图片为 RGBA。
 * @param {string} label 字段名，用于报错定位
 * @param {string} source 文件路径或 data URL
 */
function loadRgba(label, source) {
  const { bytes, origin } = loadImageSource(source, label)
  if (looksLikePng(bytes)) {
    return { ...decodePng(bytes), origin, format: 'PNG', note: '本地零依赖解码' }
  }
  if (looksLikeJpeg(bytes)) {
    const converted = convertToPng(bytes)
    return {
      ...decodePng(converted.bytes),
      origin,
      format: 'JPEG',
      note: `经系统转换器转 PNG（${converted.via}）后解码`,
    }
  }
  throw new Error(`${label}: 无法识别的图片格式（原生支持 PNG，JPEG 为尽力支持）。来源：${origin}`)
}

/** 描述单张图片的元信息行。 */
function describeImage(title, image) {
  const color = COLOR_TYPE_NAMES[image.colorType] ?? `颜色类型 ${image.colorType}`
  const alpha = image.hasAlpha ? '含 Alpha' : '无 Alpha'
  return `- **${title}** ${image.width}×${image.height}｜${image.format}｜${color} ${image.bitDepth}bit（${alpha}）｜${image.note}\n  - 来源：${image.origin}`
}

/** 组装文本差异报告。 */
function buildReport(context) {
  const {
    imageA,
    imageB,
    width,
    height,
    cropped,
    tolerance,
    diffPixels,
    totalPixels,
    maxDelta,
    regions,
    regionsTruncated,
    minArea,
    heatmap,
    heatmapError,
  } = context

  const lines = []
  const identical = diffPixels === 0
  lines.push(identical ? '## 图片比对结果：公共区域内完全一致' : '## 图片比对结果：存在差异')
  lines.push('')
  lines.push(describeImage('图 A', imageA))
  lines.push(describeImage('图 B', imageB))
  lines.push(
    cropped
      ? `- **尺寸** 不一致（${imageA.width}×${imageA.height} vs ${imageB.width}×${imageB.height}）→ 已裁剪到公共区域 ${width}×${height}（左上对齐）后比对`
      : `- **比对区域** ${width}×${height}（两图尺寸一致）`,
  )
  lines.push(
    `- **容差** 每通道 ≤ ${tolerance}${tolerance === 0 ? '（严格逐像素相等）' : ''}；最小差异区域面积 ${minArea} 像素`,
  )
  lines.push(
    `- **差异像素** ${diffPixels} / ${totalPixels}（${formatRatio(totalPixels === 0 ? 0 : diffPixels / totalPixels)}），最大单通道色差 ${maxDelta}`,
  )
  lines.push(`- **差异区域** ${regions.length} 个${regionsTruncated ? '（已达报告上限，仅列出按像素数排序的前若干）' : ''}`)
  lines.push('')

  if (regions.length > 0) {
    lines.push('| # | x | y | 宽 | 高 | 像素数 | 占差异 | 平均色差 | 最大色差 |')
    lines.push('|---|---|---|---|---|---|---|---|---|')
    regions.forEach((region, index) => {
      lines.push(
        `| ${index + 1} | ${region.x} | ${region.y} | ${region.width} | ${region.height} | ${region.pixels} | ${formatRatio(
          diffPixels === 0 ? 0 : region.pixels / diffPixels,
        )} | ${region.meanDelta} | ${region.maxDelta} |`,
      )
    })
    lines.push('')
  }

  if (heatmap) {
    lines.push(
      `- **差异热力图** 已写入 ${heatmap.path}（黑底；差异像素按色差强度从蓝到红着色；区域数 ≤ ${OUTLINE_LIMIT} 时描 1px 淡色包围框）`,
    )
  } else if (heatmapError) {
    lines.push(`- **差异热力图** 生成失败：${heatmapError}`)
  } else {
    lines.push('- **差异热力图** 未生成（两图在公共区域内一致，或调用方关闭了 heatmap）')
  }

  return lines.join('\n')
}

/**
 * 比对两张图片。
 * @param {object} args 工具入参
 * @returns {object} 结构化结果（同时满足 output.schema）
 */
function diffImages(args) {
  const tolerance = clampInt(args.tolerance, DEFAULT_TOLERANCE, 0, 255)
  const minArea = clampInt(args.min_region_area, 0, 0, Number.MAX_SAFE_INTEGER)
  const maxRegions = clampInt(args.max_regions, DEFAULT_MAX_REGIONS, 1, 5000)
  const wantHeatmap = args.heatmap !== false

  const imageA = loadRgba('image_a', args.image_a)
  const imageB = loadRgba('image_b', args.image_b)

  const width = Math.min(imageA.width, imageB.width)
  const height = Math.min(imageA.height, imageB.height)
  const cropped = imageA.width !== imageB.width || imageA.height !== imageB.height
  const dataA =
    imageA.width === width && imageA.height === height ? imageA.data : cropRgba(imageA.data, imageA.width, width, height)
  const dataB =
    imageB.width === width && imageB.height === height ? imageB.data : cropRgba(imageB.data, imageB.width, width, height)

  const { mask, delta, diffPixels, maxDelta } = compareRgba(dataA, dataB, width, height, tolerance)
  const { regions, truncated } = findRegions({ mask, delta, width, height, minArea, maxRegions })
  const totalPixels = width * height

  let heatmap
  let heatmapError
  if (wantHeatmap && diffPixels > 0) {
    try {
      const png = encodePngRgba(renderHeatmap({ mask, delta, width, height, regions, tolerance }), width, height)
      const target = args.heatmap_path?.trim() || join(tmpdir(), HEATMAP_DIR, `heatmap-${Date.now()}.png`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, png)
      heatmap = { path: target, mimeType: 'image/png', base64: png.toString('base64') }
    } catch (error) {
      heatmapError = error.message
    }
  }

  const report = buildReport({
    imageA,
    imageB,
    width,
    height,
    cropped,
    tolerance,
    diffPixels,
    totalPixels,
    maxDelta,
    regions,
    regionsTruncated: truncated,
    minArea,
    heatmap,
    heatmapError,
  })

  return {
    identical: diffPixels === 0,
    report,
    tolerance,
    compared: { width, height, cropped },
    diffPixels,
    totalPixels,
    diffRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    maxDelta,
    regionCount: regions.length,
    regionsTruncated: truncated,
    regions,
    ...(heatmap ? { heatmap } : {}),
  }
}

/** 模型可见工具清单。 */
export const tools = [
  {
    name: 'diff_images',
    description:
      '逐像素比对两张图片（PNG 原生解码，JPEG 尽力支持；输入可为文件路径或 data URL），返回差异像素统计与差异区域（包围盒）列表，并默认生成差异热力图 PNG。' +
      '触发场景：两张图片找不同、截图对比、UI 截图回归比对、两个版本渲染结果对比、像素级差异。' +
      'Keywords: image diff, compare two images, screenshot compare, visual regression, pixel diff, find differences.',
    parameters: {
      type: 'object',
      properties: {
        image_a: {
          type: 'string',
          description: '图片 A：文件路径，或 data URL（形如 data:image/png;base64,...）',
        },
        image_b: {
          type: 'string',
          description: '图片 B：文件路径，或 data URL（形如 data:image/png;base64,...）',
        },
        tolerance: {
          type: 'integer',
          minimum: 0,
          maximum: 255,
          default: DEFAULT_TOLERANCE,
          description: '每通道允许的最大绝对色差；超过才记为差异像素。0 表示严格逐像素相等（默认）',
        },
        min_region_area: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: '差异区域的最小像素数，低于该值的连通域被丢弃（用于过滤噪点）',
        },
        max_regions: {
          type: 'integer',
          minimum: 1,
          default: DEFAULT_MAX_REGIONS,
          description: '报告中差异区域的个数上限，按像素数降序截断',
        },
        heatmap: {
          type: 'boolean',
          default: true,
          description: '是否生成差异热力图 PNG（两图完全一致时不生成）',
        },
        heatmap_path: {
          type: 'string',
          description: '热力图 PNG 的保存路径；省略时写入系统临时目录 rms-image-diff/ 下',
        },
      },
      required: ['image_a', 'image_b'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          identical: { type: 'boolean', description: '公共区域内是否完全一致' },
          report: { type: 'string', description: '文本差异报告（含差异区域表）' },
          tolerance: { type: 'number' },
          compared: {
            type: 'object',
            properties: {
              width: { type: 'number' },
              height: { type: 'number' },
              cropped: { type: 'boolean', description: '是否因尺寸不一致而裁剪到公共区域' },
            },
            required: ['width', 'height', 'cropped'],
          },
          diffPixels: { type: 'number' },
          totalPixels: { type: 'number' },
          diffRatio: { type: 'number', description: '差异像素占比对区域的比例' },
          maxDelta: { type: 'number', description: '最大单通道色差' },
          regionCount: { type: 'number' },
          regionsTruncated: { type: 'boolean' },
          regions: {
            type: 'array',
            description: '差异区域列表，按像素数降序',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                pixels: { type: 'number' },
                meanDelta: { type: 'number' },
                maxDelta: { type: 'number' },
              },
              required: ['x', 'y', 'width', 'height', 'pixels', 'meanDelta', 'maxDelta'],
            },
          },
          heatmap: {
            type: 'object',
            description: '热力图产物；未生成时该字段缺省',
            properties: {
              path: { type: 'string' },
              mimeType: { type: 'string' },
              base64: { type: 'string' },
            },
            required: ['path', 'mimeType', 'base64'],
          },
        },
        required: ['identical', 'report', 'diffPixels', 'totalPixels', 'diffRatio', 'regionCount', 'regions'],
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: value.report }]
        if (value.heatmap?.base64) {
          blocks.push({ type: 'image', data: value.heatmap.base64, mimeType: value.heatmap.mimeType })
        }
        return blocks
      },
    },
    run(args) {
      return diffImages(args)
    },
  },
]
