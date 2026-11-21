import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { canOrganize } from '../../shared/external-access'
import { useEffect, useState } from 'react'
import type { ApplicationUiHost } from '../../plugin-api/ui/application'
import type { ApplicationAccessChange, LibraryGrant } from '../../shared/application-access'
import type { SpaceBindingInfo } from '../../shared/file-spaces'

type PermissionRow = (SpaceBindingInfo & { sourceKind?: 'managed' }) | {
  id: string; name: string; sourceKind: 'directory'; state: import('../../shared/directory-spaces').DirectoryConnection['state']
}
export function McpSpacePermissions({ host, library, expanded, enabled, busy, change }: {
  host: ApplicationUiHost; library: LibraryGrant & { open: boolean }; expanded: boolean; enabled: boolean; busy: boolean
  change(input: ApplicationAccessChange): Promise<void>
}) {
  useUiLocale()
  const [spaces, setSpaces] = useState<PermissionRow[]>(), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0), [localBusy, setLocalBusy] = useState(false)
  useEffect(() => {
    if (!expanded || !enabled || !library.open || library.mode === 'off') return
    let alive = true; setSpaces(undefined); setError('')
    void host.service('mcp', 'spaces', { libraryId: library.libraryId }).then(value => { if (alive) setSpaces(value as PermissionRow[]) }, e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [host, expanded, enabled, library.libraryId, library.open, library.mode, refresh])

  const setSpaceGrant = async (space: SpaceBindingInfo, permission: 'revise' | 'recycle', value: boolean) => {
    setLocalBusy(true); setError('')
    try {
      await host.service('mcp', 'setSpacePermission', {
        key: library.key,
        spaceId: space.id,
        permission,
        enabled: value,
        revision: space.revision
      })
      setRefresh(v => v + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLocalBusy(false)
    }
  }

  if (!expanded) return null
  return <div className="mcp-space-permissions">
    {!enabled || !library.open || library.mode === 'off' ? <p className="muted">{uiText("请启用应用 MCP、打开这个仓库并允许访问，再查看关联空间。")}</p> : <>
      <button className="small" disabled={busy || localBusy} onClick={() => setRefresh(v => v + 1)}>{uiText("刷新关联空间与权限")}</button>
      {spaces && !spaces.some(s => s.state === 'active') && <p className="muted">{uiText("此库没有可授权的关联空间。")}</p>}
      {error ? <p role="alert">{error}</p> : !spaces ? <p className="muted">{uiText("读取关联空间…")}</p> : spaces.filter(s => s.state === 'active').map(space => {
        const saved = library.fileSpaces?.find(g => g.spaceId === space.id)
        const update = (permission: 'revise' | 'recycle' | 'browseDirectory', value: boolean) => change({ grant: { key: library.key, mode: library.mode,
          fileSpaces: [...(library.fileSpaces ?? []).filter(g => g.spaceId !== space.id), { revise: false, recycle: false, ...saved, spaceId: space.id, [permission]: value }] } })
        return <div className="mcp-space-row" key={space.id}><strong>{space.name}</strong>
          {space.sourceKind === 'directory' ? <label><input type="checkbox" disabled={busy || localBusy}
            checked={saved?.browseDirectory ?? false} onChange={e => void update('browseDirectory', e.target.checked)}/>{uiText("允许 AI 浏览此原地目录的未收录文件")}</label> : !space.versioned ? <p className="muted">{uiText("旧格式空间")}</p> : <>
            <label><input type="checkbox" checked={saved?.revise ?? false} disabled={busy || localBusy || !canOrganize(library.mode)} onChange={e => void update('revise', e.target.checked)} />{uiText("允许 AI 发布原件新版／恢复历史版本")}</label>
            <label><input type="checkbox" checked={saved?.recycle ?? false} disabled={busy || localBusy || !canOrganize(library.mode)} onChange={e => void update('recycle', e.target.checked)} />{uiText("允许 AI 回收／恢复原件")}</label>
            <small className="muted">{uiText("空间授权：更新")}{space.canRevise ? uiText("已开启") : uiText("未开启")}
              {!space.canRevise && space.revision !== undefined && (
                <>（<button type="button" className="link" disabled={busy || localBusy} onClick={() => void setSpaceGrant(space, 'revise', true)}>{uiText("开启空间更新授权")}</button>）</>
              )}
              {' · '}{uiText("回收")}{space.canRecycle ? uiText("已开启") : uiText("未开启")}
              {!space.canRecycle && space.revision !== undefined && (
                <>（<button type="button" className="link" disabled={busy || localBusy} onClick={() => void setSpaceGrant(space, 'recycle', true)}>{uiText("开启空间回收授权")}</button>）</>
              )}
              {!canOrganize(library.mode) ? uiText("（需将仓库设为整理素材或管理仓库）") : ''}
              {space.error}
            </small>
          </>}
        </div>
      })}
    </>}
  </div>
}
