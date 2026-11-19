import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { app } from 'electron'
import { canonical } from '../shared/external-plugins'
import { localManagementSchema, managementSchemas, type AllowedSpace, type LibraryConfiguration, type ManagementAction, type ManagementSettings } from '../shared/application-management'
import { pluginSelectionSchema } from '../shared/plugin-presets'
import { planPluginPreset, selectionIssues, validateSelection } from '../shared/plugin-preset-plan'
import { samePluginSelection } from '../plugin-packages/preset-applications'
import { ManagedInstallations } from '../plugin-packages/managed-installations'
import { PresetCatalog } from '../plugin-packages/preset-catalog'
import { FileSpace } from '../storage/file-space'
import { localPackages, localSuites, packagesChanged } from './plugin-packages'
import { assertNoPackageUpdate } from './plugin-updates'
import { libraryPluginConfiguration } from './plugin-presets'
import { openLibraries } from './libraries'
import { callCore } from './core-client'
import { createWorkbenchControl } from './workbench-control'

const inFlight = new Set<Promise<unknown>>()
let suspended = false
export async function suspendApplicationManagement() { suspended = true; await Promise.allSettled([...inFlight]) }
export function allowApplicationManagement() { suspended = false }

export interface ManagementBackend {
  call(action: ManagementAction, input: unknown, guard: () => void, root?: string): Promise<unknown>
  local(input: unknown): ManagementSettings
}
const request = managementSchemas.configure_library_plugins
const taskSchema = request.extend({ root: z.string(), signature: z.string(), before: pluginSelectionSchema, state: z.enum(['pending', 'completed', 'cancelled']), saved: z.boolean(), error: z.string().optional() }).strict()
type Task = z.infer<typeof taskSchema>
const spacesSchema = z.array(z.object({ id: z.string().uuid(), root: z.string(), name: z.string() }).strict())
function write(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); renameSync(temp, file) }
  finally { rmSync(temp, { force: true }) }
}

