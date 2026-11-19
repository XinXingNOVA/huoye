import { localSuites } from './plugin-packages'
import { PresetCatalog } from '../plugin-packages/preset-catalog'
import { createHash } from 'node:crypto'
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { applyPresetSelection } from '../plugin-packages/presets'
import { PresetApplications, arrangementSchema, samePluginSelection } from '../plugin-packages/preset-applications'
import { capturePluginSelection, planPluginPreset, selectionIssues, validateSelection, type PresetEnvironment } from '../shared/plugin-preset-plan'
import { canonical, type PackageChanges } from '../shared/external-plugins'
import { presetLayoutSchema, type PluginPresetMode, type PluginSelection, type PresetArrangement } from '../shared/plugin-presets'
import type { OpenLibrary } from './libraries'
import { reloadLibrary } from './libraries'
import { prepareWindow, resumeWindow } from './page-lifecycle'
import { trustedWindow } from './trusted-window'
import { loadWorkspace } from './workspace-storage'
import { registerWorkbenchControl } from './workbench-control'

export interface LibraryPluginState {
  env: PresetEnvironment & { disabled: string[] }; selection: PluginSelection; revision: string; development: string[]
}
export let libraryPluginConfiguration: {
  read(lib: OpenLibrary): Promise<LibraryPluginState>
  apply(lib: OpenLibrary, raw: PluginSelection, revision: string, arrangement?: PresetArrangement, guard?: () => void, forceReload?: boolean): Promise<{ reloaded: boolean }>
  pending(lib: OpenLibrary): Promise<import('../shared/plugin-presets').PendingPresetArrangement | undefined>
  pendingId(lib: OpenLibrary): string | undefined
  problems(lib: OpenLibrary, selection: PluginSelection): Promise<string[]>
}

