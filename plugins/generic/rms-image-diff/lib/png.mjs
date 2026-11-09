/**
 * 零依赖 PNG 解码 / 编码。
 *
 * 仅使用 node:zlib 的 inflate/deflate，自行解析 PNG chunk、执行行反滤波、
 * 展开采样位深并把各颜色类型统一归一为 RGBA(8bit)。
 *
 * 覆盖范围（非交错）：
 *   颜色类型 0 灰度 / 2 RGB / 3 调色板 / 4 灰度+Alpha / 6 RGBA
 *   位深 1/2/4/8/16（16 位取高字节，低位深灰度按 255/max 展开）
 * 明确不支持交错(Adam7)：遇到则抛出可执行的报错，请调用方改用非交错导出。
 *
 * @module rms-image-diff/lib/png
 */

import { inflateSync, deflateSync } from 'node:zlib'

/** PNG 文件签名。 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 各颜色类型的通道数。 */
const COLOR_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** 各颜色类型允许的位深。 */
const ALLOWED_DEPTHS = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

/** 颜色类型的可读名。 */
export const COLOR_TYPE_NAMES = {
  0: '灰度',
  2: 'RGB',
  3: '调色板',
  4: '灰度+Alpha',
  6: 'RGBA',
}

/** 是否为 PNG（按签名判断）。 */
export function looksLikePng(bytes) {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
}

// ---------------------------------------------------------------------------
// CRC32 / chunk 组装（编码用）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** 计算 PNG chunk 的 CRC32。 */
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 组装一个完整 chunk：length + type + data + crc。 */
function buildChunk(type, data) {
  const payload = Buffer.from(data)
  const out = Buffer.alloc(payload.length + 12)
  out.writeUInt32BE(payload.length, 0)
  out.write(type, 4, 4, 'latin1')
  payload.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + payload.length)), 8 + payload.length)
  return out
}

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

/** Paeth 预测器。 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** 就地执行一行反滤波。 */
function unfilterRow(filterType, src, dst, prev, bpp) {
  const length = dst.length
  switch (filterType) {
    case 0:
      src.copy(dst)
      break
    case 1:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? dst[i - bpp] : 0
        dst[i] = (src[i] + left) & 0xff
      }
      break
    case 2:
      for (let i = 0; i < length; i++) dst[i] = (src[i] + prev[i]) & 0xff
      break
    case 3:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? dst[i - bpp] : 0
        dst[i] = (src[i] + ((left + prev[i]) >> 1)) & 0xff
      }
      break
    case 4:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? dst[i - bpp] : 0
        const upLeft = i >= bpp ? prev[i - bpp] : 0
        dst[i] = (src[i] + paeth(left, prev[i], upLeft)) & 0xff
      }
      break
    default:
      throw new Error(`未知的 PNG 行滤波类型 ${filterType}（应为 0-4）`)
  }
}

/** 把一行原始字节展开为逐通道采样值（8bit）。 */
function extractSamples(row, bitDepth, channels, width, scale) {
  const count = width * channels
  if (bitDepth === 8) return row.subarray(0, count)
  if (bitDepth === 16) {
    const samples = new Uint8Array(count)
    for (let i = 0; i < count; i++) samples[i] = row[i * 2]
    return samples
  }
  const perByte = 8 / bitDepth
  const max = (1 << bitDepth) - 1
  const samples = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const byte = row[Math.floor(i / perByte)]
    const shift = 8 - bitDepth * ((i % perByte) + 1)
    const value = (byte >> shift) & max
    samples[i] = scale ? Math.round((value * 255) / max) : value
  }
  return samples
}

/**
 * 解码 PNG 为 RGBA(8bit)。
 * @param {Buffer|Uint8Array} bytes PNG 文件字节
 * @returns {{ width: number, height: number, data: Uint8Array, bitDepth: number, colorType: number, hasAlpha: boolean }}
 */
