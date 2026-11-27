export type AuthorCapability = `${string}/${string}@${number}`
type CapabilityScalar = string | number | boolean | string[] | number[]
export type CapabilityValues = Record<string, CapabilityScalar | Record<string, CapabilityScalar>[]>
export interface MediaSource { id: string; fileSeq: number }

export interface ImageReadInput extends MediaSource { params: CapabilityValues }
export interface ImageReadRequest {
  /** 最长边 1–1024，指定时返回等比 WebP 缩略图。 */
  maxEdge?: number
  lease: string
  plugin: string
  capability: AuthorCapability
  input: ImageReadInput
  priority: 'display' | 'prefetch'
}
export interface ImageReadInfo { mime: string; width: number; height: number }
export interface PageImageReads {
  image(capability: AuthorCapability, input: ImageReadInput, options?: { maxEdge?: number; signal?: AbortSignal; priority?: 'display' | 'prefetch' }):
    Promise<ImageReadInfo & { url: string; release(): void }>
}

export interface PageCapabilities {
  inspect(id: AuthorCapability): Promise<import('./capability-status').CapabilityStatus>
  run(id: AuthorCapability, params: CapabilityValues, options?: { signal?: AbortSignal }): Promise<CapabilityValues>
}
