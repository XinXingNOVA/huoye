import { libraryTaskSchema } from '../shared/library-task'
import { batchReviewSchema } from '../shared/batch-review'
import { managementSchemas, type ManagementAction } from '../shared/application-management'
import type { ManagementBackend } from './application-management'
import { fileActionSchema, fileReadActions } from '../shared/file-actions'
import type { FileEditCapabilities } from '../shared/file-edits'
import { applicationSpacePermissionSchema, type ApplicationSpacePermissionInput, type ApplicationSpacePermissionResult, fileSpaceGrantSchema } from '../shared/application-access'
// 应用级授权与仓库路由；不依赖 Electron，也不依赖 MCP 协议。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { accessMode, applicationSettingsSchema, createLibrarySchema, creationPolicySchema, type ApplicationAccessChange, type CreateLibraryReceipt } from '../shared/application-access'
import type { AccessConnection } from '../shared/external-access'
import type { ApplicationServiceContext, ExternalCaller } from '../plugin-api/service'
import { accessCapabilities, canOrganize, isExternalCoreMethod, operationDenied } from '../shared/external-access'
import { ecosystemCatalogSchema, type EcosystemCatalog, type EcosystemCatalogInput, type EcosystemEntry } from '../shared/ecosystem-catalog'
import { executeOperationSchema } from '../shared/automation'
import { itemLifecycleSchema } from '../shared/item-lifecycle'
import { canonical } from '../shared/external-plugins'
import { creationPreviewSchema, type ApplicationCreationPreview, type CreationPreviewInput } from '../shared/application-creation'
import type { ApplicationCreationBackend, CreationJob } from './library-creation-state'
import { libraryStatusSchema, type LibraryStatus, type LibraryStatusInput, type StatusSections } from '../shared/library-status'
import { processingWaitSchema, type ProcessingWaitInput, type ProcessingObservation } from '../shared/processing-status'
import { observedImportSchema, type ObservedImportInput, type ObservedImportReport } from '../shared/observed-import'
import { sessionReadSchema, sessionPresentSchema, type SessionRequest } from '../shared/workbench-session'
import { developmentGrantSchema, developmentSchemas, projectActions, setDevelopmentGrantSchema, type DevelopmentAction, type DevelopmentBackend, type DevelopmentInput, type SetDevelopmentGrant } from '../shared/development-access'

import { SourceChecks } from './source-checks'
import { DirectorySpaces } from '../storage/directory-spaces'
import { spaceItemQuery } from '../shared/space-items'
import { directoryPageSchema, directoryAdoptSchema, sourceCheckSchema, type SourceCheckInput } from '../shared/source-automation'

const grantSchema = z.object({ key: z.string(), libraryId: z.string(), root: z.string(), name: z.string(), mode: accessMode, fileSpaces: z.array(fileSpaceGrantSchema).default([]), development: developmentGrantSchema.optional(), projectToolchain: z.string().optional() })
const receiptSchema = z.object({ name: z.string(), root: z.string(), libraryId: z.string().optional(), error: z.string().optional() })
const stateSchema = z.object({ enabled: z.boolean(), developmentMode: z.boolean().default(false), projectToolchain: z.string().optional(), token: z.string().min(32), creation: creationPolicySchema,
  libraries: z.array(grantSchema), requests: z.record(z.string(), receiptSchema) })
