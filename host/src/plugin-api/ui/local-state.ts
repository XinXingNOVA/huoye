import { uiText } from '../../shared/i18n/interface-display'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UiHost } from './contracts'
import type { LocalScope, LocalValue } from '../local-service'

/** plugin-local-state-v1：小型界面偏好，不用于业务内容、密钥或编辑草稿。 */
export interface PluginUiState {
  get(key: string): Promise<LocalValue | undefined>
  set(key: string, value: LocalValue): Promise<void>
  remove(key: string): Promise<void>
  /** 仅首次导入，清理仍保留已迁移标记；返回最终值，不覆盖已有设置。 */
  importOnce(key: string, value: LocalValue): Promise<LocalValue | undefined>
  onChanged(listener: (key?: string) => void): () => void
}

/** legacyKey 是插件自己原先使用的一个精确 localStorage 键，成功接续后才删除。 */
export function usePluginState<T extends LocalValue>(host: UiHost, pluginId: string, key: string, initial: T, options: { scope?: LocalScope; legacyKey?: string } = {}) {
  const scope = options.scope ?? 'library', legacyKey = options.legacyKey
  const store = useMemo(() => host.localState(pluginId, scope), [host.localState, pluginId, scope])
  const initialRef = useRef(initial), epoch = useRef(0), generation = useRef(0), writing = useRef<number | undefined>(undefined)
  const [value, setValue] = useState(initial), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const current = ++epoch.current
    writing.current = undefined; setBusy(false); setReady(false); setError('')
    const load = async (migrate = false) => {
      if (disposed) return
      const ticket = ++generation.current
      try {
        let result: LocalValue | undefined
        if (migrate && legacyKey) {
          const old = localStorage.getItem(legacyKey)
          result = await store.importOnce(key, old === null ? initialRef.current : JSON.parse(old))
          if (old !== null && localStorage.getItem(legacyKey) === old) localStorage.removeItem(legacyKey)
        } else result = await store.get(key)
        if (!disposed && ticket === generation.current) { setValue((result === undefined ? initialRef.current : result) as T); setReady(true); setError('') }
      } catch(e) { if (!disposed && ticket === generation.current) setError(String(e)) }
    }
    let initializing = true, changedDuringLoad = false
    const off = store.onChanged(changed => {
      if (changed && changed !== key) return
      if (initializing) changedDuringLoad = true
      else void load()
    })
    void load(true).then(() => {
      initializing = false
      if (!disposed && changedDuringLoad) void load()
    })
    return () => { disposed = true; if (epoch.current === current) epoch.current++; generation.current++; off() }
  }, [store, key, legacyKey])
  const set = useCallback(async (next: T) => {
    if (!ready) throw new Error(uiText("界面状态尚未读取完成"))
    if (writing.current !== undefined) throw new Error(uiText("界面状态正在保存，请稍后重试"))
    const current = epoch.current
    writing.current = current; setBusy(true)
    try {
      await store.set(key, next)
      if (epoch.current !== current) return
      // 读取已提交的最新值，避免另一个投影的写入被本次回执覆盖。
      const ticket = ++generation.current, latest = await store.get(key)
      if (epoch.current === current && ticket === generation.current) { setValue((latest === undefined ? initialRef.current : latest) as T); setError('') }
    } catch(e) { if (epoch.current === current) setError(String(e)); throw e }
    finally { if (writing.current === current) writing.current = undefined; if (epoch.current === current) setBusy(false) }
  }, [store, key, ready])
  return { value, set, ready, busy, error }
}