const optionsSchema = z.object({ description: z.string().max(2000).optional(), layout: presetLayoutSchema.nullable().optional() }).strict()
export function registerPluginPresetIpc(options: {
  from(e: IpcMainInvokeEvent): OpenLibrary
  locked<T>(lib: OpenLibrary, fn: () => Promise<T>): Promise<T>
  environment(lib: OpenLibrary): Promise<PresetEnvironment & { disabled: string[] }>
  runtimeProblems(lib: OpenLibrary, selection: PluginSelection): Promise<string[]>
  commit(lib: OpenLibrary, settings: PackageChanges, guard?: () => void): Promise<void>
}) {
  registerWorkbenchControl()
  const schemes = new PresetCatalog(app.getPath('userData'), localSuites()), catalog = schemes.users
  const applications = new PresetApplications(join(app.getPath('userData'), 'preset-applications'))
  const changed = () => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('plugin-presets:changed') }
  const from = (e: IpcMainInvokeEvent) => { trustedWindow(e); return options.from(e) }
  const list = () => schemes.list()
  const get = (id: string) => schemes.get(id)
  const editable = (id: string) => { if (get(id).editable === false) throw new Error('套件原版只读，请另存副本') }
  const read = async (lib: OpenLibrary) => {
    const env = await options.environment(lib)
    const selection: PluginSelection = { disabled: env.disabled, external: env.bindings.map(p => ({ id: p.manifest.id, hash: p.hash, enabled: p.enabled })) }
    const revision = createHash('sha256').update(canonical({ root: lib.root, selection, installed: env.installed.map(p => p.hash).sort(), development: env.development })).digest('hex')
    return { env, selection, revision, development: env.development.map(p => p.id) }
  }
  const pending = async (lib: OpenLibrary) => {
    const job = applications.read(lib.root, lib.id)
    if (!job) return undefined
    // 工作台已落盘时只清回执，不再要求插件状态相同，也不会覆盖之后的手动布局。
    const receipt = (await loadWorkspace(lib.id))?.presetApplication
    const state = await read(lib)
    const problems = receipt === job.id ? [] : !samePluginSelection(state.selection, job.selection)
      ? ['仓库的插件选择与此方案已不同，请取消后重新预览方案']
      : await options.runtimeProblems(lib, job.selection)
    if (applications.read(lib.root, lib.id)?.id !== job.id) return undefined
    return { id: job.id, title: job.title, layout: job.layout, ...(problems.length ? { problem: problems.join('；') } : {}) }
  }
  ipcMain.handle('plugin-presets:list', e => { trustedWindow(e); return list() })
  ipcMain.handle('plugin-presets:current', async e => { const { env: _, ...snapshot } = await read(from(e)); return snapshot })
  ipcMain.handle('plugin-presets:save', async (e, title: string, selection?: PluginSelection, rawOptions?: unknown) => {
    const state = await read(from(e)), settings = optionsSchema.parse(rawOptions ?? {})
    const value = catalog.save(title, capturePluginSelection(selection ?? state.selection, state.env), settings)
    changed(); return value
  })
  ipcMain.handle('plugin-presets:copy', (e, id: string, title: string) => {
    from(e); const original = get(id), value = catalog.save(title, original.plugins, { description: original.description, layout: original.layout })
    changed(); return value
  })
  ipcMain.handle('plugin-presets:rename', (e, id: string, revision: string, title: string) => { from(e); editable(id); const value = catalog.rename(id, revision, title); changed(); return value })
  ipcMain.handle('plugin-presets:update', async (e, id: string, revision: string, selection?: PluginSelection, rawOptions?: unknown) => {
    const state = await read(from(e)); editable(id)
    const settings = optionsSchema.parse(rawOptions ?? {})
    const value = catalog.change(id, revision, { ...settings, ...('layout' in settings ? { layout: settings.layout ?? undefined } : {}), plugins: capturePluginSelection(selection ?? state.selection, state.env) })
    changed(); return value
  })
  ipcMain.handle('plugin-presets:remove', (e, id: string, revision: string) => { from(e); editable(id); catalog.change(id, revision); changed() })
  ipcMain.handle('plugin-presets:preview', async (e, id: string, mode: PluginPresetMode, base?: PluginSelection, versions?: PluginSelection['external']) => {
    const state = await read(from(e))
    return planPluginPreset(get(id), mode, base ?? state.selection, state.env, state.revision, versions)
  })
  const apply = async (lib: OpenLibrary, raw: PluginSelection, revision: string, rawArrangement?: PresetArrangement, guard: () => void = () => {}, forceReload = false) => {
    const arrangement = rawArrangement === undefined ? undefined : arrangementSchema.parse(rawArrangement)
    return options.locked(lib, async () => {
      let selection: PluginSelection, settings: PackageChanges, needsReload = false
      const check = async () => {
        guard()
        const current = await read(lib)
        guard()
        if (revision !== current.revision) throw new Error('仓库选择、安装包或开发来源已变化，请重新预演组合')
        if (applications.read(lib.root, lib.id)) throw new Error('还有未完成的方案，请先接续或取消')
        selection = validateSelection(raw, current.env)
        const issues = selectionIssues(selection, current.env)
        if (issues.length) throw new Error(issues.join('\n'))
        needsReload = forceReload || !samePluginSelection(selection, current.selection)
        settings = { disabled: selection.disabled, changes: selection.external.filter(p => {
          const old = current.selection.external.find(v => v.id === p.id)
          return forceReload || old?.hash !== p.hash || old.enabled !== p.enabled
        }).map(({ hash, enabled }) => ({ hash, enabled })) }
      }
      await check()
      if (!needsReload) {
        const problems = await options.runtimeProblems(lib, selection!)
        guard()
        if (problems.length) throw new Error(problems.join('；'))
        // 免重载仍使用同一条持久接续链，崩溃和保存失败都可重试。
        if (arrangement) applications.start(lib.root, lib.id, selection!, arrangement)
        changed(); return { reloaded: false }
      }
      let job: ReturnType<PresetApplications['start']> | undefined
      await applyPresetSelection({
        check,
        prepare: () => prepareWindow(lib.win, 'reload'),
        save: async () => {
          if (arrangement) job = applications.start(lib.root, lib.id, selection, arrangement)
          try { await options.commit(lib, settings, guard) }
          catch (e) {
            // RPC 拒绝可能发生在事务提交后；只有确认仍是旧选择才撤下接续意图。
            const actual = await read(lib).catch(() => undefined)
            if (job && actual && !samePluginSelection(actual.selection, selection)) applications.cancel(lib.root, lib.id, job.id)
            if (!actual || samePluginSelection(actual.selection, selection)) throw new Error(`[PLUGIN_PRESET_RELOAD] 保存结果需要核对；${job ? '配套布局接续已保留；' : ''}请重开仓库。${String(e)}`)
            throw e
          }
        },
        reload: () => { guard(); return reloadLibrary(lib) },
        resume: () => resumeWindow(lib.win)
      })
      return { reloaded: true }
    })
  }
  libraryPluginConfiguration = { read, apply, pending, pendingId: lib => applications.read(lib.root, lib.id)?.id, problems: options.runtimeProblems }
  ipcMain.handle('plugin-presets:apply', (e, raw: PluginSelection, revision: string, arrangement?: PresetArrangement) => apply(from(e), raw, revision, arrangement))
  ipcMain.handle('plugin-presets:pending', e => pending(from(e)))
  ipcMain.handle('plugin-presets:retry-pending', async (e, id: string) => {
    const lib = from(e), job = await pending(lib)
    if (!job || job.id !== id) throw new Error('待接续方案已改变，请刷新')
    if (job.problem) throw new Error(job.problem)
    changed()
  })
  ipcMain.handle('plugin-presets:finish', async (e, id: string) => {
    const lib = from(e)
    applications.finish(lib.root, lib.id, id, (await loadWorkspace(lib.id))?.presetApplication); changed()
  })
  ipcMain.handle('plugin-presets:cancel-pending', async (e, id: string) => {
    const lib = from(e)
    await options.locked(lib, async () => { applications.cancel(lib.root, lib.id, id); changed() })
  })
}
