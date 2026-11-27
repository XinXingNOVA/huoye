import type { MediaCapability, MediaInput, MediaOutput } from '../../shared/media-capabilities'
export type { MediaCapability, MediaInput, MediaOutput } from '../../shared/media-capabilities'
export type { MediaInspection, MediaTrack } from '../../shared/media-inspection'
import type { CapabilityStatus } from '../../shared/capability-status'
export type { CapabilityStatus } from '../../shared/capability-status'

/** 已接纳 file 块的写入序号，只在所属库的加工上下文内解析。 */
import type { AuthorCapability, CapabilityValues, MediaSource } from '../../shared/image-reads'
export type { AuthorCapability, CapabilityValues, MediaSource } from '../../shared/image-reads'
/** 声明 artifact 图像产物的能力经宿主暂存后返回的结果，可直接写入 still 等派生块。 */
export type StagedCapabilityImage = { path: string; source: number }
export type CapabilityName = MediaCapability | AuthorCapability
export type CapabilityInput<K extends CapabilityName> = K extends MediaCapability ? MediaInput<K> :
  { params: CapabilityValues } & Partial<MediaSource>
export type CapabilityOutput<K extends CapabilityName> = K extends MediaCapability ? MediaOutput<K> : CapabilityValues
export interface JobCapabilities {
  inspect(id: string): CapabilityStatus
  /** 指定缩略尺寸时，宿主只接纳图像契约，并返回已暂存的派生图像。 */
  run(id: AuthorCapability, input: CapabilityInput<AuthorCapability>, options: { signal?: AbortSignal; maxEdge: number }): Promise<StagedCapabilityImage>
  run<K extends CapabilityName>(id: K, input: CapabilityInput<K>, options?: { signal?: AbortSignal; maxEdge?: number }): Promise<CapabilityOutput<K>>
}
