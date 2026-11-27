import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { DependentCounts } from './DependentCounts'
import { useEffect, useState } from 'react'
import type { UiHost } from '../plugin'
import { Button, Checkbox, Dialog, SegmentedControl } from '../../../plugin-api/ui/kit'
import { spaceItemGroups, spaceItemPageSize, type SpaceItemGroup, type SpaceItemPage } from '../../../shared/space-items'
import { itemSelectionLimit, type ItemLifecyclePreview } from '../../../shared/item-lifecycle'

const labels = { get primary() { return uiText("主文件") }, get attachment() { return uiText("仅附件引用") }, get unclassified() { return uiText("待辨认引用") }, get trashed() { return uiText("本库回收站") } }

type InventoryProps = {
  host: UiHost; space: { id: string; name: string }
  check?: { label: string; open(): void }
}
export function SpaceItemsButton({ host, space, check }: InventoryProps) {
  useUiLocale()
  const [open, setOpen] = useState(false)
  return <><Button size="sm" onClick={() => setOpen(true)}>{uiText("查看本库素材")}</Button>
    {open && <Inventory key={space.id} host={host} space={space} check={check} close={() => setOpen(false)}/>}</>
}

function Inventory({ host, space, check, close }: InventoryProps & { close(): void }) {
  useUiLocale()
  const [group, setGroup] = useState<SpaceItemGroup>('primary'), [offset, setOffset] = useState(0)
  const [missingOnly, setMissingOnly] = useState(false)
  const [page, setPage] = useState<SpaceItemPage>(), [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState(new Set<string>())
  const [plan, setPlan] = useState<{ preview: ItemLifecyclePreview; ids: string[]; requestId: string }>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const action = group === 'trashed' ? 'restore' : 'trash'
  const filter = missingOnly ? { missingOnly: true as const } : {}
  const total = page && (missingOnly ? page.selectable : page.counts[group])
  const verb = action === 'trash' ? uiText("移入本库回收站") : uiText("从本库回收站恢复")
  useEffect(() => {
    let alive = true
    host.core.listSpaceItems({ spaceId: space.id, group, offset, ...(missingOnly ? { missingOnly: true } : {}) }).then(next => {
      if (!alive) return
      if (offset && offset >= (missingOnly ? next.selectable : next.counts[group])) setOffset(0)
      else setPage(next)
    }, e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [host.core, space.id, group, offset, revision, missingOnly])

  function refresh() {
    setSelection(new Set()); setPlan(undefined); setPage(undefined); setOffset(0); setRevision(r => r + 1)
  }
  function changeGroup(next: SpaceItemGroup) {
    if (group === next) return
    setMissingOnly(false); setGroup(next); setPage(undefined); setOffset(0); setSelection(new Set()); setError(''); setNotice('')
  }
  async function submit() {
    if (busy) return
    setError(''); setNotice(''); setBusy(true)
    try {
      if (!plan) {
        const ids = [...selection].sort()
        const preview = await host.core.previewItemLifecycle({ action, ids, primarySpaceId: space.id, ...filter })
        setPlan({ preview, ids, requestId: crypto.randomUUID() })
      } else {
        await host.core.applyItemLifecycle({ action, ids: plan.ids, primarySpaceId: space.id, ...filter, previewToken: plan.preview.previewToken, requestId: plan.requestId })
        setNotice(uiText("已{verb} {length} 项主文件素材。", { verb, length: String(plan.ids.length) })); refresh()
      }
    } catch (e) {
      setError(String(e))
      if (String(e).includes('PREVIEW_CHANGED')) refresh()
    } finally { setBusy(false) }
  }
  const footer = <>
    {plan && <Button disabled={busy} onClick={() => { setPlan(undefined); setError('') }}>{uiText("返回选择")}</Button>}
    {(plan || selection.size > 0) && <Button variant="primary" loading={busy} onClick={() => void submit()}>
      {plan ? uiText("确认") + verb : uiText("预览{value1}（{size}）", { value1: String(action === 'trash' ? uiText("回收") : uiText("恢复")), size: String(selection.size) })}
    </Button>}
  </>
  return <Dialog title={space.name + uiText(" · 本库素材")} busy={busy} onClose={close} footer={footer}>
    <div className="space-inventory">
      {plan ? <section aria-label={uiText("来源处理预览")}>
        <p>{uiText("将")}{verb}{uiText("所选的")}{' '}{plan.ids.length}{' '}{uiText("项")}{missingOnly ? uiText("经核对缺失的主文件") : uiText("主文件素材")}{uiText("。此操作只处理本库记录。")}</p>
        {page?.items.some(item => selection.has(item.id)) && <ul aria-label={uiText("所选素材示例")}>
          {page.items.filter(item => selection.has(item.id)).slice(0, 5).map(item => <li key={item.id}>{item.title}</li>)}
        </ul>}
        {plan.preview.affected > plan.ids.length && <ul><DependentCounts total={plan.preview.affected - plan.preview.selected} owned={plan.preview.ownedRecords}/></ul>}
      </section> : <>
        <SegmentedControl label={uiText("按来源查看")} value={group} onChange={v => changeGroup(v as SpaceItemGroup)}
          options={spaceItemGroups.filter(g => g !== 'unclassified' || page?.counts.unclassified || group === g)
            .map(g => ({ value: g, label: labels[g] + (page ? ' ' + page.counts[g] : ''), disabled: busy }))}/>
        <div className="space-actions">
          {group === 'primary' && <label className="space-missing-filter"><Checkbox checked={missingOnly} disabled={busy}
            onChange={e => { setMissingOnly(e.target.checked); setError(''); setNotice(''); refresh() }}/>{uiText("只看核对后缺失")}</label>}
          <Button size="sm" disabled={busy} onClick={() => { setError(''); setNotice(''); refresh() }}>{uiText("刷新清单")}</Button>
          {missingOnly && check && <Button size="sm" disabled={busy} onClick={() => { close(); check.open() }}>{check.label}</Button>}
          {!!page?.selectable && <Button size="sm" disabled={busy} onClick={() => setSelection(new Set(page.batchIds))}>
            {page.selectable > itemSelectionLimit ? uiText("选中前 {itemSelectionLimit} 项主文件", { itemSelectionLimit }) : uiText("选中全部主文件")}
          </Button>}
          {selection.size > 0 && <Button size="sm" disabled={busy} onClick={() => setSelection(new Set())}>{uiText("清除选择")}</Button>}
        </div>
        {!page && !error && <p role="status">{uiText("正在读取本库记录…")}</p>}
        {page?.missingIssue ? <p role="status">{page.missingIssue}</p> : page && !total && <p>{missingOnly ? uiText("没有已确认缺失的主文件。") : uiText("本组没有记录。")}</p>}
        {page && !!page.items.length && <ul aria-label={uiText("来源记录")}>{page.items.map(row => <li key={row.id}>
          {row.role === 'primary' && <Checkbox aria-label={uiText("选择 ") + row.title} checked={selection.has(row.id)}
            disabled={busy || (!selection.has(row.id) && selection.size >= itemSelectionLimit)}
            onChange={e => { const next = new Set(selection); if (e.target.checked) next.add(row.id); else next.delete(row.id); setSelection(next) }}/>}
          <Button size="sm" variant="ghost" disabled={busy} title={uiText("查看仓库数据")} onClick={() => { close(); host.openData(row.id) }}>{row.title}</Button>
          {row.missingPath && <small className="space-missing-path" title={row.missingPath}>{row.missingPath}</small>}
          {group === 'trashed' && <small>{labels[row.role]}</small>}
        </li>)}</ul>}
        {page && total !== undefined && total > spaceItemPageSize && <div className="space-actions">
          <Button size="sm" disabled={busy || !offset} onClick={() => { setPage(undefined); setOffset(offset - spaceItemPageSize) }}>{uiText("上一页")}</Button>
          <span>{offset + 1}–{offset + page.items.length} / {total}</span>
          <Button size="sm" disabled={busy || offset + page.items.length >= total} onClick={() => { setPage(undefined); setOffset(offset + spaceItemPageSize) }}>{uiText("下一页")}</Button>
        </div>}
      </>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="package-error">{error}</p>}
    </div>
  </Dialog>
}
