import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, ipcMain } from 'electron'
import { PLUGINS } from '../plugins/manifest'
import { DISTRIBUTION } from '../plugins/generated/distribution'
import { PresetCatalog } from '../plugin-packages/preset-catalog'
import { PresetApplications, samePluginSelection } from '../plugin-packages/preset-applications'
import { createVaultSchema, type VaultResult } from '../shared/library-creation'
import { LibraryCreations, type CreationJob, type ExternalCreation, type ApplicationCreationBackend } from './library-creation-state'
import { blockPackage, developmentPackages, localPackages, localSuites } from './plugin-packages'
import { openLibrary, openLibraries, type LibraryOpenOptions } from './libraries'
import { trustedWindow } from './trusted-window'
import { closeLauncher } from './launcher'
import { callCore } from './core-client'
import { FileSpace } from '../storage/file-space'
import { loadWorkspace } from './workspace-storage'
import { isWindowReady } from './page-lifecycle'

const stores = () => ({
  jobs: new LibraryCreations(join(app.getPath('userData'), 'library-creations')),
  schemes: new PresetCatalog(app.getPath('userData'), localSuites()),
  arrangements: new PresetApplications(join(app.getPath('userData'), 'preset-applications'))
})
const running = new Map<string, Promise<VaultResult>>()
let suspended = false
const authorities = new Map<string, (job: CreationJob) => void>()
export function registerCreationAuthority(namespace: string, check: (job: CreationJob) => void) {
  authorities.set(namespace, check)
  return () => authorities.delete(namespace)
}
export async function suspendCreations() { suspended = true; await Promise.allSettled([...running.values()]) }
export const allowCreations = () => { suspended = false }
export const pendingCreations = () => { const { jobs } = stores(); return jobs.list().map(j => jobs.describe(j)) }
export function previewCreation(raw?: unknown, plugins?: import('../shared/library-creation').CreateVaultInput['plugins']) {
  const packs = localPackages()
  return stores().schemes.previewNew(raw, PLUGINS, DISTRIBUTION, packs.list(), packs.bundled(), plugins)
}
function checkSpace(root?: string, libraryId?: string) {
  if (!root) return
  const space = new FileSpace(realpathSync(root))
  try {
    const info = space.info()
    if (info.mode === 'private' && !!space.db.prepare('SELECT 1 FROM members WHERE library_id != ? LIMIT 1').get(libraryId ?? '')) throw new Error('该独享空间已属于其他仓库；请先改为共享或选择其他空间')
    return info.id
  } finally { space.close() }
}
/** 只固定已预演的配置；先落任务，再由同一接续入口认领目录。 */
export function prepareCreation(raw: unknown, external?: ExternalCreation): CreationJob {
  if (suspended) throw new Error('[SERVICE_UNAVAILABLE] 应用正在退出')
  const { jobs } = stores()
  const input = createVaultSchema.parse(raw), parent = realpathSync(resolve(input.parent)), root = join(parent, input.name)
  if (external && existsSync(root)) throw new Error('[TARGET_EXISTS] 创建目标已存在，不会接管或覆盖')
  if (jobs.list().some(j => j.root === root)) throw new Error('这个位置有未完成的创建，请从接续列表继续')
  if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() || readdirSync(root).some(f => f !== '.DS_Store'))) throw new Error('目标位置已有内容；已有仓库请用“打开”，不会覆盖')
  const preview = previewCreation(input.preset, input.plugins)
  if (input.previewRevision && preview.revision !== input.previewRevision) throw new Error('方案或已安装插件已变化，请重新预览')
  if ((input.preset || input.plugins) && !input.previewRevision) throw new Error('请先预览起始方案')
  if (preview.issues.length) throw new Error(preview.issues.join('；'))
  const spaceId = checkSpace(input.spaceRoot)
  if (input.spaceId && input.spaceId !== spaceId) throw new Error('所选文件空间已改变，请重新选择')
  if (developmentPackages().links(root).length) throw new Error('此位置保留开发插件配置，请选择新的位置')
  const settings = { disabled: preview.selection.disabled, external: preview.selection.external.map(p => ({ ...localPackages().find(p.hash), enabled: p.enabled })) }
  for (const p of settings.external.filter(p => p.enabled)) localPackages().verify(p.hash)
  return jobs.write({
    id: randomUUID(), libraryId: randomUUID(), root, name: input.name, external,
    spaceRoot: input.spaceRoot ? realpathSync(input.spaceRoot) : undefined, spaceId,
    settings, selection: preview.selection, title: preview.preset?.title,
    arrangement: input.preset?.layout !== false && preview.preset?.layout ? { title: preview.preset.title, layout: preview.preset.layout } : undefined
  })
}
export async function createVault(raw: unknown, options: LibraryOpenOptions): Promise<VaultResult> {
  try { return await resumeCreation(prepareCreation(raw).id, options) }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
}
export function resumeCreation(id: string, options: LibraryOpenOptions, basic = false): Promise<VaultResult> {
  const known = running.get(id)
  if (known) return known
  const task = runCreation(id, options, basic).finally(() => running.delete(id))
  running.set(id, task)
  return task
}
async function runCreation(id: string, options: LibraryOpenOptions, basic: boolean): Promise<VaultResult> {
  const { jobs, arrangements } = stores()
  let job: CreationJob | undefined
  try {
    job = jobs.read(id)
    if (job.state === 'completed') return { ok: true }
    const checkpoint = (phase?: CreationJob['phase']) => {
      const current = jobs.read(id)
      if (phase) jobs.write({ ...current, phase })
      if (suspended) throw new Error('[SERVICE_UNAVAILABLE] 应用正在退出，任务可稍后接续')
      if (current.state === 'cancelled') throw new Error('[CREATION_CANCELLED] 接续已取消，已产生的数据保留')
      if (job!.external) {
        const authorize = authorities.get(job!.external.namespace)
        if (!authorize) throw new Error('[ACCESS_DISABLED] 应用接入尚未提供创建授权')
        authorize(job!)
      }
    }
    checkpoint(); jobs.write({ ...job, error: undefined }); jobs.claim(job); checkpoint('claimed')
    if (developmentPackages().links(job.root).length) throw new Error('创建期间出现开发来源，请先处理开发配置')
    const hashes = job.selection.external.filter(p => p.enabled).map(p => p.hash)
    if (basic && job.external) throw new Error('外部创建任务请先取消接续，再手动打开仓库')
    if (basic) for (const hash of hashes) blockPackage(job.root, hash, '起始方案未完成，暂未加载；可在仓库设置中重试启用')
    else {
      if (checkSpace(job.spaceRoot, job.libraryId) !== job.spaceId) throw new Error('文件空间身份已改变，请检查后再接续')
      for (const hash of hashes) {
        if (job.external && !packageAllowed(job.root, hash)) throw new Error('[PACKAGE_APPROVAL_REQUIRED] 起始方案包含未获准的插件包，请先在应用中处理授权')
        localPackages().verify(hash)
      }
      checkpoint()
      localPackages().ready(job.root) // 显式重试确认上次启动已结束，再解除阻断。
      localPackages().grantMany(job.root, hashes)
    }
    let prepared = false
    const prepare = async (core: import('electron').UtilityProcess, actual: string) => {
      checkpoint('initialized')
      if (actual !== job!.libraryId) throw new Error('创建位置的仓库身份已改变')
      if (!basic) {
        const plugins = await callCore(core, 'plugins')
        checkpoint()
        const expected = [...PLUGINS.filter(p => p.scope !== 'application' && !job!.selection.disabled.includes(p.id)).map(p => p.id), ...job!.selection.external.filter(p => p.enabled).map(p => p.id)]
        const failures = expected.filter(id => !plugins.some(p => p.id === id && p.enabled))
        if (failures.length) throw new Error('方案插件未能运行：' + failures.map(id => plugins.find(p => p.id === id)?.reason ?? id).join('；'))
        const bindings = await callCore(core, 'externalPlugins')
        checkpoint()
        const selected = { disabled: plugins.filter(p => !p.external && p.chosen).map(p => p.id), external: bindings.map(p => ({ id: p.manifest.id, hash: p.hash, enabled: p.enabled })) }
        if (!samePluginSelection(selected, job!.selection)) throw new Error('仓库选择已改变，不会覆盖；可先打开仓库再选择方案')
        if (job!.spaceRoot) {
          const spaceId = await callCore(core, 'linkFileSpace', job!.spaceRoot)
          checkpoint(); await callCore(core, 'setDefaultFileSpace', spaceId); checkpoint()
        }
        if (job!.arrangement) {
          const pending = arrangements.read(job!.root, actual)
          if (pending && pending.id !== job!.id) throw new Error('仓库已有另一份待应用的工作台安排；可先打开仓库处理，不会覆盖')
          const receipt = (await loadWorkspace(actual))?.presetApplication
          checkpoint()
          if (!pending && receipt !== job!.id) arrangements.start(job!.root, actual, job!.selection, job!.arrangement, job!.id)
        }
      } else {
        const pending = arrangements.read(job!.root, actual)
        if (pending?.id === job!.id) arrangements.cancel(job!.root, actual, pending.id)
      }
      prepared = true
    }
    const lib = await openLibrary(job.root, { ...options, initial: { id: job.id, libraryId: job.libraryId, settings: job.settings }, beforeAttach: prepare })
    if (!prepared) {
      await prepare(lib.core, lib.id)
      // 复用已有会话时，页面可能已完成首次 pending 查询。
      if (job.arrangement && !basic) lib.win.webContents.send('plugin-presets:changed')
    }
    checkpoint('assembled')
    jobs.finish(jobs.read(id))
    if (!job.external) closeLauncher()
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (job) {
      try { jobs.write({ ...jobs.read(id), error }) } catch { /* 原意图仍在；不要删除仓库或伪报回滚。 */ }
      return { error, recovery: jobs.describe({ ...job, error }) }
    }
    return { error }
  }
}
export function registerLibraryCreationIpc(show: () => boolean) {
  ipcMain.handle('creation:preview', (e, input: unknown, plugins?: import('../shared/library-creation').CreateVaultInput['plugins']) => { trustedWindow(e); return previewCreation(input, plugins) })
  ipcMain.handle('creation:pending', e => { trustedWindow(e); return pendingCreations() })
  ipcMain.handle('creation:create', (e, input: unknown) => { trustedWindow(e); return createVault(input, { show: show() }) })
  ipcMain.handle('creation:resume', (e, id: string) => { trustedWindow(e); return resumeCreation(id, { show: show() }) })
  ipcMain.handle('creation:open-basic', (e, id: string) => { trustedWindow(e); return resumeCreation(id, { show: show() }, true) })
  ipcMain.handle('creation:dismiss', (e, id: string) => {
    trustedWindow(e)
    if (running.has(id)) throw new Error('正在创建，请稍候')
    const { jobs, arrangements } = stores(), job = jobs.read(id)
    const pending = arrangements.read(job.root, job.libraryId)
    if (pending?.id === job.id) arrangements.cancel(job.root, job.libraryId, pending.id)
    jobs.finish(job, 'cancelled') // 只撤下接续意图，保留目录和已有数据。
  })
}

