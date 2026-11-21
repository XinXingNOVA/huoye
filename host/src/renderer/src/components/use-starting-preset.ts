import { uiText } from '../../../shared/i18n/interface-display'
import { useEffect, useMemo, useState } from 'react'
import type { CreationPreview, StartingPreset } from '../../../shared/library-creation'
import { displayPreset, type PluginPreset } from '../../../shared/plugin-presets'
import { useLanguage } from '../language'

export type StartingChoice = Pick<StartingPreset, 'id' | 'versions' | 'layout'>
export const defaultStartingChoice = (): StartingChoice => ({ id: '', versions: [], layout: true })

/** 页面导航不拥有方案状态；目录变化后统一重新预检，旧异步结果不能重新放行创建。 */
export function useStartingPreset(value: StartingChoice) {
  const [catalog, setCatalog] = useState<{ items: PluginPreset[]; generation: number }>()
  const [catalogError, setCatalogError] = useState('')
  const [result, setResult] = useState<{ key: string; preview?: CreationPreview; preset?: StartingPreset; error?: string }>()
  useEffect(() => {
    let alive = true, request = 0
    const load = async () => {
      const next = ++request
      setCatalog(undefined)
      setCatalogError('')
      try {
        const items = await window.bridge.pluginPresets.list()
        if (alive && next === request) setCatalog({ items, generation: next })
      } catch (e) {
        if (alive && next === request) setCatalogError(String(e))
      }
    }
    void load()
    const off = window.bridge.pluginPresets.onChanged(() => void load())
    return () => { alive = false; off() }
  }, [])
  const { locale } = useLanguage()
  const items = useMemo(() => (catalog?.items ?? []).map(p => displayPreset(p, locale)), [catalog, locale])
  const selected = catalog?.items.find(p => p.id === value.id)
  const key = JSON.stringify([value, selected?.revision, catalog?.generation])
  useEffect(() => {
    if (!catalog) return
    let alive = true
    if (value.id && !selected) {
      setResult({ key, error: uiText("方案已不存在，请重新选择") })
      return
    }
    const preset = selected ? { ...value, revision: selected.revision } : undefined
    void window.bridge.creation.preview(preset, preset ? undefined : []).then(
      preview => { if (alive) setResult({ key, preset, preview }) },
      e => { if (alive) setResult({ key, error: String(e) }) }
    )
    return () => { alive = false }
  }, [catalog, selected, value, key])
  const current = catalog && result?.key === key ? result : undefined
  return {
    presets: items, selected: items.find(p => p.id === value.id),
    preview: current?.preview, preset: current?.preset,
    error: catalogError || current?.error || ''
  }
}
export type StartingPresetModel = ReturnType<typeof useStartingPreset>
