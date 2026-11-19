import { useState } from 'react'
import type { UiHost, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { useEntity, useKinds } from '@resource-manager/plugin-api/ui/data'
import './ui.css'

function Demo({ host }: { host: UiHost }) {
  const kinds = useKinds()
  const [text, setText] = useState('复看时留意构图'), [id, setId] = useState<string>()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const view = useEntity(id)
  const save = async () => {
    setBusy(true); setError('')
    try {
      if (id) await host.core.run('demo-reviewmemo', 'update', { id, text })
      else setId(await host.core.create({ 'demo-reviewmemo': { text } }))
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <section className="demo-reviewmemo">
    <h2><img src={new URL('./assets/icon.svg', import.meta.url).href} alt="" />独立插件验证</h2>
    <p>数据定义：{kinds.some(k => k.id === 'demo-reviewmemo' && !k.dormant) ? '已连接宿主' : '尚未就绪'}</p>
    <label>备忘内容<textarea value={text} onChange={e => setText(e.target.value)} /></label>
    <button className="small" disabled={busy || !text.trim()} onClick={() => void save()}>{id ? '保存备忘' : '创建验证记录'}</button>
    <p className="demo-result" data-record-id={id}>订阅读回：{String(view?.blocks['demo-reviewmemo']?.data.text ?? '尚未创建')}</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
export const plugin: UiPlugin = {
  id: 'demo-reviewmemo',
  settingsSections: [{ id: 'demo-reviewmemo.settings', order: 100, scope: 'library', Component: Demo }],
  views: [{ id: 'demo-reviewmemo.view', title: '复看备忘', order: 1000, query: { has: ['demo-reviewmemo'] } }]
}
