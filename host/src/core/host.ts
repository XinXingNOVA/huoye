import { historySourceSchema } from '../shared/history'
// 仓库运行时的装配与 API 转发；写入约束、定义接续、视图准入和空间刷新各自维护。
import { readImportPolicy } from './import-policy'
import { FileEdits } from './file-edits'
import { randomUUID } from 'node:crypto'
import { fileActionSchema } from '../shared/file-actions'
import { LibraryImports } from './import-settings'
import { importFilesSchema } from '../shared/import-settings'
import { FileUpdates } from './file-updates'
import { directoryFilePage } from './directory-file-page'
import { DirectoryCollection } from './directory-collection'
import { LibrarySpaces } from './file-spaces'
import { heavyMediaProviders } from './media-heavy'
import type { AcquireMediaSlot } from '../shared/media-slots'
import { ffprobeProvider } from './media-inspect'
import { ImageReads } from './image-reads'
import { LibraryCapabilities } from './capabilities'
import { findProgram, programDirectories } from '../platform/programs'
import type { Snippet } from '../shared/query'
import type { CoreApi, CoreEvents } from '../shared/rpc'
import { FileStorage } from './file-storage'
import { History } from './history'
import { BatchReviews } from './batch-review'
import { PluginData } from './plugin-data'
import { DatabaseMaintenance } from './database-maintenance'
import { Ingesting } from './ingest'
import { openLibrary, type Library } from './library'
import { PLUGINS, resolvePlugins, type PluginAssembly, type PluginInfo, type PluginPlan } from '../plugins/manifest'
import type { CorePlugin, SystemContext } from './plugin'
import { imageTools } from './images'
import { runFacet, runQuery, runKindCounts } from './query'
import { snippetOf } from './search'
import { Exporting } from './export'
import { Takeout } from './takeout'
import { Purging, removeUnusedCaches } from './purge'
import { listSpaceItems } from './space-items'
import { ItemLifecycle } from './item-lifecycle'
import { itemDisposalSnapshot } from './item-disposal'
import { Registry } from './registry'
import { Scheduler } from './scheduler'
import { Store } from './store'
import { Reading } from './reading'
import { Operations } from './operations'
import { BusinessQueries } from './business-queries'
import { TaskRetention } from './task-retention'
import { LibraryTasks } from './library-tasks'
import { Previews } from './preview'
import { BlockEditing } from './block-editing'
import { PluginCommands } from './plugin-commands'
import { Admission } from './admission'
import { previewViewImport } from './view-import'
import { Definitions } from './definitions'
import { SpaceRefresh } from './space-refresh'
import { readBindings, setBinding, setPluginSettings } from './external-plugins'
import { kindSnapshot } from '../shared/external-plugins'

export type Emit = <K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]) => void

export interface HostOptions {
  imageDirectory?: string
  providerAssembly?: import('./capabilities').ProviderAssembly
  /** 传入后由 Host 接管：正常关闭或初始化失败都会释放。 */
  library?: Library
  /** 插件清单（名称、依赖）。默认是内置插件的清单。 */
  manifest?: PluginInfo[]
  concurrency?: number
  /** 完整程序搜索目录。未指定时使用本机默认搜索路径。 */
  programDirs?: string[]
  acquireMediaSlot?: AcquireMediaSlot
}

export class Host {
  readonly lib: Library
  readonly reg: Registry
  readonly store: Store
  readonly scheduler: Scheduler
  readonly history: History
  private readonly cleanup: (() => void)[] = []
  /** 这个仓库启用了哪些插件。 */
  readonly plan: PluginPlan
  /** 缺少外部程序而不可用的插件。 */
  readonly unavailable: { plugin: string; reason: string }[] = []
  readonly api: { [K in keyof CoreApi]: (...args: Parameters<CoreApi[K]>) => ReturnType<CoreApi[K]> | Promise<ReturnType<CoreApi[K]>> }

