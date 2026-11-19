import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DevelopmentProjects } from './development-projects'
import { realpathSync } from 'node:fs'
import type { DevelopmentBackend, DevelopmentTarget } from '../shared/development-access'
import { developmentSchemas } from '../shared/development-access'
import { canonical } from '../shared/external-plugins'
import { developmentDirectories, developmentPackages, localPackages, withPluginConfiguration } from './plugin-packages'
import { closeLibrary, openLibraries, reloadLibrary, type OpenLibrary } from './libraries'
import { isWindowReady, isWindowPrepared, prepareWindow, resumeWindow } from './page-lifecycle'
import { workbenchContentWindow, workbenchSessionWindows } from './auxiliary-windows'
import { libraryStatus } from './library-status'
import { DevelopmentTasks } from './development-tasks'
import { libraryPluginConfiguration } from './plugin-presets'

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const sourceKey = (source: string, pluginId: string) => digest({ source, pluginId })
const findLibrary = (target: DevelopmentTarget) => openLibraries().find(l => l.id === target.libraryId && l.root === target.root)
function sessionLibrary(target: DevelopmentTarget, session?: string): OpenLibrary {
  const lib = findLibrary(target)
  if (!lib || lib.win.isDestroyed()) throw new Error('[LIBRARY_OFFLINE] 请先打开验收仓库')
  if (session && lib.packageToken !== session) throw new Error('[SESSION_CHANGED] 仓库已重开或重载，请重新读取开发状态')
  if (lib.reloading || lib.closing || !isWindowReady(lib.win)) throw new Error('[LIBRARY_BUSY] 工作台尚未就绪或正在处理生命周期操作')
  return lib
}
export function createDevelopmentAccess(directory: string, track: (task: Promise<void>) => void): DevelopmentBackend {
  const tasks = new DevelopmentTasks(directory, track)
  const projects = new DevelopmentProjects(join(dirname(directory), 'development-projects'))
  const allowedSources = (target: DevelopmentTarget) => {
    const sources = new Map(target.grant.sources.map(s => [s.key, { ...s, toolchain: target.grant.toolchain, autonomous: false }]))
    if (target.projectToolchain) for (const p of projects.sources(target)) {
      const key = sourceKey(p.source, p.pluginId)
      sources.set(key, { ...p, key, toolchain: target.projectToolchain, autonomous: true })
    }
    return [...sources.values()]
  }
  const conflictsWithRelease = (id: string) => localPackages().isReserved(id) || localPackages().list().some(p => p.manifest.id === id)
  const snapshot = (target: DevelopmentTarget) => {
    const state = developmentDirectories().state(target.root, true), links = developmentPackages().links(target.root)
    const rows = allowedSources(target).map(allowed => {
      const row = state.rows.find(r => r.source === allowed.source && r.id === allowed.pluginId)
      return { sourceId: allowed.key, source: allowed.source, pluginId: allowed.pluginId, title: row?.title ?? allowed.pluginId,
        build: row?.build, availableHash: row?.availableHash, appliedHash: links.find(l => l.source === allowed.source)?.hash,
        problem: (allowed.autonomous && conflictsWithRelease(allowed.pluginId) ? '插件 ID 已被正式包占用' : row?.problem) ?? (!row ? '来源不在当前开发目录或插件身份已变化' : undefined) }
    })
    return { sources: rows, revision: digest({ root: target.root, directories: state.directories, toolchain: state.toolchain, rows, links }),
      problem: state.problem ? '开发目录或工具工程不可用，请在本机插件设置中检查' : undefined }
  }
  const checkSources = (target: DevelopmentTarget, keys: string[]) => {
    const state = developmentDirectories().state(target.root, true)
    if (new Set(keys).size !== keys.length) throw new Error('[INVALID_INPUT] 开发来源不能重复')
    const sources = allowedSources(target)
    return keys.map(key => {
      const approved = sources.find(s => s.key === key)
      if (!approved) throw new Error('[SOURCE_DENIED] 此来源未获准用于验收仓库')
      if (!approved.toolchain || !state.toolchain || realpathSync(state.toolchain) !== approved.toolchain) throw new Error('[TOOLCHAIN_CHANGED] 开发工具工程已变化，请重新授权')
      if (approved.autonomous && conflictsWithRelease(approved.pluginId)) throw new Error('[PLUGIN_ID_CONFLICT] 插件 ID 已被正式包占用')
      const row = state.rows.find(r => r.source === approved.source && r.id === approved.pluginId)
      if (!row || row.problem || realpathSync(approved.source) !== approved.source) throw new Error('[SOURCE_CHANGED] 开发来源已变化，请在本机设置核对')
      return approved.source
    })
  }
  const inspect = async (target: DevelopmentTarget, guard: () => void, requestId?: string) => {
    const lib = findLibrary(target)
    const result = { libraryId: target.libraryId, ...(lib && !lib.win.isDestroyed() ? { session: lib.packageToken } : {}),
      runtime: lib ? await libraryStatus(lib, ['workbench', 'plugins', 'errors']) : { libraryId: target.libraryId, core: 'closed' as const },
      ...snapshot(target), ...(requestId ? { request: tasks.read(requestId, target.libraryId, target.root) } : {}) }
    guard(); return result
  }
  return {
    resolveToolchain: path => developmentDirectories().requireToolchain(path),
    sources(root) {
      const state = developmentDirectories().state(root, true)
      return { toolchain: state.toolchain, problem: state.problem,
        sources: state.rows.filter(row => row.id).map(row => ({ key: sourceKey(row.source, row.id!), source: row.source, pluginId: row.id!, title: row.title, problem: row.problem })) }
    },
    async execute(action, raw, target, guard) {
      guard()
      if (action === 'create_development_project') {
        const input = developmentSchemas.create_development_project.parse(raw), lib = sessionLibrary(target)
        return withPluginConfiguration(lib, async () => {
          guard()
          if (!target.projectToolchain) throw new Error('[PROJECT_DENIED] 此仓库未获自主开发许可')
          const directories = developmentDirectories(), toolchain = directories.requireToolchain(target.projectToolchain)
          if (toolchain !== target.projectToolchain) throw new Error('[TOOLCHAIN_CHANGED] 获准的开发工具工程位置已改变')
          const state = directories.state(target.root, true)
          const prior = projects.sources(target).find(p => p.pluginId === input.pluginId)
          if (conflictsWithRelease(input.pluginId) || state.rows.some(r => r.id === input.pluginId && r.source !== prior?.source)) throw new Error('[PLUGIN_ID_CONFLICT] 插件 ID 已被使用，请选择其他 ID')
          if ((state.directories?.length ?? 0) >= 32 && !state.directories?.includes(prior?.source ?? '')) throw new Error('[PROJECT_LIMIT] 本库开发目录已满，请先整理目录')
          const source = projects.create(target, input)
          await directories.addProjectSource(target.root, source, toolchain, guard)
          guard()
          return { libraryId: target.libraryId, pluginId: input.pluginId, source, toolchain, sourceId: sourceKey(source, input.pluginId) }
        })
      }
      if (action === 'get_development_status') return inspect(target, guard, developmentSchemas[action].parse(raw).requestId)
      if (action === 'prepare_development_build') {
        const input = developmentSchemas[action].parse(raw), lib = sessionLibrary(target)
        await withPluginConfiguration(lib, async () => {
          guard(); const sources = checkSources(target, input.sourceIds)
          await developmentDirectories().prepare(target.root, sources, input.retry)
          guard()
        })
        return inspect(target, guard)
      }
      if (action === 'capture_workbench_window') {
        const input = developmentSchemas[action].parse(raw), lib = sessionLibrary(target, input.session)
        const win = workbenchContentWindow(lib.win, input.windowId)
        const check = () => {
          guard(); sessionLibrary(target, input.session)
          if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || workbenchContentWindow(lib.win, input.windowId) !== win) throw new Error('[WINDOW_UNAVAILABLE] 只能截取已显示的验收内容窗口')
          if (workbenchSessionWindows(lib.win).revision !== input.windowRevision) throw new Error('[CONTEXT_CHANGED] 窗口状态已变化，请重新读取工作台会话')
        }
        check()
        const captured = await win!.webContents.capturePage()
        check()
        if (captured.isEmpty()) throw new Error('[CAPTURE_UNAVAILABLE] 当前没有可用画面')
        const size = captured.getSize(), scale = Math.min(1, input.maxSide / Math.max(size.width, size.height))
        const output = captured.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) })
        const bytes = output.toJPEG(80)
        if (bytes.length > 2 * 1024 * 1024) throw new Error('[CAPTURE_TOO_LARGE] 请降低截图尺寸')
        check()
        return { libraryId: target.libraryId, windowId: input.windowId, session: input.session, windowRevision: input.windowRevision, capturedAt: new Date().toISOString(),
          image: { data: bytes.toString('base64'), mimeType: 'image/jpeg', ...output.getSize() } }
      }
      if (action === 'control_library') {
        const input = developmentSchemas[action].parse(raw)
        return tasks.submit(action, input, target.root, async () => {
          guard(); const lib = sessionLibrary(target, input.session)
          const check = () => { guard(); if (lib.packageToken !== input.session || !openLibraries().includes(lib)) throw new Error('[SESSION_CHANGED] 仓库会话已变化') }
          await withPluginConfiguration(lib, () => input.action === 'close' ? closeLibrary(lib, check) : reloadLibrary(lib, check))
        })
      }
      const input = developmentSchemas.apply_development_build.parse(raw)
      return tasks.submit('apply_development_build', input, target.root, async saved => {
        guard(); const lib = sessionLibrary(target, input.session)
        await withPluginConfiguration(lib, async () => {
          const check = () => {
            guard(); sessionLibrary(target, input.session)
            if (snapshot(target).revision !== input.revision) throw new Error('[PREVIEW_CHANGED] 开发构建或选择已变化，请重新读取状态')
            return checkSources(target, input.selection.map(s => s.sourceId))
          }
          try {
            if (await libraryPluginConfiguration.pending(lib)) throw new Error('[LIBRARY_BUSY] 请先接续或取消待完成的方案')
            check(); await prepareWindow(lib.win, 'reload')
            const sources = check()
            if (!isWindowPrepared(lib.win)) throw new Error('[RELOAD_CANCELLED] 页面保存或重载已取消')
            developmentDirectories().apply(target.root, input.selection.map((s, i) => ({ source: sources[i], hash: s.hash })), allowedSources(target).map(s => s.source))
            saved()
            await reloadLibrary(lib, () => { guard(); if (lib.packageToken !== input.session) throw new Error('[SESSION_CHANGED] 仓库会话已变化') })
          } catch (error) { resumeWindow(lib.win); throw error }
        })
      })
    }
  }
}
