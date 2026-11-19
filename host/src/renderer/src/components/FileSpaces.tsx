import { SpaceDiskCheck } from './SpaceDiskCheck'
import { ItemDisposalDialog } from './ItemDisposalDialog'
import { SpaceDisposalActions } from './SpaceDisposalActions'
import { SpaceFileHistory } from './SpaceFileHistory'
import { FileVersionActions } from './FileVersionActions'
import { importSummary, updateImportPolicy } from '../import-policy'
import { SettingGroup, SettingRow } from './ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceBindingInfo, SpaceCandidate, SpaceCounts, SpaceInfo, SpaceMode, SpacePage, SpaceMutationInput, SpaceMutationPreview, SpaceUnlinkPreview, SpaceForgetPreview } from '../../../shared/file-spaces'
import type { ImportSettings } from '../../../shared/import-settings'
import type { UiHost } from '../plugin'
import type { SpaceVersionReadiness } from '../../../shared/space-versions'
import './file-spaces.css'

const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const modeName = (mode?: SpaceMode) => mode === 'shared' ? '共享' : '独享'
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
const isPreviewableImage = (name: string) => /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(name)

type CollectFilter = 'all' | 'uncollected' | 'outdated' | 'collected' | 'trashed'

/** 空间建立/选择与仓库关联分开：应用页仅保存空间，仓库页再显式建立关联。 */
function SpaceEntry({ busy, run, onSelect }: { busy: boolean; run: (fn: () => Promise<void>) => void; onSelect: (space: SpaceInfo) => Promise<void> }) {
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [parent, setParent] = useState('')
  const [mode, setMode] = useState<SpaceMode>('private')
  return <div className="space-entry">
    <div className="space-actions">
      <button className="small" disabled={busy} onClick={() => run(async () => { const space = await window.bridge.spaces.pick(); if (space) await onSelect(space) })}>选择已有空间…</button>
      <button className="small" disabled={busy} aria-expanded={creating} onClick={() => setCreating(v => !v)}>新建文件空间</button>
    </div>
    {creating && <form className="space-create" onSubmit={e => { e.preventDefault(); run(async () => { const space = await window.bridge.spaces.create(parent, name, mode); await onSelect(space); setCreating(false); setName('') }) }}>
      <label>名称<input className="field-text" required value={name} onChange={e => setName(e.target.value)} disabled={busy} placeholder="例如：共享素材" /></label>
      <label>存放位置<div className="space-actions"><input className="field-text" required value={parent} onChange={e => setParent(e.target.value)} disabled={busy} /><button type="button" className="small" disabled={busy} onClick={() => run(async () => { const path = await window.bridge.vaults.pick('parent'); if (path) setParent(path) })}>选择…</button></div></label>
      <label>使用方式<select value={mode} disabled={busy} onChange={e => setMode(e.target.value as SpaceMode)}><option value="private">独享 · 单个仓库</option><option value="shared">共享 · 多个仓库</option></select></label>
      <div className="space-actions"><button type="button" className="small" disabled={busy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={busy || !name.trim() || !parent.trim()}>创建空间</button></div>
    </form>}
  </div>
}

function ModeChange({ space, busy, run, done }: { space: Pick<SpaceInfo, 'root' | 'mode' | 'revision' | 'members' | 'versioned'>; busy: boolean; run: (fn: () => Promise<void>) => void; done: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const next = space.mode === 'shared' ? 'private' : 'shared'
  return <div className="space-mode">
    {!confirming ? <button className="small" title={next === 'private' && space.members > 1 ? '仍有多个仓库关联，请先解除其他仓库的关联' : undefined} disabled={busy || (next === 'private' && space.members > 1)} onClick={() => setConfirming(true)}>改为{modeName(next)}…</button> : <div className="space-confirm" role="group" aria-label="确认空间模式">
      <p>模式改变空间的关联范围；内容仍通过版本协议发布，历史版本保留。</p>
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => setConfirming(false)}>取消</button><button className="primary" disabled={busy} onClick={() => run(async () => { await window.bridge.spaces.mode(space.root, next, space.revision); setConfirming(false); await done() })}>确认改为{modeName(next)}</button></div>
    </div>}
  </div>
}

/** 当前空间的收录与更新规则：包含策略切换、默认写入、解除关联。 */
function SpacePolicyBar({ space, host, importSettings, busy, run, onUpdated, onUnlink }: {
  space: SpaceBindingInfo
  host: UiHost
  importSettings?: ImportSettings
  busy: boolean
  run: (fn: () => Promise<void>) => void
  onUpdated: (next: ImportSettings, noticeText?: string) => Promise<void>
  onUnlink?: () => void
}) {
  if (!importSettings || space.state !== 'active' || space.error) return null
  const rule = importSettings.spaces.find(r => r.spaceId === space.id)
  const automatic = rule?.automatic ?? false
  const updates = rule?.updates ?? 'manual'
  const isDefault = importSettings.defaultSpaceId === space.id

  const saveRule = ({ makeDefault, ...rule }: { automatic?: boolean; updates?: 'manual' | 'automatic'; makeDefault?: boolean }) => run(async () => {
    const next = await updateImportPolicy(host.core, makeDefault ? { defaultSpaceId: space.id } : { space: { spaceId: space.id, ...rule } })
    await onUpdated(next, '空间收录策略已保存。')
  })

  return (
    <div className="space-policy-bar" aria-label="本仓库对此空间的策略">
      <label className="space-policy-item">
        <span className="muted">新增文件</span>
        <select
          aria-label="空间新增文件策略"
          value={String(automatic)}
          disabled={busy}
          onChange={e => saveRule({ automatic: e.target.value === 'true' })}
        >
          <option value="false">手动选择收录</option>
          <option value="true">自动收录新文件</option>
        </select>
      </label>
      {space.versioned && (
        <label className="space-policy-item">
          <span className="muted">原件新版</span>
          <select
            aria-label="空间新版接纳策略"
            value={updates}
            disabled={busy}
            onChange={e => saveRule({ updates: e.target.value as 'manual' | 'automatic' })}
          >
            <option value="manual">预览后接纳</option>
            <option value="automatic">自动接纳新版</option>
          </select>
        </label>
      )}
      {isDefault ? (
        <span className="space-default-tag">默认写入空间</span>
      ) : (
        <button type="button" className="small" disabled={busy} onClick={() => saveRule({ makeDefault: true })}>
          设为默认写入
        </button>
      )}
      {!space.embedded && onUnlink && (
        <button type="button" className="small" disabled={busy} onClick={onUnlink}>
          解除关联…
        </button>
      )}
    </div>
  )
}

/** 同一个空间浏览器可独立使用，或带当前仓库的收录上下文。 */
function SpaceFilesPanel({ space, host, importSettings, refreshed, onImportSettingsUpdated, onLinkToLibrary, onUnlinkRequest, initialFilter = 'all' }: {
  space: SpaceInfo & { canRevise?: boolean; canRecycle?: boolean; counts?: SpaceCounts; embedded?: boolean; default?: boolean; state?: string }
  host?: UiHost
  importSettings?: ImportSettings
  refreshed(): Promise<void>
  onImportSettingsUpdated?: (next: ImportSettings, noticeText?: string) => Promise<void>
  initialFilter?: CollectFilter
  onLinkToLibrary?: () => void
  onUnlinkRequest?: () => void
}) {
  const [diskCheck, setDiskCheck] = useState(false)
  const [versionCheck, setVersionCheck] = useState<SpaceVersionReadiness>()
  useEffect(() => setVersionCheck(undefined), [space.id, space.root, space.revision])
  const [permissions, setPermissions] = useState<Awaited<ReturnType<typeof window.bridge.spaces.versionPermissions>>>()
  const [scope, setScope] = useState<'active' | 'recycled' | 'records'>('active'), [settings, setSettings] = useState(false)
  const [recordScope, setRecordScope] = useState<'current' | 'archived'>('current')
  const [collectFilter, setCollectFilter] = useState<CollectFilter>(initialFilter)
  const [searchDraft, setSearchDraft] = useState(''), [search, setSearch] = useState('')
  const [composing, setComposing] = useState(false)
  const [page, setPage] = useState<SpacePage>(), [counts, setCounts] = useState<SpaceCounts | undefined>(space.counts)
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set()), [focusedFileId, setFocusedFileId] = useState<string>()
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<{ preview: SpaceMutationPreview; input: SpaceMutationInput }>()
  const [disposalOpen, setDisposalOpen] = useState(false)
  const confirmRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (space.counts) setCounts(space.counts) }, [space.counts])

  useEffect(() => {
    if (composing || searchDraft === search) return
    const timer = setTimeout(() => { setSearch(searchDraft); setOffset(0) }, 220)
    return () => clearTimeout(timer)
  }, [searchDraft, search, composing])

  useEffect(() => { if (confirmation) { confirmRef.current?.querySelector('button')?.focus({ preventScroll: true }); confirmRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } }, [confirmation])
  const pageVersion = useRef<number | undefined>(undefined), pageSnapshot = useRef<string | undefined>(undefined)
  const adoptRetry = useRef<{ signature: string; id: string } | undefined>(undefined)
  const pageContext = useRef('')
  const refresh = async () => { pageSnapshot.current = undefined; await refreshed(); setOffset(0); setRevision(v => v + 1); setConfirmation(undefined) }
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn() } catch (e) { setError(message(e)) } finally { setBusy(false) } }

  useEffect(() => {
    let alive = true
    const activeCollectFilter = host && scope === 'active' && collectFilter !== 'all' ? collectFilter : undefined
    const queryKey = `${space.id}:${scope}:${recordScope}:${activeCollectFilter ?? 'all'}:${search}`
    if (pageContext.current !== queryKey) {
      pageContext.current = queryKey
      pageSnapshot.current = undefined
      setPage(undefined); setSelected(new Set()); setFocusedFileId(undefined); setConfirmation(undefined)
    }
    setLoading(true)
    const needCounts = offset === 0
    const buildInput = (useSnapshot: boolean) => ({
      spaceId: space.id,
      scope,
      recordScope,
      ...(search ? { search } : {}),
      ...(activeCollectFilter ? { collectFilter: activeCollectFilter } : {}),
      ...(needCounts ? { includeCounts: true } : {}),
      offset: useSnapshot ? offset : 0,
      limit: 50,
      ...(useSnapshot && offset ? (pageSnapshot.current ? { snapshot: pageSnapshot.current } : { version: pageVersion.current }) : {})
    })
    const fetchPage = (useSnapshot: boolean) => {
      const input = buildInput(useSnapshot)
      return host ? host.core.listSpaceFiles(input) : window.bridge.spaces.files(space.root, input)
    }
    void fetchPage(true).catch(err => {
      if (alive && offset > 0 && String(err).includes('SPACE_CHANGED')) {
        pageSnapshot.current = undefined
        setSelected(new Set())
        setOffset(0)
        return fetchPage(false)
      }
      throw err
    }).then(p => {
      if (!alive) return
      pageVersion.current = p.version
      pageSnapshot.current = p.snapshot
      setPage(p)
      if (p.counts) setCounts(p.counts)
      setError('')
      setLoading(false)
      setSelected(previous => new Set([...previous].filter(id => p.items.some(file => file.id === id))))
    }, e => {
      if (alive) { setError(message(e)); setLoading(false) }
    })
    return () => { alive = false }
  }, [host, space.id, space.root, space.revision, scope, recordScope, collectFilter, search, offset, revision])

  useEffect(() => host?.core.on('fileSpaceChanged', ({ spaceId }) => {
    if (spaceId === space.id) { pageSnapshot.current = undefined; setRevision(v => v + 1) }
  }), [host, space.id])

  useEffect(() => {
    if (!settings || !space.versioned) return
    let alive = true
    void window.bridge.spaces.versionPermissions(space.root, space.id).then(value => { if (alive) setPermissions(value) }, e => { if (alive) setError(message(e)) })
    return () => { alive = false }
  }, [settings, space.versioned, space.id, space.root, space.revision])

  const choices = page?.items.filter(f => selected.has(f.id)) ?? []
  const adoptable = choices.filter(f => f.state === 'available' && (!f.collected || f.trashed))
  const activeDetailFile: SpaceCandidate | undefined =
    focusedFileId ? page?.items.find(f => f.id === focusedFileId) : undefined

  const preview = async () => {
    const input = { spaceId: space.id, action: scope === 'active' ? 'recycle' as const : 'restore' as const, files: choices.map(f => ({ id: f.id, revision: f.revision })) }
    const result = host ? await host.core.previewSpaceMutation(input) : await window.bridge.spaces.preview(space.root, input)
    setConfirmation({ preview: result, input: { ...input, version: result.version, requestId: crypto.randomUUID() } })
  }

  return <section className="space-content" aria-label="空间内容">
    <div className="space-header-card">
      <div className="space-header-main">
        <div className="space-actions">
          <h2>{space.name}</h2>
          <span className="space-badge">{modeName(space.mode)}</span>
          <span className="muted">{space.members} 个仓库关联</span>
          {host && space.versioned && (!space.canRevise || !space.canRecycle) && (
            <button className="small" disabled={busy} onClick={() => setSettings(true)}>原件操作授权…</button>
          )}
          {onLinkToLibrary && (
            <button className="small primary" disabled={busy} onClick={onLinkToLibrary}>关联到当前仓库</button>
          )}
        </div>
        <p className="space-path">{space.root}</p>
      </div>

    </div>

    <nav className="space-tabs" aria-label="空间管理分区">
      <button aria-label="文件" aria-pressed={!diskCheck && !settings && scope === 'active'} disabled={busy || disposalOpen} onClick={() => { setDiskCheck(false); setSettings(false); setScope('active'); setOffset(0) }}>
        文件{counts?.active !== undefined ? <span className="space-tab-count">{counts.active}</span> : null}
      </button>
      <button aria-label="空间回收站" aria-pressed={!diskCheck && !settings && scope === 'recycled'} disabled={busy || disposalOpen} onClick={() => { setDiskCheck(false); setSettings(false); setScope('recycled'); setOffset(0) }}>
        空间回收站{counts?.recycled ? <span className="space-tab-count">{counts.recycled}</span> : null}
      </button>
      <button aria-label="记录管理" aria-pressed={!diskCheck && !settings && scope === 'records'} disabled={busy || disposalOpen} onClick={() => { setDiskCheck(false); setSettings(false); setScope('records'); setOffset(0) }}>
        记录管理{counts?.records ? <span className="space-tab-count">{counts.records}</span> : null}
      </button>
      <button aria-pressed={diskCheck} disabled={busy || disposalOpen} onClick={() => { setDiskCheck(true); setConfirmation(undefined) }}>磁盘检查</button>
      <button aria-pressed={!diskCheck && settings} disabled={busy || disposalOpen} onClick={() => { setDiskCheck(false); setSettings(true); setConfirmation(undefined) }}>空间设置</button>
    </nav>

    {diskCheck ? <SpaceDiskCheck key={space.id} space={space} refresh={refresh} /> : settings ? <div className="space-settings">
      {host && onImportSettingsUpdated && (
        <SpacePolicyBar
          space={space as SpaceBindingInfo}
          host={host}
          importSettings={importSettings}
          busy={busy}
          run={run}
          onUpdated={onImportSettingsUpdated}
          onUnlink={onUnlinkRequest}
        />
      )}
      <SettingGroup title="空间模式与版本存储">
        <SettingRow
          title="空间使用方式"
          description={space.mode === 'shared' && space.members > 1 ? '仍有多个仓库关联，解除其他仓库后可改为独享' : `当前为${modeName(space.mode)}空间 · 关联 ${space.members} 个仓库`}
        >
          <ModeChange space={space} busy={busy} run={run} done={refresh} />
        </SettingRow>
        <SettingRow
          title="版本存储状态"
          description={versionCheck ? `${versionCheck.files} 个文件 · ${versionCheck.members} 个已登记仓库` : '检查空间版本协作协议与写入就绪状态'}
        >
          <button className="small" disabled={busy} onClick={() => run(async () => setVersionCheck(await window.bridge.spaces.versionReadiness(space.root, space.id)))}>查看版本存储状态</button>
        </SettingRow>
      </SettingGroup>
      {versionCheck && <div className="space-version-readiness space-confirm" role="status"><p>{versionCheck.files} 个文件 · {versionCheck.members} 个已登记仓库</p>
        <p>{versionCheck.readyForWarehouseWrites ? `已支持版本协作，登记总大小 ${size(versionCheck.versionBytes)}。` : '空间暂不可写，请检查以下原因。'}</p><ul>{versionCheck.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
      {space.versioned && (
        <SettingGroup title="原件操作授权" description="默认仅允许读取和追加；授权后对应仓库可发布新版或回收原件">
          {permissions?.members.map(member => (
            <label className="ui-setting-row space-permission" key={member.id}>
              <span className="ui-setting-info"><span className="ui-setting-title">允许「{member.name}」发布原件新版</span></span>
              <span className="ui-setting-control">
                <input type="checkbox" checked={member.revise} disabled={busy} onChange={e => { const enabled = e.target.checked; run(async () => { setPermissions(await window.bridge.spaces.setVersionPermission(space.root, space.id, member.id, 'revise', enabled, permissions.revision)); await refresh(); setNotice('空间更新授权已保存。') }) }} />
              </span>
            </label>
          ))}
          {permissions?.members.map(member => (
            <label className="ui-setting-row space-permission" key={`recycle-${member.id}`}>
              <span className="ui-setting-info"><span className="ui-setting-title">允许「{member.name}」回收和恢复原件</span></span>
              <span className="ui-setting-control">
                <input type="checkbox" checked={member.recycle} disabled={busy} onChange={e => { const enabled = e.target.checked; run(async () => { setPermissions(await window.bridge.spaces.setVersionPermission(space.root, space.id, member.id, 'recycle', enabled, permissions.revision)); await refresh(); setNotice('空间回收授权已保存。') }) }} />
              </span>
            </label>
          ))}
          {permissions?.members.length === 0 && (
            <div className="ui-setting-row"><span className="ui-setting-desc muted">尚无关联仓库。</span></div>
          )}
        </SettingGroup>
      )}
    </div> : <>
      {scope !== 'active' && <p className="muted space-caption">{scope === 'records' ? '管理已移走、处置未完成或已归档的记录。' : '回收原件将暂停关联仓库读取，仓库内的笔记与标签保留。'}</p>}

      <div className="space-workbench-toolbar">
        {host && scope === 'active' && (
          <div className="space-filter-pills" role="group" aria-label="收录状态筛选">
            {([
              ['all', '全部', counts?.active],
              ['uncollected', '未收录', counts?.uncollected],
              ['outdated', '有新版', counts?.outdated],
              ['collected', '已收录', counts?.collected],
              ['trashed', '本库回收站', counts?.trashed]
            ] as const).map(([id, label, count]) => {
              if (id === 'trashed' && !count && collectFilter !== 'trashed') return null
              return (
                <button
                  key={id}
                  type="button"
                  className={`space-pill${collectFilter === id ? ' active' : ''}${(id === 'outdated' || id === 'uncollected') && count ? ' highlight' : ''}`}
                  aria-pressed={collectFilter === id}
                  disabled={busy || disposalOpen}
                  onClick={() => { setCollectFilter(id); setOffset(0) }}
                >
                  <span>{label}</span>
                  {count !== undefined && <span className="space-pill-count">{count}</span>}
                </button>
              )
            })}
          </div>
        )}
        <div className="space-search-wrap">
          <input
            type="search"
            className="field-text space-search-input"
            aria-label="搜索空间文件"
            placeholder="搜索文件名…"
            value={searchDraft}
            disabled={disposalOpen}
            onChange={e => setSearchDraft(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { setSearch(searchDraft); setOffset(0) }
              else if (e.key === 'Escape' && searchDraft) { e.stopPropagation(); setSearchDraft(''); setSearch(''); setOffset(0) }
            }}
          />
        </div>
        <div className="space-actions space-file-tools">
          {scope === 'active' && <button className="small" disabled={busy} onClick={() => run(async () => {
            const paths = await window.bridge.pickImport(); if (!paths.length) return
            const result = await window.bridge.spaces.add(space.root, paths); await refresh(); setNotice(`已保存 ${result.added} 个文件。`)
            if (result.errors.length) throw new Error(result.errors.join('\n'))
          })}>添加文件到空间…</button>}
          <button className="small" disabled={busy || loading} onClick={() => run(async () => { await refresh(); setNotice('已刷新文件状态。') })}>检查并刷新</button>
          {scope === 'records' && host && <button className="small" onClick={() => host.showDialog(close => <ItemDisposalDialog onClose={close} />)}>组合删除记录…</button>}
          {scope === 'records' && <label className="space-actions">显示<select aria-label="记录范围" disabled={busy || disposalOpen} value={recordScope} onChange={e => { setRecordScope(e.target.value as 'current' | 'archived'); setOffset(0) }}><option value="current">待处理记录</option><option value="archived">已归档记录</option></select></label>}
          {page && <span className="muted">{page.total} {scope === 'records' ? '条记录' : '个原件'}</span>}
        </div>
      </div>

      {loading && <p className="muted">读取文件…</p>}
      {page && <>
        <div className="space-action-bar space-candidates-head">
          <div className="space-actions space-selection">
            <button className="small" disabled={busy || !!confirmation || disposalOpen || !page.items.length} onClick={() => setSelected(new Set(page.items.map(f => f.id)))}>选择本页</button>
            {host && scope === 'active' && <button className="small" disabled={busy || !!confirmation || disposalOpen} onClick={() => setSelected(new Set(page.items.filter(f => f.state === 'available' && !f.collected).map(f => f.id)))}>选择本页未收录</button>}
            {selected.size > 0 && <><span className="muted">已选 {selected.size} 项</span><button className="small" disabled={busy || !!confirmation || disposalOpen} onClick={() => setSelected(new Set())}>取消选择</button></>}
            {scope !== 'records' && <button className="small" title={space.versioned && host && !space.canRecycle ? '需在空间设置中开启回收授权' : undefined} disabled={busy || disposalOpen || !choices.length || !!confirmation || (!!host && !space.canRecycle)} onClick={() => run(preview)}>{scope === 'active' ? '回收原件…' : '恢复原件…'}</button>}
          </div>
          {host && scope === 'active' && (
            <div className="space-adoption">
              <button className="primary" disabled={busy || disposalOpen || !adoptable.length || !!confirmation} onClick={() => run(async () => {
                const files = adoptable.map(f => ({ id: f.id, revision: f.revision })), signature = JSON.stringify([space.id, files])
                if (adoptRetry.current?.signature !== signature) adoptRetry.current = { signature, id: crypto.randomUUID() }
                await host.core.adoptSpaceFiles({ spaceId: space.id, files, requestId: adoptRetry.current.id }); adoptRetry.current = undefined
                await refresh(); setNotice(`已收录 ${files.length} 项；可在仓库中撤销。`)
              })}>收录所选{adoptable.length ? ` (${adoptable.length})` : ''}</button>
            </div>
          )}
        </div>

        <SpaceDisposalActions space={space} choices={choices} host={host} busy={busy} blocked={!!confirmation} revision={revision} run={run} refresh={refresh} onPlanning={setDisposalOpen} records={() => { setScope('records'); setRecordScope('current'); setOffset(0) }} />

        <div className="space-file-list">{page.items.map(file => {
          const hasUpdate = file.hasUpdate ?? (!!file.adoptedVersion && file.contentVersion !== file.adoptedVersion)
          const statusText = file.cleanedAt ? '版本明细已清理'
            : file.lifecycle === 'disposing' ? '处置未完成'
            : file.lifecycle === 'disposed' ? '已移到系统废纸篓'
            : scope === 'recycled' ? '原件已回收'
            : hasUpdate ? '有新版本待接纳'
            : file.state !== 'available' ? '不可用'
            : host ? (file.trashed ? '素材已回收' : file.collected ? '本仓库已收录' : '本仓库未收录')
            : '可用'
          const showThumb = host && file.state === 'available' && file.reference && isPreviewableImage(file.name)
          const isFocused = activeDetailFile?.id === file.id
          return (
            <div className={`space-file-item${isFocused ? ' is-expanded' : ''}`} key={file.id}>
              <div className={`space-file-row-wrap${isFocused ? ' active-detail' : ''}`}>
                <label className="space-file" title={file.disposalError || file.error}>
                  <input type="checkbox" checked={selected.has(file.id)} disabled={busy || !!confirmation || disposalOpen} onChange={e => setSelected(s => { const next = new Set(s); if (e.target.checked) next.add(file.id); else next.delete(file.id); return next })} />
                  {showThumb ? (
                    <span className="space-file-thumb">
                      <img src={host.url(file.reference!)} loading="lazy" alt="" onError={e => { e.currentTarget.hidden = true }} />
                    </span>
                  ) : (
                    <span className="space-file-ext">{(file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase()}</span>
                  )}
                  <span className="space-file-name">
                    {file.name}
                    <small className="muted">{size(file.size)} · 修订 {file.revision}{file.recycledAt ? ` · 回收于 ${new Date(file.recycledAt).toLocaleString()}` : ''}</small>
                  </span>
                  <span className={`space-status-pill${hasUpdate ? ' warn' : file.collected && !file.trashed ? ' ok' : ''}`}>
                    {statusText}{file.archivedAt && ' · 已归档'}
                  </span>
                </label>
                {((host && scope === 'active' && file.collected && !file.trashed) || (space.versioned && !file.cleanedAt)) && (
                  <button
                    type="button"
                    className={`small space-file-inspect${isFocused ? ' on' : ''}`}
                    title="查看版本与修改操作"
                    disabled={busy || loading || disposalOpen || !!confirmation}
                    onClick={() => setFocusedFileId(id => id === file.id ? undefined : file.id)}
                  >
                    {hasUpdate ? '预览更新…' : '版本'}
                  </button>
                )}
              </div>
              {isFocused && activeDetailFile && (
                <div className="space-detail-drawer">
                  {host && scope === 'active' && activeDetailFile.collected && !activeDetailFile.trashed && (
                    <FileVersionActions key={`actions:${activeDetailFile.id}`} file={activeDetailFile} host={host} busy={busy || disposalOpen} run={run} refresh={refresh} notify={setNotice} />
                  )}
                  {space.versioned && !activeDetailFile.cleanedAt && (
                    <SpaceFileHistory key={`history:${activeDetailFile.id}`} space={space} file={activeDetailFile} host={host} busy={busy || disposalOpen} run={run} refresh={refresh} notify={setNotice} />
                  )}
                </div>
              )}
            </div>
          )
        })}</div>

        {!page.items.length && <p className="muted">{search || collectFilter !== 'all' ? '没有符合筛选条件的文件。' : scope === 'records' ? '暂无需要管理的记录。' : scope === 'recycled' ? '空间回收站为空。' : '空间中暂无文件。'}</p>}

        <div className="space-actions space-pagination">
          <button className="small" disabled={busy || !!confirmation || disposalOpen || offset === 0} onClick={() => setOffset(v => Math.max(0, v - 50))}>上一页</button>
          <span className="muted">第 {Math.floor(offset / 50) + 1} 页</span>
          <button className="small" disabled={busy || !!confirmation || disposalOpen || page.nextOffset === undefined} onClick={() => setOffset(page.nextOffset!)}>下一页</button>
        </div>
      </>}
      {confirmation && <div ref={confirmRef} className="space-confirm" role="group" aria-label="确认原件操作">
        <h3>{confirmation.input.action === 'recycle' ? '回收' : '恢复'} {confirmation.input.files.length} 个空间原件</h3>
        <p>{confirmation.input.action === 'recycle' ? '原件及历史版本将暂停向关联仓库提供读取，可在空间回收站恢复；素材标签与笔记保留。' : '恢复原件读取，沿用原文件身份与各库已采用的版本；不恢复仓库回收站素材，也不自动重新收录。'}</p>
        <p className="muted">{confirmation.preview.references.scope === 'current-library' ? `本仓库有 ${confirmation.preview.references.active} 项活跃素材、${confirmation.preview.references.trashed} 项回收站素材引用这些原件。` : '未检查仓库引用数量；所有已有引用的读取状态会随原件改变。'}</p>
        {confirmation.preview.space.mode === 'shared' && <p className="muted">此空间关联 {confirmation.preview.space.members} 个仓库；其他仓库的具体引用未检查。</p>}
        {confirmation.preview.files.filter(f => !f.eligible).map(f => <p className="package-error" key={f.id}>{f.name}：{f.reason}</p>)}
        <div className="space-actions"><button className="small" disabled={busy} onClick={() => { setConfirmation(undefined); setError('') }}>取消</button><button className="small" disabled={busy} onClick={() => run(refresh)}>刷新后重新选择</button><button className="small primary" disabled={busy || !!confirmation.preview.blocked || confirmation.preview.files.some(f => !f.eligible)} onClick={() => run(async () => {
          const result = host ? await host.core.mutateSpaceFiles(confirmation.input) : await window.bridge.spaces.mutate(space.root, confirmation.input)
          await refresh(); setNotice(`${result.action === 'recycle' ? '已回收' : '已恢复'} ${result.items.length} 个原件。仓库记录保留。`)
        })}>{busy ? '处理中…' : '确认' + (confirmation.input.action === 'recycle' ? '回收原件' : '恢复原件')}</button>
          {busy && space.versioned && <button className="small" onClick={() => void (host ? host.core.cancelSpaceOperation(confirmation.input.requestId) : window.bridge.spaces.cancelOperation(confirmation.input.requestId)).catch(e => setError(message(e)))}>取消本次处理</button>}</div>
      </div>}
    </>}
    {error && <div role="alert"><p className="package-error">{error}</p>
      {host && error.includes('[LIBRARY_OFFLINE]') && <button className="small" onClick={() => void window.bridge.vaults.reload()}>重新加载仓库</button>}
    </div>}{notice && <p role="status">{notice}</p>}
  </section>
}

export function ApplicationFileSpaces({ onOpenSpace }: { onOpenSpace?(id: string): void }) {
  const [rows, setRows] = useState<SpaceInfo[]>([]), [active, setActive] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const refresh = async () => setRows(await window.bridge.spaces.list())
  useEffect(() => { let alive = true; void window.bridge.spaces.list().then(v => { if (alive) { setRows(v); setActive(id => id || v[0]?.id || '') } }, e => { if (alive) setError(message(e)) }); return () => { alive = false } }, [])
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn() } catch (e) { setError(message(e)) } finally { setBusy(false) } }
  const space = rows.find(r => r.id === active)
  return <section className="space-manager">
    <h2>文件空间</h2>
    <SpaceEntry busy={busy} run={run} onSelect={async s => { await refresh(); setActive(s.id) }} />
    {error && <p role="alert" className="package-error">{error}</p>}
    <div className="space-actions"><h3>本机已知空间</h3><button className="small" disabled={busy} onClick={() => run(refresh)}>刷新</button></div>
    {onOpenSpace ? <div className="space-list">{rows.map(row => <div className="space-actions" key={row.id}>
      <strong>{row.name}</strong><span className="muted">{modeName(row.mode)}</span>
      <button className="small" onClick={() => onOpenSpace(row.id)}>在工作台打开</button>
    </div>)}{!rows.length && <p className="muted">尚无已登记的文件空间。</p>}</div> :
    <div className="space-layout"><aside className="space-list">{rows.map(row => <button className={`space-list-item${active === row.id ? ' active' : ''}`} key={row.id} onClick={() => setActive(row.id)}><strong>{row.name}</strong><span>{modeName(row.mode)}</span></button>)}</aside>
      {space ? <SpaceFilesPanel key={space.id} space={space} refreshed={refresh} /> : <p className="muted">选择左侧空间查看文件与回收站。</p>}</div>}
  </section>
}

