export type CapabilityStatus =
  | { id: string; state: 'ready'; provider: string }
  | { id: string; state: 'unavailable'; provider?: string; reason: string }

export interface ProviderChoice {
  id: string
  builtin: boolean
  preferred: string | null
  override: string | null
  options: { id: string; title: string }[]
  optional?: boolean
  pendingReload?: boolean
  current?: CapabilityStatus
}
export interface ProviderSettingsBridge {
  runtimes(): Promise<import('./shared-runtimes').RuntimeInfo[]>
  installRuntime(): Promise<void>
  enableRuntime(digest: string, enabled: boolean): Promise<void>
  removeRuntime(digest: string): Promise<void>
  onChanged(listener: () => void): () => void
  list(): Promise<ProviderChoice[]>
  set(id: string, provider: string | null, scope?: 'application' | 'library'): Promise<void>
}
