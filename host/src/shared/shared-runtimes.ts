export type SharedPrograms = Record<string, { path: string; digest: string; problem?: string }>

export type RuntimeIdentity = { digest: string; programs: string[] }

export interface RuntimeInfo {
  digest: string
  id: string
  version: string
  target: string
  programs: string[]
  bytes: number
  enabled: boolean
  inUse: boolean
  brokenFiles?: string[]
}