  constructor(root: string, plugins: CorePlugin[], emit: Emit, opts: HostOptions = {}) {
    this.lib = opts.library ?? openLibrary(root)
    this.cleanup.push(() => this.lib.close())
    try {
      const manifest = opts.manifest ?? PLUGINS
      // 这个仓库启用哪些插件（设计文档 8.4）：停用清单存在仓库里，依赖的插件停用了，自己也停用
      const developing = new Set(manifest.filter(p => p.external?.development).map(p => p.id))
      let chosen = readDisabled(this.lib.db)
      // 原本可关闭的模块成为基础模块时，保留用户此前关闭的依赖能力，避免升级后自动开始加工。
      if (manifest.some(p => p.required && chosen.includes(p.id))) {
        const previous = resolvePlugins(chosen, manifest.map(p => chosen.includes(p.id) ? { ...p, required: false } : p))
        chosen = [...new Set([...chosen, ...previous.off.keys()])].filter(id => !manifest.find(p => p.id === id)?.required)
        this.lib.db.prepare("UPDATE main.config SET value = ? WHERE key = 'plugins'").run(JSON.stringify({ disabled: chosen }))
      }
      const bindings = readBindings(this.lib)
      this.plan = resolvePlugins([...chosen.filter(id => !developing.has(id)), ...bindings.filter(b => !b.enabled && !developing.has(b.manifest.id)).map(b => b.manifest.id)], manifest)
      const active = plugins.filter((p) => !this.plan.off.has(p.id))
      this.reg = new Registry(active)

      // 插件级依赖影响全部加工，System 级依赖只影响对应的任务。
      const dirs = opts.programDirs ?? programDirectories()
      const programs = new Map<string, string>()
      const shared = opts.providerAssembly?.sharedPrograms
      const lookupProgram = (name: string) => {
        const managed = shared && Object.hasOwn(shared, name) ? shared[name] : undefined
        if (managed) return managed.problem ? undefined : managed.path
        return findProgram(name, dirs)
      }
      const missingReason = (name: string) => shared?.[name]?.problem ?? '找不到 ' + name
      const resolveProgram = (name: string) => {
        const path = programs.get(name) ?? lookupProgram(name)
        if (path) programs.set(name, path)
        return path
      }
      const consumers = manifest.filter(p => this.plan.enabled.has(p.id))
      const ffprobe = lookupProgram('ffprobe')
      const capabilities = new LibraryCapabilities(consumers, {
        'media.inspect@1': ffprobeProvider(ffprobe), ...heavyMediaProviders(ffprobe, lookupProgram('ffmpeg'))
      }, opts.acquireMediaSlot, { ...opts.providerAssembly, programDirs: dirs })
      const blockedSystems = new Map<string, string>()
      for (const p of active) {
        const missing = p.requires?.programs?.filter(name => !resolveProgram(name)) ?? []
        const pluginReason = missing.length ? missing.map(missingReason).join('、') : undefined
        const reasons = new Set<string>(pluginReason ? [pluginReason] : [])
        for (const system of p.systems ?? []) {
          const problems = pluginReason ? [pluginReason] : []
          for (const name of system.requires?.programs ?? []) {
            if (!resolveProgram(name)) problems.push(missingReason(name))
          }
          for (const id of system.requires?.capabilities ?? []) {
            const status = capabilities.inspect(id, p.id)
            if (status.state === 'unavailable') problems.push(`${id} · ${status.reason}`)
          }
          if (problems.length) {
            problems.forEach(reason => reasons.add(reason))
            blockedSystems.set(system.id, problems.join('；'))
          }
        }
        if (reasons.size) this.unavailable.push({ plugin: p.id, reason: [...reasons].join('；') })
      }

      const capabilityStatus = capabilities.ids.map(id => capabilities.inspect(id))
      const chosenAtLoad = new Set(readDisabled(this.lib.db))
      const assembly: PluginAssembly = { plugins: manifest.map((p) => ({
        id: p.id,
        enabled: this.plan.enabled.has(p.id),
        chosen: chosenAtLoad.has(p.id) && !p.required,
        reason: this.plan.off.get(p.id),
        unavailable: this.unavailable.find((u) => u.plugin === p.id)?.reason
      })) }

      const ctx: SystemContext = {
        root,
        images: imageTools(this.lib.files),
        abs: (rel) => this.lib.files.resolve(rel),
        cacheDir: (name) => this.lib.files.cacheDir(name),
        program: (name) => {
          const path = programs.get(name)
          if (!path) throw new Error(`外部程序 ${name} 没有在插件中声明，或者找不到`)
          return path
        },
        blocksOf: (id) => this.store.blocksOf(id),
        findByField: (kind, field, value) => this.store.findByField(kind, field, value)
      }

      const definers = this.reg.definers()
      this.store = new Store(this.lib, this.reg, (ids, listChanged, kinds, definitionsChanged) => {
        // 模板这类"定义数据块的数据块"变了：存储写入时已经换上新定义，这里通知界面
        if (definitionsChanged || definers.some((d) => kinds.has(d.kind))) emit('kinds', {})
        // 通知在事务结束后发出；失败／预演按回滚后的状态判断，不提前中断加工。
        if (listChanged && this.scheduler) {
          const trashed = ids.filter(id => this.store.isTrashed(id))
          if (trashed.length) this.scheduler.cancel(trashed)
        }
        if (kinds.has('file')) this.scheduler?.filesChanged(ids)
        this.scheduler?.markDirty(ids)
        emit('changed', { ids })
        if (listChanged) emit('listChanged', {})
      }, refs => removeUnusedCaches(this.lib.db, this.lib.files, refs))
      const definitions = new Definitions(this.lib, this.reg, this.store)
      definitions.initialize(manifest, this.plan, active, plugins)
      // 可搜索的字段变了（或者 derived.db 是新的）：重建全文索引
      const t0 = Date.now()
      if (this.store.search.ensure()) console.log(`[search] 重建全文索引 ${Date.now() - t0} ms`)
      this.history = new History(this.lib.db, this.store, () => emit('historyChanged', {}))

      const locateSource = (source: import('../plugin-api/core/capabilities').MediaSource) => {
        if (!this.store.exists(source.id) || this.store.isTrashed(source.id)) throw Error('[FILE_UNAVAILABLE] 素材不可用')
        const file = this.store.blocksOf(source.id).file
        if (!file || file.seq !== source.fileSeq || typeof file.data.path !== 'string') throw Error('[CAPABILITY_SOURCE_CHANGED] 原件已换版')
        return this.lib.files.readable(file.data.path)
      }
      const valueCalls = new Map<string, AbortController>()
      this.cleanup.push(() => { for (const call of valueCalls.values()) call.abort() })
      const images = new ImageReads(opts.imageDirectory, capabilities, locateSource)
      this.cleanup.push(() => images.close())
      this.scheduler = new Scheduler(this.lib.db, this.reg, this.store, ctx, {
        writeCache: (path, bytes) => this.lib.files.write(path, bytes),
        validateFile: ref => { this.lib.files.readable(ref) },
        concurrency: opts.concurrency,
        blockedSystems, capabilities,
        // 没有装配的 System（插件停用了，或者它需要的插件停用了）：加工记录留着
        retain: plugins.flatMap((p) => (p.systems ?? []).map((s) => s.id)).filter((id) => !this.reg.systems.some((s) => s.id === id)),
        onProgress: (running, busy) => emit('progress', { running, busy }),
        onJob: event => emit('job', event)
      })
      this.cleanup.push(() => this.scheduler.stop())

      const { store, scheduler, reg, lib, unavailable, history } = this
      const maintenance = new DatabaseMaintenance(lib.db)
      const pluginData = new PluginData(lib, reg, store, history, active, this.plan.enabled, manifest, () => emit('kinds', {}))
      const exportLifetime = new AbortController()
      this.cleanup.push(() => exportLifetime.abort())
      const exporting = new Exporting(lib.db, reg, store, lib.files, capabilities, locateSource, exportLifetime.signal, (done, total) => emit('exporting', { done, total }))
      const purging = new Purging(lib.db, reg, store, history, scheduler, lib.files)
      const itemLifecycle = new ItemLifecycle(lib, store, purging, (action, ids, context) => {
        if (action === 'trash') { scheduler.cancel(store.withAttached(ids)); history.run(`移到回收站（${ids.length} 项）`, () => store.trash(ids), context) }
        else history.run(`从回收站恢复（${ids.length} 项）`, () => store.restore(ids), context)
      })

      const reviews = new BatchReviews(lib.db, store, reg, history, () => emit('reviewsChanged', {}))
      const retention = new TaskRetention(lib.db, (space, key) => lib.files.bindings!.open(space).finishBatch(`${lib.id}:${key}`))
      const tasks = new LibraryTasks(lib.db, reviews, retention)
      const editing = new BlockEditing(lib, reg, store, history)
      const commands = new PluginCommands(lib, reg, store, history, editing)
      const admission = new Admission(lib, reg, store, history, scheduler, editing)
      const reading = new Reading(lib, reg, store, id => scheduler.processing(id))
      const previews = new Previews(store, scheduler, lib.files)
      this.cleanup.push(() => previews.stop())
      const refresh = new SpaceRefresh(lib, store, scheduler, emit)

      const ingesting = new Ingesting(lib.files, reg, store, lib.db)
      this.cleanup.push(() => ingesting.stop())
      const directoryCollection = new DirectoryCollection(lib, ingesting, store, history)
      const spaces = new LibrarySpaces(lib, store, history, ingesting)
      this.cleanup.push(() => spaces.stop())
      const fileReplaced = (ids: string[]) => { scheduler.cancel(ids, 'replaced'); scheduler.regenerate(ids) }
      const updates = new FileUpdates(lib, store, reg, (ids, directorySpace) => {
        fileReplaced(ids)
        if (directorySpace) emit('fileSpaceChanged', { spaceId: directorySpace })
      })
      const edits = new FileEdits(lib, store, reg, fileReplaced)
      this.cleanup.push(() => edits.stop())
      const externalEdits = new FileEdits(lib, store, reg, fileReplaced, 'external')
      this.cleanup.push(() => externalEdits.stop())
      const externalSpaces = new LibrarySpaces(lib, store, history, ingesting, ':external')
      this.cleanup.push(() => externalSpaces.stop())
      const imports = new LibraryImports(lib, store, history, ingesting, spaces, admission, tasks)
      const fileStorage = new FileStorage(lib, store)
      const operations = new Operations(lib, reg, store, history, plugin => commands.context(plugin), ingesting, tasks, reviews, retention)
      const businessQueries = new BusinessQueries(lib, reg, store, reading)

      // 一轮扫描共用排队后的策略；单空间通知不顺带处理其他空间的任务。
      const scanSpaces = (spaceId?: string) => ingesting.enqueue(() => {
        edits.recover(spaceId); externalEdits.recover(spaceId)
        const policy = readImportPolicy(lib), result = imports.scan(policy, spaceId), next = updates.scan(policy, spaceId)
        return { ...result, updated: next.updated, updatesPending: next.pending, errors: [...result.errors, ...next.errors] }
      })
      this.api = {
        fileEditCapabilities: id => edits.capabilities(id),
        prepareFileEdit: input => edits.prepare(input),
        commitFileEdit: async input => { const result = await edits.commit(input); emit('spaceChanged', { spaceId: result.space.spaceId, fileIds: [result.space.fileId] }); return result },
        discardFileEdit: input => edits.discard(input),
        cancelFileEdit: request => edits.cancel(request),
        externalFileAction: async raw => {
          const { action, input } = fileActionSchema.parse(raw)
          switch (action) {
            case 'capabilities': return externalEdits.capabilities(input.id)
            case 'editTarget': return externalEdits.target(input.editId)
            case 'previewUpdate': return updates.preview(input.id)
            case 'acceptUpdate': return updates.accept(input)
            case 'prepare': return externalEdits.prepare(input)
            case 'discard': externalEdits.discard(input); return { discarded: true }
            case 'cancel': externalEdits.cancel(input.requestId); externalSpaces.cancel(input.requestId); return { cancelled: 'requested' }
            case 'history': return externalSpaces.fileHistory(input)
            case 'previewLifecycle': return externalSpaces.previewMutation(input)
            case 'commit': { const result = await externalEdits.commit(input); emit('spaceChanged', { spaceId: result.space.spaceId, fileIds: [result.space.fileId] }); return result }
            case 'restoreVersion': { const result = await externalSpaces.restoreVersion(input); emit('spaceChanged', { spaceId: input.spaceId, fileIds: [input.fileId] }); emit('fileSpaceChanged', { spaceId: input.spaceId }); return result }
            case 'applyLifecycle': return refresh.mutate(externalSpaces, input)
          }
        },
        recheckFileUpdate: id => updates.recheck(id, (spaceId, fileId) => {
          emit('spaceChanged', { spaceId, fileIds: [fileId], sourceKind: 'directory' })
          emit('fileSpaceChanged', { spaceId })
        }),
        previewFileUpdate: id => updates.preview(id),
        acceptFileUpdate: input => updates.accept(input),
        getImportSettings: () => imports.get(),
        setImportSettings: input => imports.set(input),
        importToLibrary: (inputs, options) => imports.run(inputs, options),
        previewViewImport: (inputs, query) => previewViewImport(reg, inputs, query),
        importToView: (inputs, options) => imports.intoView(inputs, options),
        importFiles: (input, source = 'application') => { const { files, ...options } = importFilesSchema.parse(input); return imports.run(files.map(f => ({ type: 'file', ...f })), options, false, undefined, historySourceSchema.parse(source)) },
        scanSpaceImports: () => scanSpaces(),
        describeLibrary: () => reading.describe(),
        executeQuery: input => businessQueries.execute(input),
        searchPage: input => reading.search(input),
        readItems: input => reading.project(input),
        facetPage: input => reading.facet(input),
        readItem: input => reading.itemDetails(input),
        readContent: input => reading.content(input),
        readPreview: input => previews.read(input),
        processingStatus: input => scheduler.processingStatus(input),
        inspectCapabilityValue: (plugin, id) => capabilities.inspectValue(plugin, id),
        readCapabilityValue: async (ticket, plugin, id, params) => {
          if (typeof ticket !== 'string' || !/^[a-f0-9-]{36}$/.test(ticket) || valueCalls.has(ticket) || valueCalls.size >= 64) throw Error('[CAPABILITY_BUSY] 无效或过多的计算请求')
          const call = new AbortController()
          valueCalls.set(ticket, call)
          try { return await capabilities.readValue(plugin, id, params, call.signal) }
          finally { valueCalls.delete(ticket) }
        },
        cancelCapabilityValue: ticket => valueCalls.get(ticket)?.abort(),
        acquireImageRead: req => images.acquire(req), releaseImageRead: lease => images.release(lease),
        imageReadFile: lease => images.file(lease),
        processingSummary: () => scheduler.processingSummary(),
        libraryTask: input => tasks.run(input),
        taskCapacity: limits => retention.capacity(limits),
        taskMarkerUsage: () => retention.markerUsage(),
        previewTaskCleanup: target => retention.preview(target),
        cleanTask: (target, revision) => retention.clean(target, revision),
        executeOperation: input => operations.execute(input),
        info: () => ({ root, libraryId: lib.id, unavailable, capabilities: capabilityStatus, disabledPlugins: [...this.plan.off.keys()], assembly }),
        kinds: () => [...reg.runtimeKinds(), ...reg.pluginKinds().filter(k => manifest.find(p => p.id === k.plugin)?.external).map(kindSnapshot)],
        externalPlugins: () => readBindings(lib),
        setExternalPlugin: binding => setBinding(lib, binding, manifest),
        setPluginSettings: (disabled, external) => setPluginSettings(lib, disabled, external, manifest),
        plugins: () => {
          const chosen = new Set(readDisabled(lib.db))
          return manifest.map((p, i) => ({ ...p, ...assembly.plugins[i], chosen: chosen.has(p.id) && !p.required }))
        },
        setPlugins: disabled => setPluginSettings(lib, disabled, [], manifest),
        query: (q) => runQuery(lib.db, reg, q),
        get: (ids) => store.get(ids),
        getIdentities: ids => store.getIdentities(ids),
        put: (id, kind, data) => editing.put(id, kind, data),
        patch: (id, kind, fields) => editing.patch(id, kind, fields),
        remove: (id, kind) => editing.remove(id, kind),
        trash: (ids) => {
          scheduler.cancel(store.lifecycleFamily(ids))
          history.run(`移到回收站（${ids.length} 项）`, () => store.trash(ids))
        },
        restore: (ids) => { store.lifecycleFamily(ids); history.run(`从回收站恢复（${ids.length} 项）`, () => store.restore(ids)) },
        ingest: async (inputs) => {
          const result = await ingesting.run(inputs, true, apply => history.run(r => `收录 ${r.items.length} 项`, apply))
          if (!result.items.length && result.errors.some(e => e.message.includes('[FILE_SPACE_'))) throw new Error(result.errors.find(e => e.message.includes('[FILE_SPACE_'))!.message)
          for (const e of result.errors) console.error('[ingest]', e)
          return result.items.map(i => i.id)
        },
        kindCounts: (kinds, query) => runKindCounts(lib.db, reg, kinds, query),
        facet: (kind, field, options) => runFacet(lib.db, reg, kind, field, options),
        takeoutPreview: (ids) => new Takeout(lib, reg, store).preview(ids),
        takeoutRun: (input) => new Takeout(lib, reg, store).run(input),
        listFileSpaces: input => spaces.list(input),
        itemDisposalSnapshot: ids => itemDisposalSnapshot(lib, reg, store, spaces, itemLifecycle, ids),
        itemLifecycleReceipt: input => itemLifecycle.receipt(input),
        previewItemLifecycle: input => itemLifecycle.preview(input),
        applyItemLifecycle: (input, source = 'application') => itemLifecycle.execute(input, historySourceSchema.parse(source)),
        refreshFileSpace: async (spaceId, fileIds) => {
          if (lib.files.bindings!.rows().some(row => row.id === spaceId)) await scanSpaces(spaceId)
          emit('fileSpaceChanged', { spaceId })
          refresh.references(spaces.referenceIds(spaceId, fileIds))
        },
        cancelSpaceOperation: requestId => spaces.cancel(requestId),
        spaceFileHistory: input => spaces.fileHistory(input),
        restoreSpaceVersion: async input => {
          const result = await spaces.restoreVersion(input)
          emit('spaceChanged', { spaceId: input.spaceId, fileIds: [input.fileId] }); await scanSpaces(input.spaceId); emit('fileSpaceChanged', { spaceId: input.spaceId })
          return result
        },
        previewSpaceMutation: input => spaces.previewMutation(input),
        mutateSpaceFiles: input => refresh.mutate(spaces, input),
        previewUnlinkFileSpace: id => spaces.unlinkPreview(id),
        previewForgetFileSpace: id => spaces.forgetPreview(id),
        forgetFileSpace: id => {
          const ids = lib.files.bindings!.rows().some(row => row.id === id) ? spaces.referenceIds(id) : []
          lib.db.transaction(() => { lib.files.bindings!.forget(id); imports.forgetSpacePolicy(id) })()
          emit('changed', { ids }); emit('listChanged', {}); emit('fileSpaceChanged', { spaceId: id })
        },
        linkFileSpace: (root, expectedId) => {
          const spaceId = lib.files.bindings!.connect(root, expectedId)
          const ids = lib.db.prepare("SELECT entity_id FROM main.block WHERE kind='file' AND json_extract(data,'$.path') LIKE ?").pluck().all(`spaces/%/${spaceId}/%`) as string[]
          refresh.references(ids)
          return spaceId
        },
        unlinkFileSpace: id => {
          lib.files.bindings!.disconnect(id)
          const ids = spaces.referenceIds(id); scheduler.cancel(ids, 'unavailable'); emit('changed', { ids }); emit('listChanged', {})
        },
        setDefaultFileSpace: id => lib.files.bindings!.setDefault(id),
        listSpaceFiles: input => spaces.page(input),
        listSpaceItems: input => listSpaceItems(lib, reg, store, input),
        directoryFilePage: input => directoryFilePage(lib, input),
        directoryEntryStates: (spaceId, ids) => {
          if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || id.length !== 36)) throw new Error('目录项无效')
          return directoryFilePage(lib, { sourceKind: 'directory', spaceId, limit: 100 }, ids).items
        },
        collectSelectedDirectoryFiles: async input => {
          await directoryCollection.prepareSelected(input)
          const result = directoryCollection.commitSelected(input, 'application')
          emit('fileSpaceChanged', { spaceId: input.spaceId })
          return result
        },
        prepareDirectoryAdoption: input => directoryCollection.prepareSelected(input),
        commitDirectoryAdoption: input => {
          const result = directoryCollection.commitSelected(input)
          emit('fileSpaceChanged', { spaceId: input.spaceId })
          return result
        },
        referencedDirectorySpaces: () => spaces.referencedDirectorySpaces(),
        directorySpaceReferences: id => spaces.references(id),
        listDirectoryUpdates: (spaceId, offset) => directoryCollection.updates(spaceId, offset),
        previewDirectoryCollection: (spaceId, suffixes) => directoryCollection.preview(spaceId, suffixes),
        collectDirectoryFiles: async (spaceId, suffixes, token) => {
          const result = await directoryCollection.collect(spaceId, suffixes, token)
          if (result.created) emit('fileSpaceChanged', { spaceId })
          return result
        },
        adoptSpaceFiles: (input, source = 'application') => spaces.adopt(input, historySourceSchema.parse(source)),
        fileStorageInfo: id => fileStorage.info(id),
        makeFileIndependent: async (id, spaceId, requestId = randomUUID()) => {
          const target = spaceId ?? lib.files.bindings!.rows().find(r => r.is_default)?.id
          if (!target) throw new Error('请先选择一个独享文件空间，作为副本目标')
          const preview = await edits.prepare({ id, requestId, destination: { mode: 'copy', spaceId: target }, content: { type: 'current' } })
          const result = await edits.commit({ editId: preview.editId, previewToken: preview.previewToken, requestId: `${requestId}-commit` })
          emit('spaceChanged', { spaceId: result.space.spaceId, fileIds: [result.space.fileId] }); return result
        },
        locateOriginalFile: (input) => new Takeout(lib, reg, store).locate(input),
        exportPreview: (ids) => exporting.preview(ids),
        exportRun: (request) => exporting.run(request),
        purgePreview: (ids) => { store.lifecycleFamily(ids); return purging.preview(ids) },
        purge: (ids) => { store.lifecycleFamily(ids); return purging.run(ids) },
        snippets: (ids, text) => {
          const out: Record<string, Snippet> = {}
          for (const id of ids) {
            const s = snippetOf(reg, store.blocksOf(id), text)
            if (s) out[id] = s
          }
          return out
        },
        visible: (ids) => scheduler.setVisible(ids),
        regenerate: (ids) => scheduler.regenerate(ids),
        demand: (id, kind) => scheduler.demand(id, kind),
        create: blocks => editing.create(blocks),
        apply: (ids, where) => admission.apply(ids, where),
        admit: (ids, query, viewId) => admission.admit(ids, query, viewId),
        run: (plugin, command, args) => commands.run(plugin, command, args),
        preview: (plugin, command, args) => commands.preview(plugin, command, args),
        undo: expected => history.undo(expected) ?? null,
        redo: expected => history.redo(expected) ?? null,
        listHistory: input => history.page(input),
        readHistory: input => history.detail(input),
        reviewBatch: (input, source = 'application') => reviews.run(input, source),
        databaseStorageInfo: () => maintenance.info(),
        compactDatabase: () => maintenance.compact(),
        listPluginData: () => pluginData.list(),
        previewPluginDataCleanup: input => pluginData.preview(input),
        cleanupPluginData: input => pluginData.cleanup(input),
        retryPluginDataCleanup: input => pluginData.retry(input)
      }
      // 完整装配成功后才开始加工，避免后段构造失败留下后台任务。
      scheduler.rescan()
      history.startSession()
    } catch (error) {
      try { this.close() } catch (cleanupError) { console.error('[core] 初始化失败后的清理失败', cleanupError) }
      throw error
    }
  }

  close(): void {
    // 后创建的组件先停；初始化失败也只清理已经接管的资源。一次 stop 失败不能阻止关库。
    const errors: unknown[] = []
    while (this.cleanup.length) {
      try { this.cleanup.pop()!() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw errors[0]
  }
}

/** 仓库里停用的插件（存在 library.db 的 config 表里，跟着仓库走）。 */
function readDisabled(db: Library['db']): string[] {
  const raw = db.prepare("SELECT value FROM main.config WHERE key = 'plugins'").pluck().get() as string | undefined
  try {
    const parsed = raw ? (JSON.parse(raw) as { disabled?: unknown }) : {}
    return Array.isArray(parsed.disabled) ? parsed.disabled.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
