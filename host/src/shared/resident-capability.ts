import type { CapabilityValues } from './image-reads'
export interface ResidentCall { type: 'resident-call'; ticket: number; plugin: string; capability: string; params: CapabilityValues }
export interface ResidentCancel { type: 'resident-cancel'; ticket: number }
export interface ResidentReply { type: 'resident-reply'; ticket: number; result?: CapabilityValues; error?: string }
export type ResidentCompute = (plugin: string, capability: string, params: CapabilityValues, signal: AbortSignal) => Promise<CapabilityValues>
