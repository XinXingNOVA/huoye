import { consumedCapabilities } from '../shared/capability-declarations'
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { CapabilityName, CapabilityInput, CapabilityOutput, CapabilityStatus, JobCapabilities, MediaSource } from '../plugin-api/core/capabilities'
import type { PluginInfo } from '../shared/plugin-plan'
import { canonical, type InstalledPackage } from '../shared/external-plugins'
import { MAX_SUBTITLE_BYTES, mediaContracts, type MediaCapability, type MediaInput, type MediaOutput } from '../shared/media-capabilities'
import { MediaSlots, type AcquireMediaSlot } from '../shared/media-slots'
import { authorSchemas } from './author-contracts'
import { providerRuntime } from './provider-programs'
import { inspectImage, validateMaxEdge } from './job-image'
import type { ImageReadRequest } from '../shared/image-reads'
import type { ImageArtifact } from './provider-transfer'
import type { ProcessorSystem } from './plugin'
import type { MediaPriority, MediaWorkload } from '../shared/media-slots'
import { invokeProvider } from './external-provider'

export interface MediaProvider<K extends MediaCapability> {
  id: string
  programs?: string[]
  unavailable?: string
  execute(path: string, signal: AbortSignal, input: MediaInput<K>, progress: (fraction: number) => void): Promise<MediaOutput<K>>
}
type Bindings = { [K in MediaCapability]?: MediaProvider<K> }
export interface ProviderAssembly { resident?: import('../shared/resident-capability').ResidentCompute; installedRuntimes?: import('../shared/shared-runtimes').RuntimeIdentity[]; sharedPrograms?: import('../shared/shared-runtimes').SharedPrograms; problem?: string; programDirs?: string[]; packages?: InstalledPackage[]; preferences?: Record<string, string> }
const localSlots = { read: new MediaSlots(2), light: new MediaSlots(2), heavy: new MediaSlots() }
const acquireLocal: AcquireMediaSlot = (signal, priority, workload = 'heavy', promotion) => localSlots[workload].acquire(signal, priority, workload, promotion)
const standard = (id: string): id is MediaCapability => Object.hasOwn(mediaContracts, id)
type Route = { status: CapabilityStatus; pack?: InstalledPackage; programs?: Map<string, string>; artifact?: ImageArtifact; workload?: MediaWorkload; file: boolean; input: z.ZodType; output: z.ZodType }