type State = z.infer<typeof stateSchema>
export interface ApplicationLibrary { id: string; root: string; call: ExternalCaller; active(): boolean; status?(sections: StatusSections): Promise<LibraryStatus>; session?(request: SessionRequest, guard: () => void): Promise<unknown> }
export interface ApplicationAccessAdapter {
  development?: DevelopmentBackend
  creations?: ApplicationCreationBackend
  management?: ManagementBackend
  catalog?(root?: string): EcosystemEntry[] | Promise<EcosystemEntry[]>
  setSpacePermission?(root: string, libraryId: string, input: ApplicationSpacePermissionInput): Promise<ApplicationSpacePermissionResult>
  userData: string
  directories?: () => DirectorySpaces
  trackCheck?: (task: Promise<void>) => void
  sourceChecked?: (spaceId: string, directory: boolean) => void | Promise<void>
  namespace?: string
  active(): boolean
  libraries(): ApplicationLibrary[]
  open(root: string, expectedId?: string, background?: boolean): Promise<ApplicationLibrary>
}
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
const saveJson = (file: string, value: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(file + '.tmp', 0o600)
  renameSync(file + '.tmp', file)
}
type ApplicationAccessContract = ApplicationServiceContext['access']
export class ApplicationAccess implements ApplicationAccessContract {
  readonly configFile: string
  private file: string
  private state: State
  private endpoint = 'not-running'
  private pending = new Map<string, Promise<CreateLibraryReceipt>>()
  private directories = () => this.adapter.directories?.() ?? new DirectorySpaces(process.env.HUOYE_DIRECTORY_CATALOG ?? join(this.adapter.userData, 'file-spaces'))
  private checks: SourceChecks
  constructor(private adapter: ApplicationAccessAdapter) {
    this.checks = new SourceChecks(this.directories, adapter.trackCheck, adapter.sourceChecked)
    this.file = join(adapter.userData, adapter.namespace ?? 'mcp', 'application-state.json')
    this.configFile = join(adapter.userData, adapter.namespace ?? 'mcp', 'application.json')
    // 损坏配置不能静默重置授权、token 和请求记录。
    this.state = existsSync(this.file) ? stateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) : {
      enabled: false, developmentMode: false, token: randomBytes(32).toString('base64url'), creation: null, libraries: [], requests: {}
    }
  }
  private guard() { if (!this.adapter.active()) throw new Error('[SERVICE_UNAVAILABLE] 应用服务正在关闭') }
  private online() { this.guard(); if (!this.state.enabled) throw new Error('[ACCESS_DISABLED] 应用 MCP 已关闭') }
  private connection(state: State, endpoint: string) {
    const projects = state.creation?.autonomousDevelopment || state.libraries.some(g => g.mode === 'admin' && g.projectToolchain)
    return { libraryId: 'application', token: state.token, endpoint, mode: state.enabled ? 'organize' : 'off', tools: state.developmentMode ? 'development' : projects ? 'projects' : 'daily' }
  }
  private save(next: State, endpoint = this.endpoint) {
    this.guard()
    // connection 是派生配置，先更新它；权威状态落盘成功后才切换内存授权。
    saveJson(this.configFile, this.connection(next, endpoint))
    try { saveJson(this.file, next) }
    catch (error) {
      try { saveJson(this.configFile, this.connection(this.state, this.endpoint)) }
      catch (restoreError) { console.error('[application-access] 连接配置待重新发布，权威授权未改变', restoreError) }
      throw error
    }
    this.state = next; this.endpoint = endpoint
  }
  private update(change: (next: State) => void) {
    const next = structuredClone(this.state)
    change(next); this.save(next)
  }
  publishEndpoint(endpoint: string) { this.save(this.state, endpoint) }
  /** 核心启动后登记身份；新增路径默认未授权，已有应用授权保持。 */
  register(library: { id: string; root: string }) {
    this.guard()
    const root = resolve(library.root)
    const key = createHash('sha256').update(`${root}\0${library.id}`).digest('hex')
    if (this.state.libraries.some(g => g.key === key)) return
    this.update(next => { next.libraries.push({ key, libraryId: library.id, root, name: basename(root), mode: 'off', fileSpaces: [] }) })
  }
  private projectToolchain(selection?: string) {
    if (!this.adapter.development?.resolveToolchain) throw new Error('[TOOLCHAIN_UNAVAILABLE] 自主开发工具链未连接')
    const pinned = this.state.projectToolchain
    const source = this.adapter.development.resolveToolchain(selection ?? pinned)
    if (!selection && pinned && pinned !== source) throw new Error('[TOOLCHAIN_CHANGED] 开发工具工程位置已改变，请重新选择')
    return source
  }
  settings(input: ApplicationAccessChange = {}) {
    this.guard()
    const change = applicationSettingsSchema.parse(input)
    if (change.creation) {
      const parent = realpathSync(change.creation.parent)
      if (!statSync(parent).isDirectory()) throw new Error('新仓库位置必须是文件夹')
      change.creation = { ...change.creation, parent }
    }
    if (change.grant && !this.state.libraries.some(g => g.key === change.grant!.key)) throw new Error('此仓库尚未登记，请先在应用中打开一次')
    const toolchain = change.projectToolchain || change.creation?.autonomousDevelopment || change.grant?.autonomousDevelopment
      ? this.projectToolchain(change.projectToolchain) : undefined
    if (change.grant?.autonomousDevelopment && change.grant.mode !== 'admin') throw new Error('[ADMIN_REQUIRED] 自主开发需要管理仓库权限')
    if (Object.keys(change).length) this.update(next => {
      if (toolchain) next.projectToolchain = toolchain
      if (change.enabled !== undefined) next.enabled = change.enabled
      if (change.developmentMode !== undefined) next.developmentMode = change.developmentMode
      if (change.creation !== undefined) next.creation = change.creation
      const grant = change.grant && next.libraries.find(g => g.key === change.grant!.key)
      if (grant && change.grant?.autonomousDevelopment !== undefined) grant.projectToolchain = change.grant.autonomousDevelopment ? toolchain : undefined
      if (grant && change.grant) { grant.mode = change.grant.mode; if (change.grant.fileSpaces) grant.fileSpaces = change.grant.fileSpaces }
    })
    return structuredClone({ enabled: this.state.enabled, projectToolchain: this.state.projectToolchain, developmentMode: this.state.developmentMode, creation: this.state.creation, libraries: this.state.libraries.map(g => ({ ...g,
      open: this.adapter.libraries().some(l => l.id === g.libraryId && resolve(l.root) === g.root && l.active()) })) })
  }
  async developmentSources(key: string) {
    this.guard()
    const grant = this.state.libraries.find(g => g.key === key)
    if (!grant || !this.adapter.development) throw new Error('[UNAVAILABLE] 仓库或开发服务不可用')
    return this.adapter.development.sources(grant.root)
  }
  async setDevelopmentGrant(raw: SetDevelopmentGrant) {
    this.guard()
    const input = setDevelopmentGrantSchema.parse(raw), grant = this.state.libraries.find(g => g.key === input.key)
    if (!grant) throw new Error('[LIBRARY_UNKNOWN] 请先登记验收仓库')
    let development: import('../shared/development-access').DevelopmentGrant = { enabled: input.enabled, capture: input.enabled && input.capture, sources: [] }
    if (input.enabled && input.sourceIds.length) {
      const catalog = await this.developmentSources(input.key)
      if (catalog.problem || !catalog.toolchain) throw new Error(catalog.problem ?? '请先在仓库插件设置中选择开发工具工程')
      const sources = [...new Set(input.sourceIds)].map(key => {
        const row = catalog.sources.find(s => s.key === key)
        if (!row || row.problem || realpathSync(row.source) !== row.source) throw new Error('[SOURCE_CHANGED] 开发源码已变化，请刷新后选择')
        return { key, source: row.source, pluginId: row.pluginId }
      })
      development = { ...development, sources, toolchain: realpathSync(catalog.toolchain) }
    }
    this.guard()
    this.update(next => { next.libraries.find(g => g.key === input.key)!.development = development })
    return this.settings()
  }
  async development(action: DevelopmentAction, raw: unknown) {
    if (!Object.hasOwn(developmentSchemas, action)) throw new Error('[ACCESS_DENIED] 未开放的开发动作')
    const input = developmentSchemas[action].parse(raw) as DevelopmentInput, initial = this.grant(input.libraryId)
    const manualGrant = (g: typeof initial) => this.state.developmentMode && g.development?.enabled ? g.development : undefined
    const permission = (g: typeof initial) => JSON.stringify([g.projectToolchain, manualGrant(g)])
    const baseline = permission(initial)
    const guard = () => {
      const current = this.grant(input.libraryId)
      const manual = manualGrant(current)
      const autonomous = current.projectToolchain && projectActions.includes(action)
      if (action === 'create_development_project' && !autonomous) throw new Error('[PROJECT_DENIED] 此库未获准自主开发插件')
      if (!manual && !autonomous) throw new Error('[DEVELOPMENT_DISABLED] 需要此仓库的开发许可')
      if (current.mode !== 'admin') throw new Error('[ADMIN_REQUIRED] 开发验收需要管理仓库权限')
      if (current.key !== initial.key || permission(current) !== baseline) throw new Error('[DEVELOPMENT_CHANGED] 开发验收许可已变化，请重新读取')
      if (action === 'capture_workbench_window' && !current.development?.capture) throw new Error('[CAPTURE_DENIED] 此验收仓库未获准截取窗口')
    }
    guard()
    if (!this.adapter.development) throw new Error('[UNAVAILABLE] 开发服务不可用')
    const result = await this.adapter.development.execute(action, input, { libraryId: initial.libraryId, root: initial.root, projectToolchain: initial.projectToolchain,
      grant: structuredClone(manualGrant(initial) ?? { enabled: false, capture: false, sources: [] }) }, guard)
    guard()
    return result
  }
  async directorySources(libraryId: string) {
    const initial = this.grant(libraryId)
    const referenced = await this.call(libraryId, 'referencedDirectorySpaces')
    const current = this.grant(libraryId)
    if (current.key !== initial.key) throw new Error('[LIBRARY_CHANGED] 授权目标已变化')
    return this.directories().connections({ id: libraryId, root: current.root }, referenced).map(({ id, name, state }) => ({
      id, name, state, sourceKind: 'directory' as const,
      browseDirectory: state === 'active' && current.fileSpaces.some(s => s.spaceId === id && s.browseDirectory)
    }))
  }
  async checkSource(libraryId: string, raw: SourceCheckInput) {
    const input = sourceCheckSchema.parse(raw), initial = this.grant(libraryId)
    const lib = this.adapter.libraries().find(l => l.id === libraryId && resolve(l.root) === initial.root && l.active())
    if (!lib) throw new Error('[LIBRARY_OFFLINE] 请先打开目标仓库')
    const guard = () => {
      const g = this.grant(libraryId)
      if (g.key !== initial.key || !lib.active()) throw new Error('[LIBRARY_CHANGED] 核对目标已变化')
      if (input.action !== 'status' && !canOrganize(g.mode)) throw new Error('[READ_ONLY] 发起或停止核对需要整理权限')
    }
    guard()
    let managed: import('../shared/file-spaces').SpaceBindingInfo | undefined
    if (input.action === 'start') {
      managed = (await lib.call('listFileSpaces')).find(s => s.id === input.spaceId)
      if (managed ? managed.state !== 'active' || !!managed.error : !this.directories().list(lib).some(s => s.id === input.spaceId))
        throw new Error('[SPACE_NOT_LINKED] 空间未有效关联到此库')
    }
    guard()
    return this.checks.run(lib, initial.key, input, managed, guard)
  }

  async setSpacePermission(raw: ApplicationSpacePermissionInput): Promise<ApplicationSpacePermissionResult> {
    this.guard()
    const input = applicationSpacePermissionSchema.parse(raw)
    const grant = this.state.libraries.find(g => g.key === input.key)
    if (!grant) throw new Error('[LIBRARY_UNKNOWN] 请先在应用中打开目标仓库')
    const lib = this.adapter.libraries().find(l => l.id === grant.libraryId && resolve(l.root) === grant.root && l.active())
    if (!lib) throw new Error('[LIBRARY_OFFLINE] 请打开目标仓库后配置空间授权')
    const spaces = await lib.call('listFileSpaces')
    this.guard()
    if (!lib.active()) throw new Error('[LIBRARY_CHANGED] 仓库已关闭或重载，请重新确认')
    const space = spaces.find(s => s.id === input.spaceId && s.state === 'active' && !s.error)
    if (!space) throw new Error('[SPACE_NOT_LINKED] 空间未有效关联到目标仓库')
    if (!this.adapter.setSpacePermission) throw new Error('[UNAVAILABLE] 应用未提供空间授权设置')
    return this.adapter.setSpacePermission(space.root, lib.id, input)
  }
  authorize(credentials: Pick<AccessConnection, 'libraryId' | 'token'>): void {
    this.online()
    if (credentials.libraryId !== 'application') throw new Error('[CONFIG_RETIRED] 单仓库 MCP 连接已退役，请从应用设置重新复制连接配置')
    if (typeof credentials.token !== 'string' || !same(this.state.token, credentials.token)) throw new Error('[ACCESS_DENIED] 无效凭据')
  }
  private grant(id: string) {
    this.online()
    const found = this.state.libraries.filter(g => g.libraryId === id && g.mode !== 'off')
    if (found.length !== 1) throw new Error('[ACCESS_DENIED] 仓库未授权或身份重复，请在应用设置中核对')
    return found[0]
  }
  list() {
    this.online()
    return this.settings().libraries.filter(g => g.mode !== 'off').map(({ key: _, development: _development, projectToolchain: _toolchain, ...g }) => g)
  }
  async status(raw: LibraryStatusInput): Promise<LibraryStatus> {
    const { libraryId, sections } = libraryStatusSchema.parse(raw), g = this.grant(libraryId)
    const lib = this.adapter.libraries().find(l => l.id === libraryId && resolve(l.root) === g.root)
    const result: LibraryStatus = lib?.status ? await lib.status(sections) : { libraryId, core: lib?.active() ? 'running' : 'closed',
      ...(sections.includes('workbench') && !lib ? { workbench: { state: 'closed', visible: false } } : {}) }
    if (this.grant(libraryId).key !== g.key) throw new Error('[LIBRARY_CHANGED] 仓库授权目标已改变')
    return result
  }
  async workbench(libraryId: string, request: SessionRequest): Promise<unknown> {
    const action = request.action
    if (action !== 'read' && action !== 'present') throw new Error('[ACCESS_DENIED] 未开放的工作台动作')
    const input: SessionRequest = action === 'read' ? { action, input: sessionReadSchema.parse(request.input) } : { action, input: sessionPresentSchema.parse(request.input) }
    const grant = this.grant(libraryId)
    const lib = this.adapter.libraries().find(l => l.id === libraryId && resolve(l.root) === grant.root)
    const guard = () => {
      const current = this.grant(libraryId)
      if (current.key !== grant.key) throw new Error('[LIBRARY_CHANGED] 仓库授权目标已改变')
      if (action === 'present' && !accessCapabilities(current.mode).workbenchPresentation) throw new Error('[READ_ONLY] 推送工作台画面需要可整理权限')
      if (!lib?.active()) throw new Error('[WORKBENCH_NOT_READY] 仓库未打开或正在重载')
    }
    guard()
    if (!lib!.session) throw new Error('[WORKBENCH_NOT_READY] 工作台会话尚未就绪')
    const result = await lib!.session(input, guard)
    guard()
    return result
  }
  async processing(libraryId: string, raw: ProcessingWaitInput): Promise<ProcessingObservation> {
    const { waitMs, expectedRevisions, ...input } = processingWaitSchema.parse(raw)
    const started = performance.now()
    let snapshot = await this.call(libraryId, 'processingStatus', input)
    const session = snapshot.session
    const revisions = { ...Object.fromEntries(snapshot.items.map(item => [item.id, item.revision])), ...expectedRevisions }
    for (;;) {
      if (snapshot.session !== session) throw new Error('[LIBRARY_CHANGED] 等待期间仓库核心已更换，请重新查询')
      const items = snapshot.items.map(item => revisions[item.id] && revisions[item.id] !== item.revision && !['missing', 'trashed'].includes(item.state)
        ? { ...item, state: 'changed' as const } : item)
      const waitedMs = Math.round(performance.now() - started), pending = items.some(item => item.state === 'pending')
      if (!pending || items.some(item => item.state === 'changed') || waitedMs >= waitMs) {
        return { ...snapshot, items, waitedMs, timedOut: pending && !items.some(item => item.state === 'changed') && waitMs > 0 && waitedMs >= waitMs }
      }
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, waitMs - waitedMs)))
      // 每次轮询走同一授权路由；关闭、重载、撤销权限后不继续读取旧核心。
      snapshot = await this.call(libraryId, 'processingStatus', input)
    }
  }
  async importFiles(libraryId: string, raw: ObservedImportInput): Promise<ObservedImportReport> {
    const { waitMs, processingKinds, ...input } = observedImportSchema.parse(raw), grant = this.grant(libraryId)
    // 先取得持久回执。观察参数不传入核心，既不参与幂等签名，也不写进回执。
    const imported = await this.call(libraryId, 'importFiles', input)
    if (waitMs === undefined && processingKinds === undefined) return imported
    if (!imported.collect) return { ...imported, processingObservation: { state: 'not-collected' } }
    const ids = [...new Set(imported.items.map(item => item.id))]
    if (!ids.length) return { ...imported, processingObservation: { state: 'empty' } }
    let processingObservation: ObservedImportReport['processingObservation']
    try {
      processingObservation = { state: 'observed', ...await this.processing(libraryId, { ids, kinds: processingKinds ?? ['thumb'], waitMs: waitMs ?? 0 }) }
    } catch (error) {
      // 关库／观察超时不抹掉已经成功导入的事实；撤权仍拒绝返回内容。
      processingObservation = { state: 'unavailable', reason: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }
    }
    if (this.grant(libraryId).key !== grant.key) throw new Error('[LIBRARY_CHANGED] 仓库授权目标已改变')
    return { ...imported, processingObservation }
  }
  async catalog(raw: EcosystemCatalogInput = {}): Promise<EcosystemCatalog> {
    this.online()
    const input = ecosystemCatalogSchema.parse(raw)
    const prior = input.libraryId ? this.grant(input.libraryId) : undefined
    if (!this.adapter.catalog) throw new Error('[UNAVAILABLE] 应用能力目录尚未连接')
    const entries = await this.adapter.catalog(prior?.root)
    this.online()
    const current = input.libraryId ? this.grant(input.libraryId) : undefined
    if (prior && current?.key !== prior.key) throw new Error('[LIBRARY_CHANGED] 仓库授权目标已改变，请重新查询')
    const creation = structuredClone(this.state.creation)
    const target = current && { libraryId: current.libraryId, mode: current.mode, permissions: { ...accessCapabilities(current.mode), autonomousDevelopment: current.mode === 'admin' && !!current.projectToolchain } }
    const snapshot = createHash('sha256').update(JSON.stringify({ entries, creation, target })).digest('hex')
    if ((input.offset > 0 && !input.snapshot) || (input.snapshot && input.snapshot !== snapshot)) throw new Error('[CATALOG_CHANGED] 目录或授权已变化，请从首页重新读取')
    return { creation, target,
      supported: { defaultCreation: true, creationWithPreset: !!this.adapter.creations, backgroundCreation: !!this.adapter.creations, creationRecovery: !!this.adapter.creations, pluginConfiguration: !!this.adapter.management, packageInstallation: !!this.adapter.management, spaceAssociation: !!this.adapter.management, workbenchConfiguration: !!this.adapter.management },
      entries: entries.slice(input.offset, input.offset + input.limit), total: entries.length,
      nextOffset: input.offset + input.limit < entries.length ? input.offset + input.limit : null, snapshot }
  }
  async open(libraryId: string, background = true) {
    const g = this.grant(libraryId)
    if (!existsSync(join(g.root, 'library.db'))) throw new Error('[LIBRARY_OFFLINE] 仓库目录已移动或不存在')
    const lib = await this.adapter.open(g.root, libraryId, background)
    const current = this.grant(libraryId)
    if (current.key !== g.key || lib.id !== libraryId || resolve(lib.root) !== g.root || !lib.active()) throw new Error('[LIBRARY_CHANGED] 仓库身份已改变或正在关闭')
    return { libraryId, root: current.root, name: current.name, open: true, mode: current.mode }
  }
  call<K extends keyof import('../plugin-api/service').ExternalApi>(libraryId: string, method: K, ...args: Parameters<import('../plugin-api/service').ExternalApi[K]>): Promise<ReturnType<import('../plugin-api/service').ExternalApi[K]>>
  async call<K extends keyof import('../plugin-api/service').ExternalApi>(libraryId: string, method: K, ...args: Parameters<import('../plugin-api/service').ExternalApi[K]>) {
    const g = this.grant(libraryId)
    if (!isExternalCoreMethod(method)) throw new Error('[ACCESS_DENIED] 未开放的核心能力')
    const directoryWrite = method === 'prepareDirectoryAdoption' || method === 'commitDirectoryAdoption'
    const checkDirectoryGrant = () => {
      if (!directoryWrite && method !== 'directoryFilePage') return
      const current = this.grant(libraryId)
      if (current.key !== g.key) throw new Error('[LIBRARY_CHANGED] 授权目标已变化')
      if (directoryWrite && !canOrganize(current.mode)) throw new Error('[READ_ONLY] 收录文件需要整理权限')
      const input = directoryWrite ? directoryAdoptSchema.parse(args[0]) : directoryPageSchema.parse(args[0])
      if ('collectFilter' in input && ['collected','outdated','trashed'].includes(input.collectFilter ?? '')) return
      if (!current.fileSpaces.some(s => s.spaceId === input.spaceId && s.browseDirectory))
        throw new Error('[DIRECTORY_BROWSE_DENIED] 请在本库 MCP 细项授权中允许浏览未收录文件，或仅查询已收录文件')
    }
    checkDirectoryGrant()
    if (method === 'libraryTask' && !['list', 'get', 'diff'].includes(libraryTaskSchema.parse(args[0]).action) && !canOrganize(g.mode)) throw new Error('[READ_ONLY] 此仓库只允许读取任务清单')
    if (method === 'reviewBatch') {
      const { action } = batchReviewSchema.parse(args[0])
      if (action !== 'list' && action !== 'get' && !accessCapabilities(g.mode).reviewManage) throw new Error('[READ_ONLY] 此仓库只允许读取验收单')
    }
    if ((method === 'executeOperation' || method === 'adoptSpaceFiles' || method === 'importFiles' || method === 'applyItemLifecycle') && !canOrganize(g.mode)) throw new Error('[READ_ONLY] 此仓库只允许读取')
    const lib = this.adapter.libraries().find(l => l.id === libraryId && resolve(l.root) === g.root && l.active())
    if (!lib) throw new Error('[LIBRARY_OFFLINE] 请先使用 open_library 打开目标仓库')
    if (method === 'listSpaceItems') {
      const input = spaceItemQuery.parse(args[0])
      // 普通盘点只读本库；需要核对缺失时只访问这个库有权发现的来源。
      if (input.missingOnly && !(await lib.call('listFileSpaces')).some(s => s.id === input.spaceId)
        && !(await this.directorySources(libraryId)).some(s => s.id === input.spaceId))
        throw new Error('[SPACE_NOT_LINKED] 本库没有该来源')
      if (this.grant(libraryId).key !== g.key || !lib.active()) throw new Error('[LIBRARY_CHANGED] 授权目标已变化')
    }
    if (method === 'applyItemLifecycle' && itemLifecycleSchema.parse(args[0]).action === 'purge') throw new Error('[IRREVERSIBLE_DENIED] MCP 不提供永久清除，请在应用中明确处理')
    if (method === 'executeOperation') {
      const request = executeOperationSchema.parse(args[0])
      const description = await lib.call('describeLibrary')
      const current = this.grant(libraryId)
      if (current.key !== g.key || !lib.active()) throw new Error('[LIBRARY_CHANGED] 仓库已关闭、重载或授权目标改变，请重新读取')
      const operation = description.operations.find(op => op.name === request.operation)
      if (!operation) throw new Error('[UNAVAILABLE_OPERATION] 这个操作未开放或所属插件已停用')
      const denied = operationDenied(current.mode, operation.effect)
      if (denied) throw new Error(denied)
    }
    if (method === 'externalFileAction') {
      const request = fileActionSchema.parse(args[0])
      if (!fileReadActions.has(request.action) && !canOrganize(g.mode)) throw new Error('[READ_ONLY] 此仓库只允许读取')
      let spaceId: string | undefined, permission: 'revise' | 'recycle' | undefined
      if (request.action === 'prepare' && request.input.destination.mode === 'publish') {
        const caps = await lib.call('externalFileAction', { action: 'capabilities', input: { id: request.input.id } }) as FileEditCapabilities
        spaceId = caps.publish.spaceId; permission = 'revise'
      } else if (request.action === 'commit') {
        const target = await lib.call('externalFileAction', { action: 'editTarget', input: { editId: request.input.editId } }) as { spaceId: string; mode: string }
        if (target.mode === 'publish') { spaceId = target.spaceId; permission = 'revise' }
      } else if (request.action === 'restoreVersion' || request.action === 'applyLifecycle') {
        spaceId = request.input.spaceId; permission = request.action === 'restoreVersion' ? 'revise' : 'recycle'
      }
      // 异步发现目标后重新读取授权；远端不提供权限、路径或调用方身份。
      const current = this.grant(libraryId)
      if (current.key !== g.key || !lib.active()) throw new Error('[LIBRARY_CHANGED] 仓库已关闭、重载或授权目标改变')
      if (!fileReadActions.has(request.action) && !canOrganize(current.mode)) throw new Error('[READ_ONLY] 此仓库只允许读取')
      if (permission && !current.fileSpaces.some(s => s.spaceId === spaceId && s[permission!])) throw new Error(`[MCP_SPACE_DENIED] 请在应用 MCP 设置中单独授权此空间的${permission === 'revise' ? '原件更新' : '原件回收与恢复'}`)
      const result = await lib.call('externalFileAction', request)
      const latest = this.grant(libraryId)
      if (latest.key !== g.key || !lib.active()) throw new Error('[LIBRARY_OFFLINE] 仓库已关闭或目标改变；复用原请求核对结果')
      if (request.action === 'capabilities') {
        const caps = result as FileEditCapabilities
        if (!canOrganize(latest.mode)) return { ...caps, publish: { ...caps.publish, allowed: false, reason: 'MCP 仅有只读权限' }, copyTargets: [], copyReason: 'MCP 仅有只读权限' }
        if (!latest.fileSpaces.some(s => s.spaceId === caps.publish.spaceId && s.revise)) return { ...caps, publish: { ...caps.publish, allowed: false, reason: [caps.publish.reason, '应用 MCP 设置尚未授权此空间的原件更新'].filter(Boolean).join('；') } }
      }
      if (request.action === 'history' && (!canOrganize(latest.mode) || !latest.fileSpaces.some(s => s.spaceId === request.input.spaceId && s.revise))) return { ...(result as object), canRestore: false, blocked: '应用 MCP 设置尚未授权此空间的原件更新，或仓库仅可读' }
      if (request.action === 'previewLifecycle' && (!canOrganize(latest.mode) || !latest.fileSpaces.some(s => s.spaceId === request.input.spaceId && s.recycle))) return { ...(result as object), blocked: '应用 MCP 设置尚未授权此空间的原件回收与恢复，或仓库仅可读' }
      return result
    }
    // 调用入口提供来源说明；它不参与权限判断，也不改变请求签名。
    const callArgs = (['reviewBatch', 'importFiles', 'adoptSpaceFiles', 'applyItemLifecycle'].includes(method)
      ? [args[0], 'external'] : args) as Parameters<import('../plugin-api/service').ExternalApi[K]>
    const result = await lib.call(method, ...callArgs)
    checkDirectoryGrant()
    const current = this.grant(libraryId)
    if (current.key !== g.key || !lib.active()) throw new Error('[LIBRARY_OFFLINE] 仓库已关闭、重载或目标改变；写操作请复用 requestId 查询原回执')
    if (method === 'listFileSpaces') return (result as import('../shared/file-spaces').SpaceBindingInfo[]).map(s => ({ ...s, mcp: { revise: canOrganize(current.mode) && !!s.canRevise && current.fileSpaces.some(g => g.spaceId === s.id && g.revise), recycle: canOrganize(current.mode) && !!s.canRecycle && current.fileSpaces.some(g => g.spaceId === s.id && g.recycle) } }))
    if (method === 'describeLibrary') {
      const description = result as import('../shared/automation').LibraryDescription
      return { ...description, operations: description.operations.filter(op => !operationDenied(current.mode, op.effect)),
        blockedOperations: description.operations.flatMap(op => {
          const reason = operationDenied(current.mode, op.effect)
          return reason ? [{ name: op.name, title: op.title, reason }] : []
        }) }
    }
    return result
  }
  localManagement(input: unknown) {
    this.guard()
    if (!this.adapter.management) throw new Error('[UNAVAILABLE] 托管服务不可用')
    return this.adapter.management.local(input)
  }
  async manage(action: ManagementAction, raw: unknown) {
    this.online()
    if (!Object.hasOwn(managementSchemas, action) || !this.adapter.management) throw new Error('[UNAVAILABLE] 未开放的托管操作')
    const input = managementSchemas[action].parse(raw)
    const id = 'libraryId' in input ? input.libraryId : undefined
    const prior = id ? this.grant(id) : undefined
    const guard = () => {
      this.online()
      if (id) {
        const current = this.grant(id)
        if (current.key !== prior!.key) throw new Error('[LIBRARY_CHANGED] 目标仓库已变化')
        if (current.mode !== 'admin') throw new Error('[ADMIN_REQUIRED] 调整本库能力需要管理仓库权限')
      }
    }
    guard()
    const result = await this.adapter.management.call(action, input, guard, prior?.root)
    guard(); return result
  }
  private creationBackend() {
    if (!this.adapter.creations) throw new Error('[UNAVAILABLE] 应用建库服务尚未连接')
    return this.adapter.creations
  }
  private creationPolicy() {
    this.online()
    const policy = this.state.creation
    if (!policy) throw new Error('[ACCESS_DENIED] 请先在应用设置中指定允许新建仓库的位置')
    if (realpathSync(policy.parent) !== policy.parent) throw new Error('[ACCESS_DENIED] 允许的新建位置已改变，请重新选择')
    return policy
  }
  previewCreation(raw: CreationPreviewInput): ApplicationCreationPreview {
    const input = creationPreviewSchema.parse(raw), policy = this.creationPolicy()
    if ((input.preset || input.plugins) && policy.mode !== 'admin') throw new Error('[ADMIN_REQUIRED] 选择起始方案或插件组合需要托管创建权限')
    const root = join(policy.parent, input.name)
    const preview = this.creationBackend().preview(input, root)
    const authorization = policy.autonomousDevelopment ? { ...policy, toolchain: this.state.projectToolchain } : policy
    return { ...preview, revision: createHash('sha256').update(canonical({ revision: preview.revision, input, policy: authorization })).digest('hex'),
      root, name: input.name, mode: policy.mode, background: input.background }
  }
  /** 由共用接续链在每个后续阶段调用；调用方不能提供 mode 或任意目标路径。 */
  authorizeCreation(job: CreationJob) {
    const policy = this.creationPolicy()
    if (job.external?.namespace !== (this.adapter.namespace ?? 'mcp') || dirname(job.root) !== policy.parent || job.external.mode !== policy.mode)
      throw new Error('[ACCESS_DENIED] 创建策略已改变，请在应用设置核对原任务的授权')
    const grant = this.grant(job.libraryId)
    if (grant.root !== job.root || grant.mode !== job.external.mode) throw new Error('[ACCESS_DENIED] 此创建任务的仓库权限已改变，请在应用设置核对')
  }
  private creationGrant(job: CreationJob) {
    const policy = this.creationPolicy()
    if (dirname(job.root) !== policy.parent || policy.mode !== job.external?.mode) throw new Error('[ACCESS_DENIED] 创建策略已改变')
    // 任务已持久保存但进程在授予权限前退出：只补全尚未登记的身份，绝不覆盖用户收回的授权。
    if (!this.state.libraries.some(g => g.libraryId === job.libraryId && g.root === job.root)) {
      if (job.external?.projectToolchain && (!policy.autonomousDevelopment || this.state.projectToolchain !== job.external.projectToolchain)) throw new Error('[ACCESS_DENIED] 自主开发创建策略已变化')
      const key = createHash('sha256').update(`${job.root}\0${job.libraryId}`).digest('hex')
      this.update(next => { next.libraries.push({ key, libraryId: job.libraryId, root: job.root, name: job.name, mode: policy.mode, projectToolchain: job.external?.projectToolchain, fileSpaces: [] }) })
    }
    this.authorizeCreation(job)
  }
  private creationJob(requestId: string): CreationJob {
    this.online()
    const job = this.creationBackend().find(this.adapter.namespace ?? 'mcp', requestId)
    if (!job) throw new Error('[CREATION_UNKNOWN] 未找到此创建请求')
    // 已登记的库必须仍授权；尚未登记的任务只能在原创建策略下查看或取消。
    const known = this.state.libraries.some(g => g.libraryId === job.libraryId && g.root === job.root)
    if (known) { if (this.grant(job.libraryId).root !== job.root) throw new Error('[LIBRARY_CHANGED] 仓库授权目标已变化') }
    else {
      const policy = this.creationPolicy()
      if (dirname(job.root) !== policy.parent || policy.mode !== job.external!.mode) throw new Error('[ACCESS_DENIED] 原创建任务不在当前授权范围内')
    }
    return job
  }
  private async creationReceipt(job: CreationJob, replayed: boolean): Promise<CreateLibraryReceipt> {
    const inspected = await this.creationBackend().inspect(job.id)
    const latest = this.creationJob(job.external!.requestId)
    return { requestId: latest.external!.requestId, taskId: latest.id, libraryId: latest.libraryId, root: latest.root,
      name: latest.name, state: latest.state, phase: latest.phase, error: latest.error, ...inspected, replayed }
  }
  creationStatus(requestId: string): Promise<CreateLibraryReceipt> {
    this.online()
    const prior = Object.hasOwn(this.state.requests, requestId) ? this.state.requests[requestId] : undefined
    if (prior) {
      if (!prior.libraryId) throw new Error('[CREATE_INCOMPLETE] 旧创建请求没有安全接续记录，请在应用中检查原目录')
      this.grant(prior.libraryId)
      return Promise.resolve({ requestId, libraryId: prior.libraryId, root: prior.root, name: prior.name, replayed: true, state: 'completed', running: false })
    }
    return this.creationReceipt(this.creationJob(requestId), true)
  }
  resumeCreation(requestId: string): Promise<CreateLibraryReceipt> {
    const job = this.creationJob(requestId)
    if (job.state !== 'pending') return this.creationReceipt(job, true)
    this.creationGrant(job)
    return this.runCreation(job, true)
  }
  cancelCreation(requestId: string): Promise<CreateLibraryReceipt> {
    const job = this.creationJob(requestId)
    this.creationBackend().cancel(job.id)
    return this.creationReceipt(job, true)
  }
  private runCreation(job: CreationJob, replayed: boolean): Promise<CreateLibraryReceipt> {
    const requestId = job.external!.requestId, existing = this.pending.get(requestId)
    if (existing) return existing.then(receipt => ({ ...receipt, replayed: true }))
    const task = (async () => {
      try { await this.creationBackend().resume(job.id, () => this.authorizeCreation(job)) }
      catch (error) {
        // 共用创建链已记录错误与最后阶段。权限撤回仍作为拒绝响应，不能泄露后续结果。
        this.authorizeCreation(job)
        if (!this.creationBackend().read(job.id).error) throw error
      }
      return this.creationReceipt(job, replayed)
    })()
    this.pending.set(requestId, task)
    void task.finally(() => this.pending.delete(requestId)).catch(() => {})
    return task
  }
  create(raw: import('../shared/application-access').CreateLibraryInput): Promise<CreateLibraryReceipt> {
    const input = createLibrarySchema.parse(raw), policy = this.creationPolicy()
    const { requestId, previewRevision, ...choice } = input
    const prior = Object.hasOwn(this.state.requests, requestId) ? this.state.requests[requestId] : undefined
    if (prior) {
      if (prior.name !== input.name || input.preset || input.plugins || previewRevision) throw new Error('[REQUEST_CONFLICT] 同一个 requestId 不能更换创建参数')
      return this.creationStatus(requestId)
    }
    const signature = createHash('sha256').update(canonical(input)).digest('hex')
    const backend = this.creationBackend(), namespace = this.adapter.namespace ?? 'mcp'
    let job = backend.find(namespace, requestId)
    if (job) {
      if (job.external!.signature !== signature) throw new Error('[REQUEST_CONFLICT] 同一个 requestId 不能更换创建参数')
      this.creationJob(requestId)
      if (job.state !== 'pending') return this.creationReceipt(job, true)
      this.creationGrant(job)
      return this.runCreation(job, true)
    }
    const preview = this.previewCreation(choice)
    if ((input.preset || input.plugins) && !previewRevision) throw new Error('[PREVIEW_REQUIRED] 请先预演起始方案或插件组合')
    if (previewRevision && previewRevision !== preview.revision) throw new Error('[PREVIEW_CHANGED] 创建方案或授权已变化，请重新预演')
    if (preview.issues.length) throw new Error(preview.issues.join('；'))
    // 同一同步阶段重算公共预演基线并写任务，确认后的包摘要／布局此后不再重新求解。
    const baseline = backend.preview(choice, preview.root)
    job = backend.prepare({ parent: policy.parent, name: input.name, preset: input.preset, plugins: input.plugins, previewRevision: baseline.revision },
      { namespace, requestId, signature, mode: policy.mode, ...(policy.autonomousDevelopment ? { projectToolchain: this.projectToolchain() } : {}), background: input.background })
    this.creationGrant(job)
    return this.runCreation(job, false)
  }
}
