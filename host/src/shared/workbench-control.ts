import type { WorkbenchLayout } from './workbench-layout'
import type { WorkbenchPresetPreview } from '../plugin-api/ui/workbench-presets'

export type WorkbenchRequest =
  | { action: 'session'; request: import('./workbench-session').SessionRequest; windows: import('./workbench-session').SessionWindows }
  | { action: 'preview'; layout?: WorkbenchLayout }
  | { action: 'apply'; layout: WorkbenchLayout; revision: string; requestId: string }
export interface WorkbenchPreview {
  current: WorkbenchLayout
  revision: string
  preview?: WorkbenchPresetPreview
  presets: { id: string; title: string; layout: WorkbenchLayout }[]
  tools: { id: string; title: string }[]
}
export async function workbenchRevision(layout: WorkbenchLayout): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(layout))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}
