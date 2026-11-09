/**
 * 像素比对、连通域聚类与差异热力图渲染。
 *
 * 三个纯计算步骤，均不涉及宿主与 IO：
 *   compareRgba   逐像素判差，输出差异掩膜与每像素最大通道色差
 *   findRegions   对差异掩膜做 8 邻接连通域聚类，输出差异区域包围盒
 *   renderHeatmap 黑底 + 按色差强度着色的热力图栅格（并标注区域包围框）
 *
 * @module rms-image-diff/lib/diff
 */

/** 热力图色标（蓝 → 青 → 绿 → 黄 → 红）。 */
const HEAT_STOPS = [
  [0, [0, 0, 255]],
  [0.25, [0, 255, 255]],
  [0.5, [0, 255, 0]],
  [0.75, [255, 255, 0]],
  [1, [255, 0, 0]],
]

/** 最多为多少个差异区域画包围框（更多则只靠文本报告）。 */
const MAX_OUTLINED_REGIONS = 24

/** 按归一化色差取热力颜色。 */
function heatColor(t) {
  const x = Math.min(1, Math.max(0, t))
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [upper, upperColor] = HEAT_STOPS[i]
    if (x <= upper) {
      const [lower, lowerColor] = HEAT_STOPS[i - 1]
      const k = upper === lower ? 0 : (x - lower) / (upper - lower)
      return [
        Math.round(lowerColor[0] + (upperColor[0] - lowerColor[0]) * k),
        Math.round(lowerColor[1] + (upperColor[1] - lowerColor[1]) * k),
        Math.round(lowerColor[2] + (upperColor[2] - lowerColor[2]) * k),
      ]
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1][1]
}

/**
 * 从左上角裁剪出公共区域。
 * @param {Uint8Array} rgba 源 RGBA 数据
 * @param {number} sourceWidth 源宽度
 * @param {number} width 目标宽度
 * @param {number} height 目标高度
 * @returns {Uint8Array}
 */
export function cropRgba(rgba, sourceWidth, width, height) {
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const from = (y * sourceWidth) * 4
    out.set(rgba.subarray(from, from + width * 4), y * width * 4)
  }
  return out
}

/**
 * 逐像素比对两块等尺寸 RGBA 数据。
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {number} width
 * @param {number} height
 * @param {number} tolerance 每通道允许的最大绝对差；超过即记为该像素存在差异
 * @returns {{ mask: Uint8Array, delta: Uint8Array, diffPixels: number, maxDelta: number }}
 */
export function compareRgba(a, b, width, height, tolerance) {
  const total = width * height
  const mask = new Uint8Array(total)
  const delta = new Uint8Array(total)
  let diffPixels = 0
  let maxDelta = 0

  for (let i = 0; i < total; i++) {
    const p = i * 4
    // 双方均为全透明时，RGB 通常是无意义残留值，视为相同。
    const value =
      a[p + 3] === 0 && b[p + 3] === 0
        ? 0
        : Math.max(
            Math.abs(a[p] - b[p]),
            Math.abs(a[p + 1] - b[p + 1]),
            Math.abs(a[p + 2] - b[p + 2]),
            Math.abs(a[p + 3] - b[p + 3]),
          )
    delta[i] = value
    if (value > tolerance) {
      mask[i] = 1
      diffPixels++
      if (value > maxDelta) maxDelta = value
    }
  }

  return { mask, delta, diffPixels, maxDelta }
}

/**
 * 对差异掩膜做 8 邻接连通域聚类。
 * @param {object} input
 * @param {Uint8Array} input.mask
 * @param {Uint8Array} input.delta
 * @param {number} input.width
 * @param {number} input.height
 * @param {number} [input.minArea] 最小像素数，低于该值的区域被丢弃（去噪）
 * @param {number} [input.maxRegions] 报告区域数上限，按像素数降序截断
 * @returns {{ regions: object[], truncated: boolean }}
 */
export function findRegions({ mask, delta, width, height, minArea = 0, maxRegions = 200 }) {
  const total = width * height
  const visited = new Uint8Array(total)
  const regions = []
  let truncated = false

  // 病态输入（如噪点图）可能产生极多连通域，这里设硬上限避免报告与内存失控。
  const hardCap = Math.max(maxRegions * 4, 2000)

  for (let start = 0; start < total; start++) {
    if (mask[start] === 0 || visited[start] === 1) continue

    const stack = [start]
    visited[start] = 1
    let minX = width
    let maxX = -1
    let minY = height
    let maxY = -1
    let pixels = 0
    let deltaSum = 0
    let regionMaxDelta = 0

    while (stack.length > 0) {
      const index = stack.pop()
      const x = index % width
      const y = (index - x) / width
      pixels++
      deltaSum += delta[index]
      if (delta[index] > regionMaxDelta) regionMaxDelta = delta[index]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const neighbor = ny * width + nx
          if (mask[neighbor] === 1 && visited[neighbor] === 0) {
            visited[neighbor] = 1
            stack.push(neighbor)
          }
        }
      }
    }

    if (pixels >= Math.max(1, minArea)) {
      regions.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        pixels,
        meanDelta: Math.round(deltaSum / pixels),
        maxDelta: regionMaxDelta,
      })
      if (regions.length >= hardCap) {
        truncated = true
        break
      }
    }
  }

  regions.sort((left, right) => right.pixels - left.pixels || left.y - right.y || left.x - right.x)
  if (regions.length > maxRegions) {
    truncated = true
    regions.length = maxRegions
  }
  return { regions, truncated }
}

/** 在热力图上以 50% 混合画一个 1px 区域边框，保留原热力强度信息。 */
function outlineRegion(rgba, width, height, region) {
  const plot = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const p = (y * width + x) * 4
    rgba[p] = Math.round((rgba[p] + 255) / 2)
    rgba[p + 1] = Math.round((rgba[p + 1] + 255) / 2)
    rgba[p + 2] = Math.round((rgba[p + 2] + 255) / 2)
  }
  const right = region.x + region.width - 1
  const bottom = region.y + region.height - 1
  for (let x = region.x; x <= right; x++) {
    plot(x, region.y)
    plot(x, bottom)
  }
  for (let y = region.y; y <= bottom; y++) {
    plot(region.x, y)
    plot(right, y)
  }
}

/**
 * 渲染差异热力图：黑底，差异像素按色差强度从蓝(弱)到红(强)着色，
 * 并为有报告的区域画 1px 淡色包围框（区域数 ≤ MAX_OUTLINED_REGIONS 时）。
 * @param {object} input
 * @param {Uint8Array} input.mask
 * @param {Uint8Array} input.delta
 * @param {number} input.width
 * @param {number} input.height
 * @param {object[]} input.regions
 * @param {number} input.tolerance
 * @returns {Uint8Array} RGBA 栅格
 */
export function renderHeatmap({ mask, delta, width, height, regions, tolerance }) {
  const rgba = new Uint8Array(width * height * 4)
  const span = Math.max(1, 255 - tolerance)

  for (let i = 0; i < width * height; i++) {
    const p = i * 4
    if (mask[i] === 1) {
      const [r, g, b] = heatColor((delta[i] - tolerance) / span)
      rgba[p] = r
      rgba[p + 1] = g
      rgba[p + 2] = b
    }
    rgba[p + 3] = 255
  }

  if (regions.length > 0 && regions.length <= MAX_OUTLINED_REGIONS) {
    for (const region of regions) outlineRegion(rgba, width, height, region)
  }

  return rgba
}
