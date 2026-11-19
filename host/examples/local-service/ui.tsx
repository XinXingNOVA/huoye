import { useEffect, useRef, useState } from 'react'
import type { UiHost, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import './ui.css'
type Settings = { prefix: string; hasKey: boolean; protectedStorage: boolean; runs: number }
function Panel({ host }: { host: UiHost }) {
  const [text, setText] = useState('侧栏隐藏后，服务仍继续输出。'), [output, setOutput] = useState('')
  const [prefix, setPrefix] = useState('回显：'), [key, setKey] = useState(''), [settings, setSettings] = useState<Settings>()
  const [status, setStatus] = useState('就绪'), [error, setError] = useState('')
  const request = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    let alive = true
    host.service('demo-service', 'settings').then(value => { if (alive) { const data = value as Settings; setSettings(data); setPrefix(data.prefix) } }, error => { if (alive) setError(String(error)) })
    return () => { alive = false; request.current?.abort(); request.current = undefined }
  }, [host])
  const configure = async (method: string, input?: unknown) => {
    try { setSettings(await host.service('demo-service', method, input) as Settings); setKey(''); setError('') }
    catch (error) { setError(String(error)) }
  }
  const start = async () => {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setOutput(''); setError(''); setStatus('输出中')
    try {
      await host.streamService('demo-service', 'echo', { text }, { signal: controller.signal, onData(value) {
        if (request.current !== controller) return
        const chunk = value as { delta?: string }; if (chunk.delta) setOutput(old => old + chunk.delta)
      } })
      if (request.current === controller) setStatus('完成')
    } catch (error) { if (request.current === controller) { setStatus(controller.signal.aborted ? '已停止' : '失败'); if (!controller.signal.aborted) setError(String(error)) } }
    finally { if (request.current === controller) request.current = undefined }
  }
  return <section className="demo-service" data-service-example>
    <h3>本机服务示例</h3><p>本地逐字回显，验证持续输出与取消，不调用 AI。切换侧栏或标签页不会停止。</p>
    <label>本机共享前缀<input aria-label="回显前缀" value={prefix} onChange={e => setPrefix(e.target.value)}/></label>
    <button onClick={() => void configure('configure', { prefix })}>保存配置</button>
    <label>示例凭据<input type="password" autoComplete="off" aria-label="示例凭据" value={key} onChange={e => setKey(e.target.value)}/></label>
    <div><button disabled={!settings?.protectedStorage || !key} onClick={() => void configure('setKey', key)}>保存示例凭据</button><button disabled={!settings?.hasKey} onClick={() => void configure('removeKey')}>清除凭据</button></div>
    <small data-credential-state>{settings?.hasKey ? '凭据已配置' : '未配置凭据'}{settings && !settings.protectedStorage ? ' · 系统保护不可用' : ''}</small>
    <label>测试内容<textarea aria-label="测试内容" value={text} onChange={e => setText(e.target.value)}/></label>
    <div><button disabled={status === '输出中' || !text} onClick={() => void start()}>开始输出</button><button disabled={status !== '输出中'} onClick={() => request.current?.abort()}>停止</button></div>
    <p data-service-status aria-live="polite">{status}</p><pre data-service-output>{output}</pre>{error && <p role="alert">{error}</p>}
  </section>
}
export const plugin: UiPlugin = {
  id: 'demo-service',
  toolViews: [{ id: 'demo-service.panel', title: '服务示例', placement: { regions: ['left', 'right'], default: { region: 'right', group: 'demo-service.panel' } }, order: 90, Component: Panel }]
}