/** 仓库关系入口；不在此处回收原件或转换空间模式。 */
export function LibrarySpaceLinks({ host, rows, disabled, changed, openSpace }: { host: UiHost; rows: SpaceBindingInfo[]; disabled: boolean; changed(): Promise<void>; openSpace(id: string): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [unlink, setUnlink] = useState<SpaceUnlinkPreview>()
  const [forget, setForget] = useState<SpaceForgetPreview>()
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn() } catch (e) { setError(message(e)) } finally { setBusy(false) } }
  return <div className="space-links">
    <div className="ui-setting-group">
      <SpaceEntry busy={busy || disabled} run={run} onSelect={async s => { await host.core.linkFileSpace(s.root); await changed(); setNotice(`已关联“${s.name}”。`) }} />
      <div className="ui-setting-group-card">
        {rows.map(row => (
          <div className="ui-setting-row space-link-row" key={row.id}>
            <div className="ui-setting-info">
              <strong className="ui-setting-title">{row.name}</strong>
              <small className="ui-setting-desc muted">{row.state === 'detached' ? '已解除关联' : row.error ? '关联不可用' : modeName(row.mode)}{row.default ? ' · 默认写入' : ''}{row.embedded ? ' · 随仓库' : ''}</small>
            </div>
            <div className="ui-setting-control">
              {row.state !== 'detached' && <button className="small" onClick={() => openSpace(row.id)}>查看空间</button>}
              {!row.embedded && row.state !== 'detached' && <button className="small" disabled={busy || disabled} onClick={() => run(async () => { setForget(undefined); setUnlink(await host.core.previewUnlinkFileSpace(row.id)) })}>解除关联…</button>}
              {!row.embedded && row.state === 'detached' && <button className="small" disabled={busy || disabled} onClick={() => run(async () => { setUnlink(undefined); setForget(await host.core.previewForgetFileSpace(row.id)) })}>移除记录…</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
    {unlink && <div className="space-confirm" role="group" aria-label="解除空间关联">
      <p>本仓库有 {unlink.references.active} 项活跃素材、{unlink.references.trashed} 项回收站素材引用此空间。解除后保留仓库数据与原件，仅停止访问。</p>
      {unlink.reason && <p className="package-error">{unlink.reason}</p>}
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => setUnlink(undefined)}>取消</button><button className="primary" disabled={busy || !unlink.canUnlink} onClick={() => run(async () => { await host.core.unlinkFileSpace(unlink.spaceId); setUnlink(undefined); await changed(); setNotice('已解除关联。') })}>保留数据并解除</button></div>
    </div>}
    {forget && <div className="space-confirm" role="group" aria-label="移除空间关联记录">
      <h3>移除「{forget.name}」的记录</h3>
      <p>本仓库仍有 {forget.references.active} 项活跃素材、{forget.references.trashed} 项回收站素材引用它。仅移除空间列表记录，素材与原文件保留。</p>
      {forget.reason && <p className="package-error">{forget.reason}</p>}
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => setForget(undefined)}>取消</button><button className="primary" disabled={busy || disabled || !forget.canForget} onClick={() => run(async () => {
        await host.core.forgetFileSpace(forget.spaceId); setForget(undefined); await changed(); setNotice('已移除空间记录。')
      })}>仅移除记录</button></div>
    </div>}
    {error && <p className="package-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>
}

/** 唯一的主文件空间工作台：收拢当前仓库关联空间、本机未关联空间、导入收录策略与解除/移除操作。 */
export function LibraryFileSpaces({ host, visible = true, spaceId }: { host: UiHost; visible?: boolean; spaceId?: string }) {
  const [rows, setRows] = useState<SpaceBindingInfo[]>([]), [localSpaces, setLocalSpaces] = useState<SpaceInfo[]>([])
  const [active, setActive] = useState(spaceId ?? ''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [importSettings, setImportSettings] = useState<ImportSettings>()
  const [linking, setLinking] = useState(false), [onceOpen, setOnceOpen] = useState(false), [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState<{ paths: string[]; requestId: string; spaceId: string; collect: boolean }>()
  const [landing, setLanding] = useState<{ requestId: string; spaceId: string; filter: CollectFilter }>()
  const running = useRef(false)
  const [onceTarget, setOnceTarget] = useState(''), [onceCollect, setOnceCollect] = useState(true)
  const [unlink, setUnlink] = useState<SpaceUnlinkPreview>()
  const [forget, setForget] = useState<SpaceForgetPreview>()

  const refreshRevision = useRef(0)
  const core = host.core
  const refresh = useCallback(async () => {
    const ticket = ++refreshRevision.current
    const scan = await core.scanSpaceImports()
    const [settings, locals] = await Promise.all([
      core.getImportSettings().catch(() => undefined),
      window.bridge.spaces.list().catch(() => [] as SpaceInfo[])
    ])
    const bindings = settings?.bindings ?? await core.listFileSpaces({ includeCounts: true })
    if (ticket !== refreshRevision.current) return
    setRows(bindings)
    setLocalSpaces(locals)
    if (settings) setImportSettings(settings)
    setActive(id => id || bindings.find(r => r.default)?.id || bindings[0]?.id || locals[0]?.id || '')
    setNotice([scan.updated ? `已接纳 ${scan.updated} 个新版` : '', scan.updatesPending ? `${scan.updatesPending} 个新版待接纳` : '', scan.collected ? `自动收录 ${scan.collected} 项` : '', scan.remaining ? `仍有 ${scan.remaining} 项待处理` : '', ...scan.errors.map(e => e.message)].filter(Boolean).join('；'))
  }, [core])

  useEffect(() => { if (spaceId) setActive(spaceId) }, [spaceId])
  useEffect(() => {
    if (!visible) return
    let alive = true
    void refresh().catch(e => { if (alive) setError(message(e)) })
    return () => { alive = false; refreshRevision.current++ }
  }, [refresh, visible])

  const run = async (fn: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await fn() } catch (e) { setError(message(e)) }
    finally { running.current = false; setBusy(false) }
  }
  const boundSpace = rows.find(r => r.id === active)
  const unlinkedLocalSpaces = localSpaces.filter(l => !rows.some(r => r.id === l.id && r.state !== 'detached'))
  const selectedLocalOnly = !boundSpace || boundSpace.state === 'detached' ? localSpaces.find(l => l.id === active) : undefined
  const activeBindings = rows.filter(r => r.state === 'active' && !r.error)

  const openImport = () => run(async () => {
    if (onceOpen) { setOnceOpen(false); return }
    const current = await host.core.getImportSettings()
    setImportSettings(current); setRows(current.bindings)
    setOnceTarget(current.defaultSpaceId); setOnceCollect(current.collect)
    setNotice(''); setOnceOpen(true)
  })
  const importFiles = () => run(async () => {
    let request = retry
    if (!request) {
      const paths = await window.bridge.pickImport()
      if (!paths.length) return
      request = { paths, requestId: crypto.randomUUID(), spaceId: onceTarget, collect: onceCollect }
      setRetry(request)
    }
    const { paths, ...options } = request
    const report = await host.core.importToLibrary(paths.map(path => ({ type: 'file', path })), options)
    setRetry(undefined); setOnceOpen(false)
    if (report.saved.length) {
      setActive(request.spaceId)
      setLanding({ requestId: request.requestId, spaceId: request.spaceId, filter: report.collect ? 'all' : 'uncollected' })
    }
    try { await refresh() } finally { setNotice(importSummary(report, false)) }
  })

  return <div className="file-spaces-tab">
    <header className="space-tab-header">
      <div className="space-header-top">
        <h1>文件空间</h1>
        <div className="space-actions">
          <button className="small" disabled={busy} onClick={() => setLinking(v => !v)} aria-expanded={linking}>关联或新建空间…</button>
          <button className="small" onClick={() => void host.openSettings({ scope: 'library', section: 'import' })}>导入设置…</button>
          <button className="small primary" disabled={busy || !!retry} onClick={() => void openImport()} aria-expanded={onceOpen}>单次导入…</button>
        </div>
      </div>
      {linking && (
        <SpaceEntry
          busy={busy}
          run={run}
          onSelect={async s => {
            await host.core.linkFileSpace(s.root)
            setLinking(false)
            await refresh()
            setActive(s.id)
            setNotice(`已关联“${s.name}”。`)
          }}
        />
      )}
      {onceOpen && (
        <div className="space-confirm space-import-once" aria-label="单次导入" aria-busy={busy}>
          <div className="space-actions">
            <label className="space-policy-item">本次保存空间
              <select value={onceTarget} disabled={busy || !!retry} onChange={e => setOnceTarget(e.target.value)}>
                {activeBindings.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="space-policy-item">本次收录方式
              <select value={String(onceCollect)} disabled={busy || !!retry} onChange={e => setOnceCollect(e.target.value === 'true')}>
                <option value="true">保存并收录</option><option value="false">只保存文件</option>
              </select>
            </label>
            <button className="small primary" disabled={busy || (!retry && !activeBindings.some(s => s.id === onceTarget))}
              onClick={() => void importFiles()}>{retry ? '重试本次导入' : '选择文件并导入…'}</button>
            <button className="small" disabled={busy} onClick={() => { setRetry(undefined); setOnceOpen(false); setError('') }}>
              {retry ? '结束本次尝试' : '取消'}
            </button>
          </div>
        </div>
      )}

    </header>

    {error && <p className="package-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}

    {unlink && <div className="space-confirm" role="group" aria-label="解除空间关联">
      <p>本仓库有 {unlink.references.active} 项活跃素材、{unlink.references.trashed} 项回收站素材引用此空间。解除后保留仓库数据与原件，仅停止访问。</p>
      {unlink.reason && <p className="package-error">{unlink.reason}</p>}
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => setUnlink(undefined)}>取消</button><button className="primary" disabled={busy || !unlink.canUnlink} onClick={() => run(async () => { await host.core.unlinkFileSpace(unlink.spaceId); setUnlink(undefined); await refresh(); setNotice('已解除关联。') })}>保留数据并解除</button></div>
    </div>}

    {forget && <div className="space-confirm" role="group" aria-label="移除空间关联记录">
      <h3>移除「{forget.name}」的记录</h3>
      <p>本仓库仍有 {forget.references.active} 项活跃素材、{forget.references.trashed} 项回收站素材引用它。仅移除空间列表记录，素材与原文件保留。</p>
      {forget.reason && <p className="package-error">{forget.reason}</p>}
      <div className="space-actions"><button className="small" disabled={busy} onClick={() => setForget(undefined)}>取消</button><button className="primary" disabled={busy || !forget.canForget} onClick={() => run(async () => {
        await host.core.forgetFileSpace(forget.spaceId); setForget(undefined); await refresh(); setNotice('已移除空间记录。')
      })}>仅移除记录</button></div>
    </div>}

    <div className="space-layout">
      <aside className="space-list" aria-label="关联的文件空间">
        <div className="space-actions"><h3>本仓库关联</h3><button className="small" onClick={() => void refresh().catch(e => setError(message(e)))}>刷新</button></div>
        {rows.map(row => {
          const uncollected = row.counts?.uncollected ?? 0
          const outdated = row.counts?.outdated ?? 0
          return (
            <button className={`space-list-item${active === row.id ? ' active' : ''}`} key={row.id} aria-label={row.name} aria-pressed={active === row.id} onClick={() => setActive(row.id)}>
              <div className="space-list-main">
                <strong>{row.name}</strong>
                <div className="space-list-badges">
                  {outdated > 0 && <span className="space-mini-badge warn" title={`${outdated} 个新版待接纳`}>{outdated} 待更</span>}
                  {uncollected > 0 && <span className="space-mini-badge" title={`${uncollected} 个未收录文件`}>{uncollected} 待收</span>}
                </div>
              </div>
              <span>{row.state === 'detached' ? '已解除' : row.error ? '不可用' : modeName(row.mode)}{row.embedded ? ' · 随仓库' : ''}{row.default ? ' · 默认' : ''}</span>
            </button>
          )
        })}

        {(!boundSpace || boundSpace.state !== 'active' || boundSpace.error) &&
          <button className="small" onClick={() => host.showDialog(close => <ItemDisposalDialog onClose={close} />)}>组合删除记录…</button>}

        {unlinkedLocalSpaces.length > 0 && (
          <div className="space-list-section">
            <h3>本机其他空间</h3>
            {unlinkedLocalSpaces.map(row => (
              <button className={`space-list-item${active === row.id ? ' active' : ''}`} key={row.id} aria-label={row.name} aria-pressed={active === row.id} onClick={() => setActive(row.id)}>
                <div className="space-list-main">
                  <strong>{row.name}</strong>
                  <span className="space-mini-badge muted-badge">未关联</span>
                </div>
                <span>{modeName(row.mode)} · {row.members} 个仓库</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {boundSpace && boundSpace.state === 'active' && !boundSpace.error ? (
        <SpaceFilesPanel
          key={landing?.spaceId === boundSpace.id ? landing.requestId : boundSpace.id}
          initialFilter={landing?.spaceId === boundSpace.id ? landing.filter : 'all'}
          space={boundSpace as SpaceInfo & { canRevise?: boolean; canRecycle?: boolean; counts?: SpaceCounts }}
          host={host}
          importSettings={importSettings}
          refreshed={refresh}
          onImportSettingsUpdated={async (next, msg) => {
            setImportSettings(next)
            setRows(next.bindings)
            if (msg) setNotice(msg)
          }}
          onUnlinkRequest={!boundSpace.embedded ? () => void run(async () => {
            setForget(undefined)
            setUnlink(await host.core.previewUnlinkFileSpace(boundSpace.id))
          }) : undefined}
        />
      ) : boundSpace && (boundSpace.state === 'detached' || boundSpace.error || boundSpace.state !== 'active') ? (
        <div className="space-detached-panel">
          <div className="space-header-card">
            <div className="space-header-main">
              <div className="space-actions">
                <h2>{boundSpace.name}</h2>
                <span className="space-badge">{boundSpace.state === 'detached' ? '已解除关联' : '关联不可用'}</span>
              </div>
              <p className="space-path">{boundSpace.root}</p>
              {boundSpace.error && <p className="package-error">{boundSpace.error}</p>}
            </div>
            <div className="space-actions">
              {selectedLocalOnly && (
                <button className="small primary" disabled={busy} onClick={() => run(async () => {
                  await host.core.linkFileSpace(boundSpace.root)
                  await refresh()
                  setNotice(`已重新关联“${boundSpace.name}”。`)
                })}>重新关联</button>
              )}
              {!boundSpace.embedded && boundSpace.state === 'detached' && (
                <button className="small" disabled={busy} onClick={() => run(async () => {
                  setUnlink(undefined)
                  setForget(await host.core.previewForgetFileSpace(boundSpace.id))
                })}>移除记录…</button>
              )}
              {!boundSpace.embedded && boundSpace.state !== 'detached' && (
                <button className="small" disabled={busy} onClick={() => run(async () => {
                  setForget(undefined)
                  setUnlink(await host.core.previewUnlinkFileSpace(boundSpace.id))
                })}>解除关联…</button>
              )}
            </div>
          </div>
          {selectedLocalOnly && (
            <SpaceFilesPanel
              key={`local:${selectedLocalOnly.id}`}
              space={selectedLocalOnly}
              refreshed={refresh}
            />
          )}
        </div>
      ) : selectedLocalOnly ? (
        <SpaceFilesPanel
          key={`local:${selectedLocalOnly.id}`}
          space={selectedLocalOnly}
          refreshed={refresh}
          onLinkToLibrary={() => void run(async () => {
            await host.core.linkFileSpace(selectedLocalOnly.root)
            await refresh()
            setActive(selectedLocalOnly.id)
            setNotice(`已关联“${selectedLocalOnly.name}”。`)
          })}
        />
      ) : null}
    </div>
  </div>
}
