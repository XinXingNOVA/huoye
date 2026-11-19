import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { portableFileName, portablePath } from '../../src/shared/paths'
import { acceleratorLabel } from '../../src/shared/accelerators'
import { findProgram } from '../../src/platform/programs'
import { windowChrome } from '../../src/main/window-options'
import { renamed } from '../../src/plugins/file/names'
import { openHost, tempDir } from '../helpers/helpers'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const directory = () => { const dir = tempDir('rm-platform-'); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

describe('跨系统边界', () => {
  it('保留中文、空格和扩展名，替换 Windows 保留字符与设备名', () => {
    expect(portableFileName(' 海边:一?.PNG ')).toBe('海边_一_.PNG')
    expect(portableFileName('NUL.txt')).toBe('_NUL.txt')
    expect(portableFileName('com1')).toBe('_com1')
    expect(renamed('原名.mp3', 'A<>"|*?')).toBe('A______.mp3')
    expect(renamed('原名.mp3', 'CON. ')).toBe('_CON.mp3')
    expect(portablePath('files\\身份\\声音 一.wav')).toBe('files/身份/声音 一.wav')
  })

  it('Windows 优先找包内 .exe；拒绝目录、相对搜索目录及 shell 表达式', () => {
    const packaged = directory(), system = directory()
    writeFileSync(join(packaged, 'ffmpeg.exe'), 'packaged')
    writeFileSync(join(system, 'ffmpeg.exe'), 'system')
    expect(findProgram('ffmpeg', [packaged, system], 'win32')).toBe(join(packaged, 'ffmpeg.exe'))
    expect(findProgram('ffmpeg', ['.'], 'win32')).toBeUndefined()
    expect(findProgram('../ffmpeg', [packaged], 'win32')).toBeUndefined()
    expect(findProgram('ffmpeg & cmd', [packaged], 'win32')).toBeUndefined()
    mkdirSync(join(packaged, 'ffprobe.exe'))
    expect(findProgram('ffprobe', [packaged], 'win32')).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('Mac 仍要求真实可执行权限', () => {
    const dir = directory(), file = join(dir, 'ffmpeg'); writeFileSync(file, 'x'); chmodSync(file, 0o644)
    expect(findProgram('ffmpeg', [dir], 'darwin')).toBeUndefined()
    chmodSync(file, 0o755)
    expect(findProgram('ffmpeg', [dir], 'darwin')).toBe(file)
  })

  it('快捷键与窗口按钮遵循所在平台', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+P', true)).toBe('⌘⇧P')
    expect(acceleratorLabel('CmdOrCtrl+Shift+P', false)).toBe('Ctrl+Shift+P')
    expect(windowChrome('darwin')).toMatchObject({ titleBarStyle: 'hiddenInset' })
    expect(windowChrome('win32')).toEqual({ titleBarStyle: 'default' })
  })

  it('反斜杠版本引用可以取回、改名、撤销与彻底删除，新记录使用正斜杠', async () => {
    const source = join(directory(), '中文 笔记.md')
    writeFileSync(source, '# 内容不变\n跨系统')
    const h = openHost()
    cleanup.push(h.cleanup)
    const [id] = await h.host.api.ingest([{ type: 'file', path: source }]); await h.host.scheduler.idle()
    const file = h.host.store.blocksOf(id).file.data
    const fileId = h.host.lib.files.record(String(file.path))!.id
    expect(fileId).not.toBe(id)
    expect(String(file.path)).toContain(`/` + fileId + `/`); expect(String(file.path)).toMatch(/^spaces\/v2\//)
    h.host.store.put(id, 'file', { ...file, path: String(file.path).replaceAll('/', '\\') })
    const located = await h.host.api.locateOriginalFile({ id, kind: 'file', field: 'path' })
    expect(readFileSync(located, 'utf8')).toBe(readFileSync(source, 'utf8'))
    expect(await h.host.api.takeoutPreview([id])).toMatchObject({ files: 1, problems: [] })
    h.host.api.run('file', 'rename', { names: { [id]: '改名' } })
    expect(h.host.store.blocksOf(id).file.data.name).toBe('改名.md')
    expect(h.host.store.blocksOf(id).file.data.path).toBe(String(file.path).replaceAll('/', '\\'))
    h.host.api.undo(); expect(existsSync(located)).toBe(true)
    h.host.api.redo(); await h.host.scheduler.idle()
    h.host.api.trash([id]); await h.host.api.purge([id])
    expect(readFileSync(located, 'utf8')).toBe(readFileSync(source, 'utf8'))
    expect(h.host.api.undo()).toBeNull()
  })
})