export class LibraryCapabilities {
  private readonly plugins: Map<string, PluginInfo>
  private readonly routes = new Map<string, Route>()
  private readonly problems = new Map<string, string>()
  private readonly stamps = new Map<string, unknown>()
  private readonly oldStamps: Map<string, unknown>[]
  readonly ids: string[]
  constructor(manifest: PluginInfo[], private readonly bindings: Bindings, private readonly acquire: AcquireMediaSlot = acquireLocal,
    private readonly assembly: ProviderAssembly = {}) {
    this.plugins = new Map(manifest.map(p => [p.id, p]))
    // Old releases persisted CLI file stats or package digests. Recognize only exact
    // historical suffixes for this Provider, including an installed pre-upgrade runtime.
    const shared = Object.fromEntries(Object.entries(assembly.sharedPrograms ?? {}).map(([name, p]) => [name, p.digest]))
    const past = (assembly.installedRuntimes ?? []).filter(pkg => pkg.programs.some(name => shared[name] !== pkg.digest))
    const deliveries = [shared, ...past.map(pkg => ({ ...shared, ...Object.fromEntries(pkg.programs.map(name => [name, pkg.digest])) }))]
    const fileStatStamps = new Map<string, unknown>()
    const deliveryStamps = deliveries.map(programs => new Map<string, unknown>(Object.entries(programs).map(([name, digest]) => ['program:' + name, [name, digest]])))
    this.oldStamps = [fileStatStamps, ...deliveryStamps]
    const preferences = assembly.preferences ?? {}
    const declared = manifest.flatMap(p => [...consumedCapabilities(p.capabilities), ...(p.capabilities?.provides ?? [])])
    this.ids = [...new Set([...Object.keys(bindings), ...declared, ...Object.keys(preferences)])]
    const activePackages = (assembly.packages ?? []).filter(pack => {
      const info = this.plugins.get(pack.manifest.id)
      return !!info?.external && !pack.problem && !info.problem && pack.hash === info.external.hash &&
        !!pack.development === !!info.external.development && (!!pack.manifest.entries.provider || !!pack.manifest.capabilities?.implementations?.some(i => i.via === 'service'))
    })
    for (const id of this.ids) {
      if (assembly.problem) { this.problems.set(id, assembly.problem); continue }
      const definitions = manifest.flatMap(p => p.capabilities?.contracts?.filter(c => c.id === id) ?? [])
      if (new Set(definitions.map(canonical)).size > 1) {
        this.problems.set(id, '已启用插件的同名契约不一致')
        continue
      }
      const schemas = standard(id) ? { ...mediaContracts[id], file: true } : definitions[0] && authorSchemas(definitions[0])
      if (!schemas) continue
      const candidates = activePackages.filter(p => p.manifest.capabilities?.provides?.includes(id))
        .map(p => providerRuntime(p, id, assembly.programDirs ?? [], assembly.sharedPrograms))
      const preferred = preferences[id]
      const internal = standard(id) ? bindings[id] : undefined
      const available = candidates.filter(c => !c.problem)
      let selected = candidates.find(c => c.pack.manifest.id === preferred)
      if (!preferred && (!internal || internal.unavailable) && available.length === 1 && available[0].automatic) selected = available[0]
      let status: CapabilityStatus
      if (selected && !selected.problem) {
        status = { id, state: 'ready', provider: selected.pack.manifest.id }
        fileStatStamps.set(id, [id, status.provider, selected.pack.hash, ...selected.legacyVersions])
        const provider = selected.pack
        const versions = selected.versions
        deliveries.forEach((programs, i) => deliveryStamps[i].set(id, [id, provider.manifest.id, provider.hash, ...versions.map(v => Object.hasOwn(programs, v) ? programs[v] : v)]))
        this.stamps.set(id, [id, status.provider, selected.pack.hash, ...selected.versions])
      } else if (preferred) {
        status = { id, state: 'unavailable', provider: preferred, reason: selected?.problem ?? '选定引擎未在本库启用或不可用' }
        this.stamps.set(id, [id, preferred, 'unavailable'])
      } else if (internal && !internal.unavailable) {
        status = { id, state: 'ready', provider: internal.id }
        const programs = internal.programs ?? []
        deliveries.forEach((delivery, i) => {
          const stamps = programs.filter(name => Object.hasOwn(delivery, name)).map(name => [name, delivery[name]])
          if (stamps.length) deliveryStamps[i].set(id, [id, internal.id, ...stamps])
        })
      } else {
        const reason = available.length ? '已有可用引擎，请在计算引擎设置中选择' : candidates[0]?.problem
        const broken = internal?.programs?.map(name => assembly.sharedPrograms?.[name]?.problem).find(Boolean)
        status = { id, state: 'unavailable', provider: internal?.id, reason: reason ?? broken ?? internal?.unavailable ?? '没有可用实现' }
      }
      if (status.state === 'unavailable' && !this.stamps.has(id)) this.stamps.set(id, [id, 'unavailable'])
      this.routes.set(id, { ...schemas, status, workload: selected?.workload, pack: selected?.pack, programs: selected?.programs, artifact: definitions[0]?.artifact })
    }
  }
  systemCapabilities(plugin: string, system: ProcessorSystem) {
    const declaration = this.plugins.get(plugin)?.capabilities
    return declaration?.version === 2 ? [...(system.requires?.capabilities ?? []), ...(system.optionalCapabilities ?? [])] : declaration?.consumes ?? []
  }
  previousFingerprints(ids: readonly string[]) {
    return [...new Set(this.oldStamps.map(map => this.keyFor(ids, map)))].filter(Boolean)
  }
  fingerprint(ids: readonly string[]) { return this.keyFor(ids) }
  private keyFor(ids: readonly string[], historical?: ReadonlyMap<string, unknown>) {
    const stamps = [...new Set(ids)].sort().map(id => historical?.get(id) ?? this.stamps.get(id)).filter(v => v !== undefined)
    return stamps.length ? '|engine:' + createHash('sha256').update(JSON.stringify(stamps)).digest('hex') : ''
  }
  inspect(id: string, consumer?: string): CapabilityStatus {
    if (consumer && id.includes('/') && !this.plugins.get(consumer)?.capabilities?.contracts?.some(c => c.id === id)) {
      return { id, state: 'unavailable', reason: '消费插件缺少此能力的静态契约' }
    }
    return this.routes.get(id)?.status ?? { id, state: 'unavailable', reason: this.problems.get(id) ?? '没有可用实现' }
  }
  inspectValue(plugin: string, id: import('../shared/image-reads').AuthorCapability): CapabilityStatus {
    const declaration = this.plugins.get(plugin)?.capabilities
    if (!consumedCapabilities(declaration).includes(id) || !declaration?.contracts?.some(c => c.id === id && c.source === 'none' && !c.artifact)) {
      throw Error('[CAPABILITY_UNDECLARED] 页面计算需要无原件的值契约')
    }
    const status = this.inspect(id, plugin)
    if (status.state === 'ready' && !this.routes.get(id)?.pack?.manifest.capabilities?.implementations?.some(i => i.id === id && i.execution === 'local')) {
      return { id, state: 'unavailable', reason: '交互计算需要显式声明的本地实现' }
    }
    return status
  }
  async readValue(plugin: string, id: import('../shared/image-reads').AuthorCapability, params: import('../shared/image-reads').CapabilityValues, signal: AbortSignal) {
    const status = this.inspectValue(plugin, id)
    if (status.state !== 'ready') throw Error('[CAPABILITY_UNAVAILABLE] ' + status.reason)
    if (!params || Buffer.byteLength(JSON.stringify(params)) > 65536) throw Error('[CAPABILITY_INVALID_INPUT] 参数过大')
    return this.forJob(plugin, () => { throw Error('[CAPABILITY_UNDECLARED] 页面计算不能读取文件') },
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]), { priority: 'interactive' }).run(id, { params })
  }
  readInput(plugin: string, capability: string, raw: import('../shared/image-reads').ImageReadInput) {
    const declaration = this.plugins.get(plugin)?.capabilities
    const route = this.routes.get(capability)
    if (!consumedCapabilities(declaration).includes(capability) || !declaration?.contracts?.some(c => c.id === capability && c.interactive)) {
      throw Error('[CAPABILITY_UNDECLARED] 未声明交互式图像读取')
    }
    const status = this.inspect(capability, plugin)
    if (status.state !== 'ready') throw Error('[CAPABILITY_UNAVAILABLE] ' + status.reason)
    if (!route?.pack?.manifest.capabilities?.implementations?.some(p => p.id === capability && p.execution === 'local')) throw Error('[CAPABILITY_UNAVAILABLE] 缺少取图引擎')
    const input = route.input.safeParse(raw)
    if (!input.success || Buffer.byteLength(JSON.stringify(input.data)) > 65536) throw Error('[CAPABILITY_INVALID_INPUT] 无效的取图参数')
    return input.data as typeof raw
  }
  async readImage(req: Omit<ImageReadRequest, 'lease'>, locate: (source: MediaSource) => string, lifetime: AbortSignal, promotion?: AbortSignal) {
    let image: Awaited<ReturnType<typeof inspectImage>> | undefined
    await this.forJob(req.plugin, locate, lifetime, {
      priority: req.priority === 'display' ? 'interactive' : 'background', readPromotion: promotion,
      stage: async (format, bytes) => {
        image = await inspectImage(bytes, format, req.maxEdge)
        return { width: image.width, height: image.height, mime: image.mime }
      }
    }).run(req.capability, req.input)
    if (!image) throw Error('[CAPABILITY_INVALID_OUTPUT] 引擎未返回图片')
    return image
  }
  forJob(plugin: string, resolve: (source: MediaSource) => string, lifetime: AbortSignal,
    job: { readPromotion?: AbortSignal; progress?: (fraction: number) => void; allowed?: readonly string[]; priority?: MediaPriority; stage?(format: ImageArtifact, bytes: Uint8Array, maxEdge?: number): Promise<import('../shared/image-reads').CapabilityValues> } = {}): JobCapabilities {
    const check = (id: string) => {
      lifetime.throwIfAborted()
      if (!consumedCapabilities(this.plugins.get(plugin)?.capabilities).includes(id) || (job.allowed && !job.allowed.includes(id))) throw Error('[CAPABILITY_UNDECLARED] 插件未声明此能力')
      return this.inspect(id, plugin)
    }
    return {
      inspect: check,
      run: (async <K extends CapabilityName>(id: K, raw: CapabilityInput<K>, options?: { signal?: AbortSignal; maxEdge?: number }): Promise<CapabilityOutput<K>> => {
        const status = check(id)
        if (status.state !== 'ready') throw Error('[CAPABILITY_UNAVAILABLE] ' + status.reason)
        const route = this.routes.get(id)!
        if (options?.maxEdge !== undefined) {
          if (!route.artifact) throw Error('[CAPABILITY_INVALID_INPUT] maxEdge 只适用于图像产物')
          validateMaxEdge(options.maxEdge)
        }
        const parsed = route.input.safeParse(raw)
        if (!parsed.success || (route.pack && Buffer.byteLength(JSON.stringify(parsed.data)) > 4 * 1024 * 1024)) {
          throw Error('[CAPABILITY_INVALID_INPUT] 调用参数不符合 ' + id)
        }
        const input = parsed.data
        const queued = !!route.pack || id !== 'media.inspect@1'
        const workload = route.workload ?? 'heavy'
        const timeout = AbortSignal.timeout(!job.readPromotion && queued && workload === 'heavy' ? 30 * 60_000 : 30_000)
        const signal = AbortSignal.any([lifetime, timeout, ...(options?.signal ? [options.signal] : [])])
        signal.throwIfAborted()
        const pathOf = () => route.file ? resolve(input as MediaSource) : undefined
        let path = pathOf()
        let release: (() => void) | undefined
        try {
          if (queued) {
            release = job.readPromotion ? await this.acquire(signal, job.priority, 'read', job.readPromotion)
              : await this.acquire(signal, job.priority, workload)
            signal.throwIfAborted()
            path = pathOf()
          }
          const report = (fraction: number) => { if (!signal.aborted) job.progress?.(fraction) }
          const providerInput = !standard(id) && route.pack?.manifest.capabilities?.version === 2 ? (input as { params: unknown }).params : input
          const resident = route.pack?.manifest.capabilities?.implementations?.some(spec => spec.id === id && spec.via === 'service')
          if (resident && !this.assembly.resident) throw Error('[SERVICE_UNAVAILABLE] 缺少常驻服务通道')
          const result = resident ? await this.assembly.resident!(route.pack!.manifest.id, id, providerInput as import('../shared/image-reads').CapabilityValues, signal)
            : route.pack ? await invokeProvider(route.pack, id, providerInput, path, signal, report, route.programs, route.artifact)
            : await (this.bindings[id as MediaCapability] as MediaProvider<MediaCapability>).execute(path!, signal, input as MediaInput<MediaCapability>, report)
          signal.throwIfAborted()
          pathOf()
          if (route.artifact) {
            if (!(result instanceof Uint8Array) || !job.stage) throw Error('[CAPABILITY_INVALID_OUTPUT] 需要图像文件产物')
            const artifact = await job.stage(route.artifact, result, options?.maxEdge)
            signal.throwIfAborted()
            return artifact as CapabilityOutput<K>
          }
          const output = route.output.safeParse(result)
          if (!output.success) throw Error('[CAPABILITY_INVALID_OUTPUT] 计算结果不符合 ' + id)
          if (standard(id)) checkMediaBounds(input as MediaInput<MediaCapability>, output.data as MediaOutput<MediaCapability>)
          return output.data as CapabilityOutput<K>
        } catch (error) {
          if (timeout.aborted && signal.reason === timeout.reason) throw Error('[CAPABILITY_TIMEOUT] 能力调用超时')
          throw error
        } finally { release?.() }
      }) as JobCapabilities['run']
    }
  }
}
function checkMediaBounds(input: MediaInput<MediaCapability>, value: MediaOutput<MediaCapability>) {
  if (('track' in value && 'track' in input && value.track !== input.track) ||
    ('peaks' in value && 'maxPeaks' in input && value.peaks.length > input.maxPeaks) ||
    ('text' in value && Buffer.byteLength(value.text, 'utf8') > MAX_SUBTITLE_BYTES)) {
    throw Error('[CAPABILITY_INVALID_OUTPUT] 结果超出请求的轨道或大小范围')
  }
}