export function decodePng(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (!looksLikePng(buffer)) throw new Error('不是有效的 PNG：缺少 PNG 签名')

  let header = null
  let palette = null
  let transparency = null
  const idatParts = []

  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new Error(`PNG chunk '${type}' 数据越界，文件可能被截断`)
    const data = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') transparency = Buffer.from(data)
    else if (type === 'IDAT') idatParts.push(Buffer.from(data))
    else if (type === 'IEND') break
    offset = dataEnd + 4
  }

  if (!header) throw new Error('PNG 缺少 IHDR chunk')
  const { width, height, bitDepth, colorType, interlace } = header
  if (width <= 0 || height <= 0) throw new Error(`PNG 尺寸非法：${width}x${height}`)
  if (interlace !== 0) throw new Error('不支持交错(Adam7) PNG：请先用非交错方式重新导出')
  const channels = COLOR_CHANNELS[colorType]
  if (channels === undefined) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`)
  if (!ALLOWED_DEPTHS[colorType].includes(bitDepth)) {
    throw new Error(`颜色类型 ${colorType} 不支持位深 ${bitDepth}`)
  }
  if (idatParts.length === 0) throw new Error('PNG 缺少 IDAT chunk')

  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const rowBytes = Math.ceil((bitsPerPixel * width) / 8)
  const raw = inflateSync(Buffer.concat(idatParts))
  const expected = (rowBytes + 1) * height
  if (raw.length < expected) {
    throw new Error(`PNG 像素数据不完整：期望 ${expected} 字节，实得 ${raw.length} 字节`)
  }

  const stride = rowBytes + 1
  const planar = Buffer.alloc(rowBytes * height)
  let previous = Buffer.alloc(rowBytes)
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * stride]
    const src = raw.subarray(y * stride + 1, y * stride + stride)
    const dst = planar.subarray(y * rowBytes, (y + 1) * rowBytes)
    unfilterRow(filterType, src, dst, previous, bpp)
    previous = dst
  }

  const rgba = new Uint8Array(width * height * 4)
  const scaleGray = colorType === 0
  const paletteEntries = palette ? Math.floor(palette.length / 3) : 0
  if (colorType === 3 && paletteEntries === 0) throw new Error('调色板 PNG 缺少有效的 PLTE chunk')

  for (let y = 0; y < height; y++) {
    const row = planar.subarray(y * rowBytes, (y + 1) * rowBytes)
    const samples = extractSamples(row, bitDepth, channels, width, scaleGray)
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * 4
      if (colorType === 0) {
        const g = samples[x]
        rgba[base] = g
        rgba[base + 1] = g
        rgba[base + 2] = g
        rgba[base + 3] = 255
      } else if (colorType === 2) {
        rgba[base] = samples[x * 3]
        rgba[base + 1] = samples[x * 3 + 1]
        rgba[base + 2] = samples[x * 3 + 2]
        rgba[base + 3] = 255
      } else if (colorType === 3) {
        const index = samples[x]
        if (index >= paletteEntries) {
          throw new Error(`调色板索引越界：${index} ≥ ${paletteEntries}`)
        }
        rgba[base] = palette[index * 3]
        rgba[base + 1] = palette[index * 3 + 1]
        rgba[base + 2] = palette[index * 3 + 2]
        rgba[base + 3] = transparency && index < transparency.length ? transparency[index] : 255
      } else if (colorType === 4) {
        const g = samples[x * 2]
        rgba[base] = g
        rgba[base + 1] = g
        rgba[base + 2] = g
        rgba[base + 3] = samples[x * 2 + 1]
      } else {
        rgba[base] = samples[x * 4]
        rgba[base + 1] = samples[x * 4 + 1]
        rgba[base + 2] = samples[x * 4 + 2]
        rgba[base + 3] = samples[x * 4 + 3]
      }
    }
  }

  return {
    width,
    height,
    data: rgba,
    bitDepth,
    colorType,
    hasAlpha: colorType === 4 || colorType === 6 || (colorType === 3 && transparency !== null),
  }
}

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

/**
 * 把 RGBA(8bit) 像素编码为 PNG（颜色类型 6，非交错）。
 * @param {Uint8Array} rgba 长度必须为 width*height*4
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodePngRgba(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA 数据长度 ${rgba.length} 与 ${width}x${height} 不匹配`)
  }
  const rowBytes = width * 4
  const stride = rowBytes + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const view = rgba.subarray(y * rowBytes, (y + 1) * rowBytes)
    Buffer.from(view.buffer, view.byteOffset, view.byteLength).copy(raw, y * stride + 1)
    raw[y * stride] = 0 // 滤波类型 None
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', deflateSync(raw, { level: 9 })),
    buildChunk('IEND', Buffer.alloc(0)),
  ])
}
