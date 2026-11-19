import { useState } from 'react'
import type { ApplicationUiHost } from '../../plugin-api/ui/application'
import type { LibraryGrant } from '../../shared/application-access'
import type { DevelopmentCatalog } from '../../shared/development-access'

/** 许可只由本机设置提交；远端工具只能消费已登记的来源身份。 */
export function McpDevelopment({ host, library, disabled, refresh }: { host: ApplicationUiHost; library: LibraryGrant; disabled: boolean; refresh(): Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [catalog, setCatalog] = useState<DevelopmentCatalog>()
  const [enabled, setEnabled] = useState(false), [capture, setCapture] = useState(false), [sources, setSources] = useState<string[]>([])
  const load = async () => {
    setOpen(true); setBusy(true); setError(''); setNotice('')
    setEnabled(!!library.development?.enabled); setCapture(!!library.development?.capture)
    setSources(library.development?.sources.map(s => s.key) ?? [])
    try { setCatalog(await host.service('mcp', 'developmentSources', { key: library.key }) as DevelopmentCatalog) }
    catch (e) { setCatalog(undefined); setError(String(e)) }
    finally { setBusy(false) }
  }
  return <div className="mcp-development" data-development-grant={library.libraryId}>
    <button className="small" disabled={disabled || busy} aria-label={`${library.name} 的开发验收许可`} onClick={() => open ? setOpen(false) : void load()}>{open ? '收起开发验收许可' : '开发验收许可…'}</button>
    {open && <>
      <p className="muted">此仓库仍需「管理仓库」权限。允许的源码可以在本机执行；构建后由 AI 明确应用，停用覆盖保留数据和正式插件绑定。</p>
      <label><input type="checkbox" aria-label={`${library.name} 允许开发验收`} checked={enabled} disabled={disabled || busy} onChange={e => setEnabled(e.target.checked)} />允许 AI 在此仓库开发验收、正常关闭和重载</label>
      <label><input type="checkbox" aria-label={`${library.name} 允许验收截图`} checked={capture} disabled={!enabled || disabled || busy} onChange={e => setCapture(e.target.checked)} />允许截取此仓库的内容窗口</label>
      <p className="muted">先在目标仓库的「功能与方案 → 本地源码开发」中添加开发源码目录和开发工具工程，再在这里批准具体来源。仅用于此仓库，不授予其他仓库或任意目录。</p>
      {catalog?.toolchain && <p className="muted">开发工具：{catalog.toolchain}</p>}
      {catalog?.problem && <p role="alert">{catalog.problem}</p>}
      {catalog?.sources.map(source => <label key={source.key} className="mcp-library">
        <input type="checkbox" aria-label={`允许源码 ${source.pluginId}`} disabled={!enabled || disabled || busy || !!source.problem} checked={sources.includes(source.key)} onChange={e => setSources(s => e.target.checked ? [...s, source.key] : s.filter(key => key !== source.key))} />
        <span>{source.title} · {source.pluginId}<small className="muted">{source.source}</small>{source.problem && <small>{source.problem}</small>}</span>
      </label>)}
      {sources.some(key => !catalog?.sources.some(s => s.key === key)) && <p>已有来源当前不可用；保存将移除这些来源的许可。</p>}
      <div className="mcp-actions">
        <button className="small" disabled={disabled || busy} onClick={() => void load()}>重新读取开发来源</button>
        <button className="small" disabled={disabled || busy || enabled && !catalog} onClick={async () => {
          setBusy(true); setError(''); setNotice('')
          try {
            await host.service('mcp', 'setDevelopmentGrant', { key: library.key, enabled, capture,
              sourceIds: enabled ? sources.filter(key => catalog?.sources.some(s => s.key === key && !s.problem)) : [] })
            await refresh(); setNotice('开发验收许可已保存')
          } catch (e) { setError(String(e)) }
          finally { setBusy(false) }
        }}>保存开发验收许可</button>
      </div>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </>}
  </div>
}
