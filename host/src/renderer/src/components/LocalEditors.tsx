import { useEffect, useRef, useState } from 'react'
import type { RegisteredEditor } from '../../../shared/local-editors'
import { SectionHeader } from './ui-primitives'
import './local-editors.css'

const message = (e: unknown) => e instanceof Error ? e.message : String(e)

export function LocalEditorSettings() {
  const [editors, setEditors] = useState<RegisteredEditor[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const running = useRef(false)
  useEffect(() => {
    let active = true
    const refresh = () => { void window.bridge.localEditors.list().then(rows => { if (active) { setEditors(rows); setError('') } }, e => { if (active) setError(message(e)) }) }
    refresh(); const off = window.bridge.localEditors.onChanged(refresh)
    return () => { active = false; off() }
  }, [])
  const run = async (fn: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { setError(message(e)) }
    finally { running.current = false; setBusy(false) }
  }
  return (
    <section className="local-editor-settings">
      <SectionHeader
        title="外部编辑器"
        subtitle="登记本机应用以编辑文件，支持按格式记住默认编辑器。"
        actions={
          <button className="small primary" disabled={busy} onClick={() => void run(() => window.bridge.localEditors.choose())}>
            添加编辑器…
          </button>
        }
      />
      {error && <p className="local-editor-error" role="alert">{error}</p>}
      <div className="ui-setting-group">
        <div className="ui-setting-group-card">
          {!editors.length && (
            <div className="ui-setting-row">
              <div className="ui-setting-info">
                <div className="ui-setting-desc">尚未登记外部编辑器，常见格式也可直接使用系统默认应用。</div>
              </div>
            </div>
          )}
          <ul>
            {editors.map(editor => (
              <li key={editor.id} className="ui-setting-row">
                <div className="ui-setting-info">
                  <strong className="ui-setting-title">{editor.title}</strong>
                  <p className="ui-setting-desc muted">{editor.path}</p>
                </div>
                <div className="ui-setting-control">
                  <button className="small" disabled={busy} onClick={() => void run(() => window.bridge.localEditors.remove(editor.id))}>
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