export function createApplicationManagement(namespace: string): ManagementBackend {
  const directory = join(app.getPath('userData'), namespace, 'management')
  const installs = new ManagedInstallations(join(directory, 'installations'), localPackages(), localSuites())
  const schemes = new PresetCatalog(app.getPath('userData'), localSuites())
  const workbench = createWorkbenchControl(join(directory, 'workbenches'))
  const running = new Map<string, Promise<LibraryConfiguration>>()
  const spaceFile = join(directory, 'spaces.json')
  const spaces = (): AllowedSpace[] => existsSync(spaceFile) ? spacesSchema.parse(JSON.parse(readFileSync(spaceFile, 'utf8'))) : []
  const taskFile = (id: string) => join(directory, 'configurations', managementSchemas.get_package_installation.parse({ requestId: id }).requestId + '.json')
  const readTask = (id: string) => taskSchema.parse(JSON.parse(readFileSync(taskFile(id), 'utf8')))
  const saveTask = (task: Task) => {
    if (existsSync(taskFile(task.requestId)) && readTask(task.requestId).state === 'cancelled') task.state = 'cancelled'
    write(taskFile(task.requestId), task)
  }
  const cancelTask = (task: Task) => { if (task.state === 'pending') saveTask({ ...task, state: 'cancelled' }) }
  const pendingTasks = () => {
    const folder = join(directory, 'configurations')
    return existsSync(folder) ? readdirSync(folder).filter(f => f.endsWith('.json')).map(f => readTask(f.slice(0, -5))).filter(t => t.state === 'pending') : []
  }
  const current = (id: string, root?: string) => {
    const lib = openLibraries().find(l => l.id === id && l.root === root && !l.win.isDestroyed())
    if (!lib || lib.reloading || lib.offline) throw new Error('[LIBRARY_OFFLINE] 请先打开仓库并等待重载完成')
    return lib
  }
  const permits = (root: string, hash: string) => localPackages().automationAllowed(hash) || localPackages().authorization(root, hash) !== 'approval-required'
  const checkPackages = (root: string, selection: Task['selection'], verify = false) => {
    for (const p of selection.external.filter(p => p.enabled)) {
      if (!permits(root, p.hash)) throw new Error(`[PACKAGE_APPROVAL_REQUIRED] ${p.id} 尚未获准，请在应用 AI 接入设置中处理`)
      if (verify) localPackages().verify(p.hash)
    }
  }
  const status = async (task: Task, guard: () => void): Promise<LibraryConfiguration> => {
    let runtimeProblems: string[] = [], layoutPending = false
    try {
      const lib = current(task.libraryId, task.root)
      const state = await libraryPluginConfiguration.read(lib)
      if (!samePluginSelection(state.selection, task.selection)) runtimeProblems.push('当前插件选择与本请求不同')
      runtimeProblems.push(...await libraryPluginConfiguration.problems(lib, task.selection))
      layoutPending = !!await libraryPluginConfiguration.pending(lib)
    } catch (e) { runtimeProblems.push(String(e)) }
    guard()
    const latest = readTask(task.requestId)
    return { requestId: task.requestId, libraryId: task.libraryId, state: latest.state, saved: latest.saved, error: latest.error, running: running.has(task.requestId), runtimeProblems, layoutPending }
  }
  const configure = async (raw: z.infer<typeof request>, root: string, guard: () => void): Promise<LibraryConfiguration> => {
    const signature = createHash('sha256').update(canonical(raw)).digest('hex')
    let task: Task
    const file = taskFile(raw.requestId)
    if (existsSync(file)) {
      task = readTask(raw.requestId)
      if (task.root !== root || task.signature !== signature) throw new Error('[REQUEST_CONFLICT] 同一请求不能更换仓库或插件配置')
      if (task.state !== 'pending') return status(task, guard)
    } else {
      const state = await libraryPluginConfiguration.read(current(raw.libraryId, root)); guard()
      if (state.revision !== raw.revision) throw new Error('[PREVIEW_CHANGED] 仓库或插件目录已变化，请重新预演')
      if (existsSync(file)) return configure(raw, root, guard)
      const selection = validateSelection(raw.selection, state.env), issues = selectionIssues(selection, state.env)
      if (issues.length) throw new Error(issues.join('；'))
      checkPackages(root, selection, true)
      task = { ...raw, root, signature, before: state.selection, state: 'pending', saved: false }
      saveTask(task)
    }
    const pending = running.get(raw.requestId)
    if (pending) return pending.then(result => ({ ...result, running: false }))
    const run = (async () => {
      const lib = current(task.libraryId, root)
      const check = () => {
        guard()
        if (readTask(task.requestId).state === 'cancelled') throw new Error('[CONFIGURATION_CANCELLED] 后续调整已取消，保留已保存的配置')
        if (!openLibraries().includes(lib) || lib.win.isDestroyed()) throw new Error('[LIBRARY_OFFLINE] 仓库已关闭')
        checkPackages(root, task.selection)
      }
      try {
        check(); checkPackages(root, task.selection, true)
        const state = await libraryPluginConfiguration.read(lib); check()
        const desired = samePluginSelection(state.selection, task.selection)
        if (!desired && (task.saved || !samePluginSelection(state.selection, task.before) || state.revision !== task.revision)) throw new Error('[CONFIGURATION_CHANGED] 仓库已被修改，不覆盖当前插件选择')
        task.error = undefined; saveTask(task)
        // 保存后响应丢失时按实际选择恢复，仅在原选择仍匹配时重载。
        await libraryPluginConfiguration.apply(lib, task.selection, desired ? state.revision : task.revision, undefined, check, desired && !!(await libraryPluginConfiguration.problems(lib, task.selection)).length)
        check(); task.saved = true
        const problems = await libraryPluginConfiguration.problems(lib, task.selection); check()
        if (problems.length) throw new Error(problems.join('；'))
        task.state = 'completed'; saveTask(task)
      } catch (e) {
        // RPC 失败可能晚于配置提交；读回真实选择，不把异常当作回滚。
        try { task.saved ||= samePluginSelection((await libraryPluginConfiguration.read(lib)).selection, task.selection) } catch { /* 核心离线时留待再次读回 */ }
        task.error = String(e); saveTask(task); guard()
      }
      return status(task, guard)
    })()
    running.set(raw.requestId, run); inFlight.add(run)
    try { const result = await run; return { ...result, running: false } }
    finally { running.delete(raw.requestId); inFlight.delete(run) }
  }
  const settings = (): ManagementSettings => {
    const installed = localPackages().list()
    const known = [...new Map([...installed, ...localPackages().automationPermissions()].map(p => [p.hash, p])).values()]
    return {
      suites: localSuites().list().map(({ manifest: m }) => ({ id: m.id, title: m.title, version: m.version,
        hashes: m.packages.map(p => p.hash) })),
      configurations: pendingTasks().map(({ requestId, libraryId, root, saved, error }) => ({ requestId, libraryId, root, saved, error })),
      installations: installs.list(), spaces: spaces(),
      packages: known.map(p => ({ ...p, installed: installed.some(i => i.hash === p.hash), allowed: localPackages().automationAllowed(p.hash), bundled: localPackages().isRelease(p.hash) }))
    }
  }
  return {
    local(raw) {
      const input = localManagementSchema.parse(raw)
      if (input.action === 'approve-installation') installs.approve(input.requestId)
      if (input.action === 'cancel-configuration') cancelTask(readTask(input.requestId))
      if (input.action === 'cancel-installation') installs.cancel(input.requestId)
      if (input.action === 'package-permission' || input.action === 'package-permissions') {
        const hashes = input.action === 'package-permission' ? [input.hash] : [...new Set(input.hashes)]
        const installed = localPackages().list(), known = [...installed, ...localPackages().automationPermissions()]
        const refs = hashes.map(hash => {
          const ref = known.find(p => p.hash === hash)
          if (!ref) throw new Error('插件未登记，请刷新许可列表')
          if (input.allowed) localPackages().verify(hash)
          return ref
        })
        localPackages().setAutomationPermission(refs, input.allowed)
      }
      if (input.action === 'allow-space') {
        const root = realpathSync(input.root), space = new FileSpace(root)
        try { write(spaceFile, [...spaces().filter(s => s.id !== space.id), { id: space.id, root, name: basename(root) }]) } finally { space.close() }
      }
      if (input.action === 'remove-space') write(spaceFile, spaces().filter(s => s.id !== input.spaceId))
      if (input.action !== 'list') packagesChanged()
      return settings()
    },
    async call(action, raw, authorize, root) {
      const guard = () => { authorize(); if (suspended) throw new Error('[SERVICE_UNAVAILABLE] 应用正在退出，稍后可继续原请求') }
      guard()
      if (action === 'preview_workbench') {
        const input = managementSchemas[action].parse(raw)
        return workbench.preview(current(input.libraryId, root), { action: 'preview', layout: input.layout }, guard)
      }
      if (action === 'get_workbench_configuration') {
        const input = managementSchemas[action].parse(raw)
        return workbench.get(current(input.libraryId, root), input.requestId, guard)
      }
      if (action === 'configure_workbench') {
        const input = managementSchemas[action].parse(raw), lib = current(input.libraryId, root)
        if (await libraryPluginConfiguration.pending(lib)) throw new Error('还有未完成的方案布局，请先接续或取消')
        guard()
        const run = workbench.configure(lib, input, guard)
        inFlight.add(run)
        try { return await run } finally { inFlight.delete(run) }
      }
      if (action === 'request_package_installation') { const input = managementSchemas[action].parse(raw); assertNoPackageUpdate(); return installs.request(input.requestId, input.paths) }
      if (action === 'get_package_installation') return installs.get(managementSchemas[action].parse(raw).requestId)
      if (action === 'install_packages') { const input = managementSchemas[action].parse(raw); assertNoPackageUpdate(); const result = installs.install(input.requestId); packagesChanged(); return result }
      if (action === 'list_allowed_file_spaces') return { spaces: spaces().map(({ root: _, ...s }) => s) }
      if (action === 'link_library_file_space') {
        const input = managementSchemas[action].parse(raw)
        const allowed = spaces().find(s => s.id === input.spaceId)
        if (!allowed || realpathSync(allowed.root) !== allowed.root) throw new Error('[SPACE_DENIED] 空间尚未允许关联或位置已变化')
        const lib = current(input.libraryId, root)
        const id = await callCore(lib.core, 'linkFileSpace', allowed.root, allowed.id)
        guard(); return { libraryId: lib.id, spaceId: id, linked: true }
      }
      if (action === 'get_library_configuration' || action === 'cancel_library_configuration') {
        const input = managementSchemas[action].parse(raw)
        const task = readTask(input.requestId)
        if (task.libraryId !== input.libraryId || task.root !== root) throw new Error('[ACCESS_DENIED] 此请求不属于目标仓库')
        if (action === 'cancel_library_configuration') cancelTask(task)
        return status(task, guard)
      }
      if (action === 'configure_library_plugins') return configure(managementSchemas[action].parse(raw), root!, guard)
      const input = managementSchemas.preview_library_plugins.parse(raw)
      const lib = current(input.libraryId, root), state = await libraryPluginConfiguration.read(lib); guard()
      const preset = input.preset ? schemes.get(input.preset.id) : { id: 'explicit', title: '指定组合', revision: 'explicit', plugins: input.plugins!.map(p => ({ ...p, title: p.id })) }
      if (input.preset && preset.revision !== input.preset.revision) throw new Error('[PREVIEW_CHANGED] 方案已变化')
      for (const p of input.plugins ?? []) if (p.hash && !state.env.installed.some(r => r.hash === p.hash && r.manifest.id === p.id)) throw new Error('所选摘要未安装')
      const preview = planPluginPreset(preset, input.mode, state.selection, state.env, state.revision, input.preset?.versions ?? input.plugins?.flatMap(p => p.hash ? [{ id: p.id, hash: p.hash, enabled: true }] : []))
      preview.issues.push(...preview.selection.external.filter(p => p.enabled && !permits(root!, p.hash)).map(p => `[PACKAGE_APPROVAL_REQUIRED] ${p.id} 尚未获准`))
      const pending = await libraryPluginConfiguration.pending(lib)
      if (pending) preview.issues.push(pending.problem
        ? `[LAYOUT_PENDING] ${pending.problem}`
        : '[LAYOUT_PENDING] 请查询 get_library_status 的 workbench，等到 ready 后重新预演。若布局持续待接续，可在仓库的插件组合中重试或取消')
      guard(); return { ...preview, current: state.selection }
    }
  }
}
