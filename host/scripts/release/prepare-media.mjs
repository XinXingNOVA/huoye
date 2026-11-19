// 在 Mac 或 Windows 准备相同的 Windows 媒体包；校验失败不能静默换版本。
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const mediaLock = JSON.parse(await readFile(join(root, 'packaging/media-lock.json'), 'utf8'))
export const mediaDirectory = join(root, 'resources/media', mediaLock.platform)
const hashFile = async file => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function verifyMedia(directory = mediaDirectory) {
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'))
  if (receipt.archiveSha256 !== mediaLock.sha256 || receipt.version !== mediaLock.version || receipt.source !== mediaLock.source) throw new Error('媒体包版本不匹配，请重新运行 npm run media:prepare')
  for (const file of ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt']) {
    if (!receipt.files[file] || await hashFile(join(directory, file)) !== receipt.files[file]) throw new Error(`媒体包校验失败：${file}`)
  }
  return receipt
}
async function prepare() {
  try { await verifyMedia(); console.log('Windows 媒体工具已准备并通过校验'); return } catch { /* 初次安装或需要修复。 */ }
  const cache = join(root, '.build-cache'); await mkdir(cache, { recursive: true })
  const supplied = process.argv.indexOf('--archive')
  const archive = supplied >= 0 ? resolve(process.argv[supplied + 1] ?? '') : join(cache, `ffmpeg-${mediaLock.version}.zip`)
  let valid = false
  try { valid = await hashFile(archive) === mediaLock.sha256 } catch { /* 尚未下载。 */ }
  if (!valid) {
    if (supplied >= 0) throw new Error('指定的 FFmpeg ZIP 与锁定校验值不一致')
    let lastError
    for (const url of [mediaLock.mirror, mediaLock.url].filter(Boolean)) {
      const partial = archive + '.part'
      try {
        console.log(`下载 Windows 媒体工具：${url}`)
        const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
        if (await hashFile(partial) !== mediaLock.sha256) throw new Error('FFmpeg 下载校验失败，未安装')
        await rename(partial, archive)
        valid = true; break
      } catch (e) { lastError = e; console.warn(String(e)) }
      finally { await rm(partial, { force: true }) }
    }
    if (!valid) throw new Error(`下载失败；可用 --archive 指定手动下载的同版 ZIP。${lastError}`)
  }
  const temporary = await mkdtemp(join(cache, 'media-'))
  try {
    // 原生解压工具避免旧 ZIP 流库与不同 Node 版本的兼容问题；只解压已核对哈希的固定上游包。
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:RM_MEDIA_ARCHIVE -DestinationPath $env:RM_MEDIA_EXTRACT -ErrorAction Stop'], {
        env: { ...process.env, RM_MEDIA_ARCHIVE: archive, RM_MEDIA_EXTRACT: temporary }, windowsHide: true, stdio: 'inherit'
      })
    } else execFileSync('/usr/bin/unzip', ['-q', archive, '-d', temporary], { stdio: 'inherit' })
    const source = join(temporary, mediaLock.directory)
    const files = {}
    for (const file of ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt']) {
      if (!(await stat(join(source, file))).isFile()) throw new Error(`FFmpeg 包缺少 ${file}`)
      files[file] = await hashFile(join(source, file))
      if (file.endsWith('.exe')) {
        const bytes = await readFile(join(source, file)), pe = bytes.readUInt32LE(0x3c)
        if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('媒体工具不是 Windows x64 程序')
      }
    }
    const staged = join(temporary, 'ready'); await mkdir(join(staged, 'bin'), { recursive: true })
    for (const file of Object.keys(files)) await cp(join(source, file), join(staged, file))
    await writeFile(join(staged, 'receipt.json'), JSON.stringify({ ...mediaLock, archiveSha256: mediaLock.sha256, files }, null, 2))
    await writeFile(join(staged, 'SOURCE.txt'), `FFmpeg ${mediaLock.version}\nBuild provider: ${mediaLock.provider}\nBuild archive: ${mediaLock.url}\nSHA-256: ${mediaLock.sha256}\nFFmpeg source: ${mediaLock.source}\nLicense: ${mediaLock.license}\nSee LICENSE and README.txt for the build configuration and external-library versions.\n`)
    // 只替换构建缓存，不接触仓库或已安装应用。
    await mkdir(dirname(mediaDirectory), { recursive: true })
    await rm(mediaDirectory, { recursive: true, force: true })
    await rename(staged, mediaDirectory)
    await verifyMedia(); console.log(`Windows 媒体工具已准备：${mediaDirectory}`)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare()
