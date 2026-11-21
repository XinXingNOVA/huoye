import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useState } from 'react'
import type { UiHost } from '../plugin'
import type { DatabaseStorageInfo } from '../../../shared/database-maintenance'
import { formatBytes } from '../../../shared/format'
import { SectionHeader, SettingGroup, SettingRow } from './ui-primitives'
import { TaskMaintenance } from './TaskMaintenance'
import './database-maintenance.css'

export function DatabaseMaintenance({ host, active }: { host: UiHost; active: boolean }) {
  useUiLocale()
  const [info, setInfo] = useState<DatabaseStorageInfo>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!active) return
    let alive = true
    void host.core.databaseStorageInfo().then(value => {
      if (alive) { setInfo(value); setError('') }
    }, e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [host, active, refresh])

  const compact = async () => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await host.core.compactDatabase()
      setInfo(result.after)
      setNotice(result.checkpointPending ? uiText("数据库已整理；部分磁盘空间将在读取连接释放后回收。") : uiText("数据库已整理。"))
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }

  return (
    <><section className="database-maintenance" aria-label={uiText("数据库维护")} aria-busy={busy}>
      <SectionHeader title={uiText("数据库维护")} />
      <SettingGroup>
        <SettingRow
          title={uiText("存储空间与碎片回收")}
          description={info ? uiText("仓库数据库 {value1} · 可复用空闲页 {value2}", { value1: String(formatBytes(info.allocatedBytes)), value2: String(formatBytes(info.reusableBytes)) }) : uiText("正在读取占用…")}
        >
          <div className="database-maintenance-actions" title={uiText("保留素材与撤销记录；大库可能耗时，并需要临时磁盘空间")}>
            <button className="small" disabled={busy} onClick={() => setRefresh(n => n + 1)}>{uiText("刷新占用")}</button>
            <button className="small primary" disabled={busy || !info} onClick={() => void compact()}>
              {busy ? uiText("正在整理…") : uiText("整理数据库")}
            </button>
          </div>
        </SettingRow>
        <SettingRow
          title={uiText("会话操作历史")}
          description={uiText("自动保留本次会话最近 1000 笔（约 64 MB），重开仓库时自动清理旧会话记录。")}
        >
          <span className="pill-badge">{uiText("自动维护")}</span>
        </SettingRow>
      </SettingGroup>
      {error && <p className="package-error" role="alert">{error}</p>}
      {notice && <p className="database-maintenance-notice" role="status">{notice}</p>}
    </section>
    <TaskMaintenance host={host} active={active} />
    </>
  )
}