function packageAllowed(root: string, hash: string) {
  const packs = localPackages()
  return packs.automationAllowed(hash) || packs.authorization(root, hash) !== 'approval-required'
}
export const applicationCreations: ApplicationCreationBackend = {
  preview(input, root) {
    const preview = previewCreation(input.preset, input.plugins)
    const denied = preview.selection.external.filter(p => p.enabled && !packageAllowed(root, p.hash))
    return { ...preview, issues: [...preview.issues, ...denied.map(p => `[PACKAGE_APPROVAL_REQUIRED] 插件 ${p.id}（${p.hash.slice(0, 12)}）尚未获准用于新仓库，请在开始页「AI 托管」授信此套件，或在「AI 接入 · MCP → 插件包授信」选择该版本`)] }
  },
  prepare: prepareCreation,
  find: (namespace, requestId) => stores().jobs.list(true).find(j => j.external?.namespace === namespace && j.external.requestId === requestId),
  read: id => stores().jobs.read(id),
  async resume(id, guard) {
    guard()
    const job = stores().jobs.read(id)
    const result = await resumeCreation(id, { show: !job.external!.background, background: job.external!.background })
    if ('error' in result) throw new Error(result.error)
  },
  cancel(id) {
    const { jobs, arrangements } = stores(), job = jobs.read(id)
    if (job.state !== 'pending') return
    // 先记录取消；正在等待的阶段返回后先检查此状态，再做后续副作用。
    jobs.finish(job, 'cancelled')
    const pending = arrangements.read(job.root, job.libraryId)
    if (pending?.id === job.id) arrangements.cancel(job.root, job.libraryId, job.id)
  },
  async inspect(id) {
    const job = stores().jobs.read(id), lib = openLibraries().find(l => l.id === job.libraryId && l.root === job.root)
    const alive = !!lib && !lib.offline && !lib.reloading && lib.core.pid !== undefined && !lib.win.isDestroyed()
    const layoutPending = job.arrangement && job.state !== 'cancelled' && (
      stores().arrangements.read(job.root, job.libraryId)?.id === job.id ||
      job.state === 'pending' && (await loadWorkspace(job.libraryId))?.presetApplication !== job.id
    )
    return { running: running.has(id), runtime: {
      core: alive ? 'running' : 'stopped', visible: !!lib && !lib.win.isDestroyed() && lib.win.isVisible(),
      workbench: !lib || lib.win.isDestroyed() ? 'closed' : !alive || !isWindowReady(lib.win) ? 'loading' : layoutPending ? 'layout-pending' : 'ready'
    } }
  }
}
