/**
 * 图片来源解析与格式桥接。
 *
 * 负责：
 *   1. 把调用方传入的字符串解析为图片字节 —— 支持 data URL（base64）与文件路径；
 *   2. 按魔数识别格式；
 *   3. JPEG 走「尽力支持」路线：借系统图像转换器无损转成 PNG 后再交给本地 PNG 解码器。
 *
 * 全程零 npm 依赖：只用 node: 内置模块。JPEG 桥接依赖操作系统自带的转换能力
 * （Windows PowerShell + System.Drawing / macOS sips / Linux ImageMagick），
 * 均不可用时返回含可执行提示的报错。
 *
 * @module rms-image-diff/lib/source
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 是否为 JPEG（按 SOI + 首个标记判断）。 */
export function looksLikeJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

/**
 * 解析图片来源并读入字节。
 * @param {string} source data URL（`data:image/png;base64,...`）或文件路径
 * @param {string} label 用于报错的字段名，如 'image_a'
 * @returns {{ bytes: Buffer, origin: string }}
 */
export function loadImageSource(source, label) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error(`${label}: 必须是非空字符串（data URL 或文件路径）`)
  }
  const text = source.trim()

  if (text.startsWith('data:')) {
    const comma = text.indexOf(',')
    if (comma < 0) throw new Error(`${label}: data URL 缺少 ',' 分隔符`)
    const meta = text.slice(5, comma)
    if (!/;base64$/i.test(meta) && !/;base64;/i.test(meta)) {
      throw new Error(`${label}: data URL 仅支持 base64 编码（期望 data:<mime>;base64,...）`)
    }
    const payload = text.slice(comma + 1).replace(/\s+/g, '')
    const bytes = Buffer.from(payload, 'base64')
    if (bytes.length === 0) throw new Error(`${label}: data URL 的 base64 载荷为空或无法解码`)
    const mime = meta.split(';')[0] || '未知类型'
    return { bytes, origin: `data URL（声明 ${mime}）` }
  }

  try {
    return { bytes: readFileSync(text), origin: text }
  } catch (error) {
    throw new Error(`${label}: 无法读取文件 '${text}'（${error.code ?? error.message}）`)
  }
}

/** PowerShell 单引号字符串转义。 */
function quotePowerShell(path) {
  return `'${String(path).replace(/'/g, "''")}'`
}

/** 按平台给出可用的系统转换器候选（按优先级排列）。 */
function converterCandidates(source, target) {
  const candidates = []
  const psScript =
    'Add-Type -AssemblyName System.Drawing; ' +
    `$img = [System.Drawing.Image]::FromFile(${quotePowerShell(source)}); ` +
    `$img.Save(${quotePowerShell(target)}, [System.Drawing.Imaging.ImageFormat]::Png); ` +
    '$img.Dispose()'

  if (process.platform === 'win32') {
    candidates.push({
      label: 'PowerShell + System.Drawing',
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    })
  }
  if (process.platform === 'darwin') {
    candidates.push({ label: 'sips', command: 'sips', args: ['-s', 'format', 'png', source, '--out', target] })
  }
  candidates.push({ label: 'ImageMagick (magick)', command: 'magick', args: [source, target] })
  candidates.push({ label: 'ImageMagick (convert)', command: 'convert', args: [source, target] })
  return candidates
}

/**
 * 借系统转换器把任意可识别图片转为 PNG（尽力支持）。
 * @param {Buffer} bytes 原图字节
 * @returns {{ bytes: Buffer, via: string }} 转换后的 PNG 字节与所用转换器
 */
export function convertToPng(bytes) {
  const workDir = mkdtempSync(join(tmpdir(), 'rms-image-diff-'))
  const sourceFile = join(workDir, 'input.bin')
  const targetFile = join(workDir, 'output.png')
  const failures = []

  try {
    writeFileSync(sourceFile, bytes)
    for (const candidate of converterCandidates(sourceFile, targetFile)) {
      const result = spawnSync(candidate.command, candidate.args, { timeout: 20000, encoding: 'utf8' })
      if (result.error) {
        failures.push(`${candidate.label}：${result.error.message}`)
        continue
      }
      if (result.status === 0 && existsSync(targetFile)) {
        return { bytes: readFileSync(targetFile), via: candidate.label }
      }
      const stderr = String(result.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''
      failures.push(`${candidate.label}：退出码 ${result.status}${stderr ? ` — ${stderr}` : ''}`)
    }
    throw new Error(
      [
        '无法用系统转换器把该图片转为 PNG（JPEG 支持为「尽力」模式）。尝试结果：',
        ...failures.map(line => `  - ${line}`),
        '提示：Windows 需要可用的 Windows PowerShell + System.Drawing；macOS 使用自带 sips；',
        '     Linux 需安装 ImageMagick（magick 或 convert）。安装后重试即可，无需重启。',
      ].join('\n'),
    )
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
