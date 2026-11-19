import { useCallback, useRef, useState } from 'react'
import { useUiEffect } from '../../plugin-api/ui/hooks'
import type { ApplicationUiHost } from '../../plugin-api/ui/application'
import type { ApplicationAccessChange } from '../../shared/application-access'
import type { ApplicationMcpSettings } from './settings'

/** 开始页和设置窗口共用宿主回执。窗口得焦的旧读取不能覆盖刚保存的授权。 */
export function useMcpSettings(service: ApplicationUiHost['service']) {
  const [settings, setSettings] = useState<ApplicationMcpSettings>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (writing.current) return
    const request = ++generation.current
    try {
      const next = await service('mcp', 'settings') as ApplicationMcpSettings
      if (request === generation.current) { setSettings(next); setError('') }
    } catch (e) {
      if (request === generation.current) { setSettings(undefined); setError(String(e)) }
    }
  }, [service])
  useUiEffect(display => {
    void refresh()
    display.onWindow('focus', refresh)
    return () => { generation.current++ }
  }, [refresh])
  const save = async (change: ApplicationAccessChange) => {
    if (writing.current) return false
    writing.current = true
    generation.current++
    setBusy(true); setError('')
    try {
      setSettings(await service('mcp', 'settings', change) as ApplicationMcpSettings)
      return true
    } catch (e) { setError(String(e)); return false }
    finally { writing.current = false; setBusy(false) }
  }
  return { settings, busy, error, setError, refresh, save }
}
