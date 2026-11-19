import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { z } from 'zod'
import type { RegisteredEditor } from '../shared/local-editors'
import { editorIdSchema } from '../shared/local-editors'

const registered = z.object({ id: z.string().uuid(), title: z.string().min(1), path: z.string().min(1) }).strict()
const schema = z.object({ version: z.literal(1), editors: z.array(registered).max(100),
  preferences: z.array(z.object({ library: z.string().min(1), format: z.string().min(1), editor: editorIdSchema }).strict()).max(5000) }).strict()
type Config = z.infer<typeof schema>

/** 单主进程、短同步提交；不缓存旧配置，写入成功才向窗口广播。 */
export class LocalEditors {
  constructor(private file: string, private platform = process.platform) {}
  private read(): Config {
    try {
      const bytes = readFileSync(this.file)
      if (bytes.length > 1024 * 1024) throw new Error('配置过大')
      return schema.parse(JSON.parse(bytes.toString('utf8')))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, editors: [], preferences: [] }
      throw new Error('[EDITOR_CONFIG] 编辑器配置无法读取，未重置或覆盖', { cause: e })
    }
  }
  private save(config: Config) {
    schema.parse(config)
    const bytes = JSON.stringify(config)
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('编辑器配置过大')
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = this.file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.file) }
    finally { rmSync(temporary, { force: true }) }
  }
  list(): RegisteredEditor[] { return this.read().editors }
  /** 路径只从主进程原生选择器进入。每次启动重新校验，丢失时不静默换应用。 */
  register(path: string): RegisteredEditor {
    const resolved = realpathSync(path)
    validateEditor(resolved, this.platform)
    const config = this.read(), old = config.editors.find(e => e.path === resolved)
    if (old) return old
    const editor = { id: randomUUID(), title: basename(resolved).replace(/\.(app|exe)$/i, ''), path: resolved }
    config.editors.push(editor); this.save(config); return editor
  }
  remove(id: string) {
    z.string().uuid().parse(id)
    const config = this.read()
    config.editors = config.editors.filter(e => e.id !== id)
    config.preferences = config.preferences.filter(p => p.editor !== id)
    this.save(config)
  }
  preferred(library: string, format: string) { return format ? this.read().preferences.find(p => p.library === library && p.format === format)?.editor : undefined }
  resolve(id: string): RegisteredEditor | undefined {
    editorIdSchema.parse(id)
    if (id === 'system') return
    const editor = this.read().editors.find(e => e.id === id)
    if (!editor) throw new Error('[EDITOR_MISSING] 编辑器已移除，请重新选择')
    validateEditor(editor.path, this.platform)
    return editor
  }
  remember(library: string, format: string, editor: string) {
    if (!format) throw new Error('无扩展名文件仅为本次选择编辑器')
    this.resolve(editor)
    const config = this.read()
    config.preferences = config.preferences.filter(p => p.library !== library || p.format !== format)
    config.preferences.push({ library, format, editor }); this.save(config)
  }
}

function validateEditor(path: string, platform: NodeJS.Platform) {
  if (!isAbsolute(path)) throw new Error('请选择本机应用程序')
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(path) } catch { throw new Error('[EDITOR_MISSING] 编辑器已移动或不可用，请重新选择') }
  if (platform === 'darwin') {
    if (!stat.isDirectory() || extname(path).toLowerCase() !== '.app' || !statSync(join(path, 'Contents', 'Info.plist')).isFile()) throw new Error('请选择 .app 应用程序')
  } else {
    if (!stat.isFile() || platform === 'win32' && extname(path).toLowerCase() !== '.exe') throw new Error('请选择编辑器程序（Windows 使用 .exe，不支持脚本或快捷方式）')
    if (platform !== 'win32') accessSync(path, constants.X_OK)
  }
}

/** 固定 argv；不经过 shell，不拼接命令，不启动传入的素材本身。 */
export function editorLaunchSpec(editor: RegisteredEditor, file: string, platform = process.platform) {
  return platform === 'darwin' ? { command: '/usr/bin/open', args: ['-a', editor.path, file] }
    : { command: editor.path, args: [file] }
}
export const editorLauncher = {
  async open(editor: RegisteredEditor, file: string): Promise<string> {
    validateEditor(editor.path, process.platform)
    const { command, args } = editorLaunchSpec(editor, file)
    if (process.platform === 'darwin') return new Promise(resolve => {
      execFile(command, args, { shell: false, timeout: 15000, maxBuffer: 64 * 1024 }, (error, _out, stderr) => resolve(error ? stderr.trim() || error.message : ''))
    })
    // 不等待编辑器退出：关闭应用不等于保存，也不表示用户已完成编辑。
    return new Promise(resolve => {
      const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', e => resolve(e.message))
      child.once('spawn', () => { child.unref(); resolve('') })
    })
  }
}
