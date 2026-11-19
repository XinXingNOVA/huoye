import { useSyncExternalStore } from 'react'
import type { DevelopmentDirectoryState } from '../../shared/external-plugins'

let snapshot: { directory: DevelopmentDirectoryState; blocked: boolean; error: string } = { directory: { rows: [] }, blocked: false, error: '' }
const listeners = new Set<() => void>()
const guards = new Set<string>()
export function blockDevelopmentReload(key: string, blocked: boolean) {
  if (blocked) guards.add(key); else guards.delete(key)
  if (snapshot.blocked !== !!guards.size) { snapshot = { ...snapshot, blocked: !!guards.size }; listeners.forEach(f => f()) }
}
let pending: Promise<void> | undefined
export function refreshDevelopmentStatus(): Promise<void> {
  return pending ??= window.bridge.packages.developmentDirectory().then(directory => {
    const next = { directory, blocked: !!guards.size, error: '' }
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) { snapshot = next; listeners.forEach(f => f()) }
  }, error => {
    const message = String(error)
    if (snapshot.error !== message) { snapshot = { ...snapshot, error: message }; listeners.forEach(f => f()) }
  }).finally(() => { pending = undefined })
}
let stop: (() => void) | undefined
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!stop) {
    const load = () => { void refreshDevelopmentStatus() }
    load()
    const timer = setInterval(load, 2000), off = window.bridge.packages.onChanged(load)
    window.addEventListener('focus', load)
    stop = () => { clearInterval(timer); off(); window.removeEventListener('focus', load) }
  }
  return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined } }
}
export function useDevelopmentPlugins() { return useSyncExternalStore(subscribe, () => snapshot) }
