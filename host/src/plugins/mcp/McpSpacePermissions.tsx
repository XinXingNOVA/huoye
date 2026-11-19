import { canOrganize } from '../../shared/external-access'
import { useEffect, useState } from 'react'
import type { ApplicationUiHost } from '../../plugin-api/ui/application'
import type { ApplicationAccessChange, LibraryGrant } from '../../shared/application-access'
import type { SpaceBindingInfo } from '../../shared/file-spaces'

export function McpSpacePermissions({ host, library, expanded, enabled, busy, change }: {
  host: ApplicationUiHost; library: LibraryGrant & { open: boolean }; expanded: boolean; enabled: boolean; busy: boolean
  change(input: ApplicationAccessChange): Promise<void>
}) {
  const [spaces, setSpaces] = useState<SpaceBindingInfo[]>(), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0), [localBusy, setLocalBusy] = useState(false)
  useEffect(() => {
    if (!expanded || !enabled || !library.open || library.mode === 'off') return
    let alive = true; setSpaces(undefined); setError('')
    void host.service('mcp', 'spaces', { libraryId: library.libraryId }).then(value => { if (alive) setSpaces(value as SpaceBindingInfo[]) }, e => { if (alive) setError(String(e)) })
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
    {!enabled || !library.open || library.mode === 'off' ? <p className="muted">请启用应用 MCP、打开这个仓库并允许访问，再查看关联空间。</p> : <>
      <button className="small" disabled={busy || localBusy} onClick={() => setRefresh(v => v + 1)}>刷新关联空间与权限</button>
      {spaces && !spaces.some(s => s.state === 'active') && <p className="muted">此库没有可授权的关联空间。</p>}
      {error ? <p role="alert">{error}</p> : !spaces ? <p className="muted">读取关联空间…</p> : spaces.filter(s => s.state === 'active').map(space => {
        const saved = library.fileSpaces?.find(g => g.spaceId === space.id)
        const update = (permission: 'revise' | 'recycle', value: boolean) => change({ grant: { key: library.key, mode: library.mode,
          fileSpaces: [...(library.fileSpaces ?? []).filter(g => g.spaceId !== space.id), { spaceId: space.id, revise: saved?.revise ?? false, recycle: saved?.recycle ?? false, [permission]: value }] } })
        return <div className="mcp-space-row" key={space.id}><strong>{space.name}</strong>
          {!space.versioned ? <p className="muted">旧格式空间</p> : <>
            <label><input type="checkbox" checked={saved?.revise ?? false} disabled={busy || localBusy || !canOrganize(library.mode)} onChange={e => void update('revise', e.target.checked)} />允许 AI 发布原件新版／恢复历史版本</label>
            <label><input type="checkbox" checked={saved?.recycle ?? false} disabled={busy || localBusy || !canOrganize(library.mode)} onChange={e => void update('recycle', e.target.checked)} />允许 AI 回收／恢复原件</label>
            <small className="muted">
              空间授权：更新{space.canRevise ? '已开启' : '未开启'}
              {!space.canRevise && space.revision !== undefined && (
                <>（<button type="button" className="link" disabled={busy || localBusy} onClick={() => void setSpaceGrant(space, 'revise', true)}>开启空间更新授权</button>）</>
              )}
              {' · '}回收{space.canRecycle ? '已开启' : '未开启'}
              {!space.canRecycle && space.revision !== undefined && (
                <>（<button type="button" className="link" disabled={busy || localBusy} onClick={() => void setSpaceGrant(space, 'recycle', true)}>开启空间回收授权</button>）</>
              )}
              {!canOrganize(library.mode) ? '（需将仓库设为整理素材或管理仓库）' : ''}
              {space.error}
            </small>
          </>}
        </div>
      })}
    </>}
  </div>
}
