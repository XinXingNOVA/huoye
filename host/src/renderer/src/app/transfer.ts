import { contentDropOwner } from '../content-drop'
import { asElement, onDisplayEvent } from '../display-windows'
import { useEffect, useState } from 'react'
import { ENTITY_DRAG_TYPE } from '../entity-drag'
import { editingTarget, resolveTransfer, snapshotTransfer } from '../transfer-input'
import { SAVED_VIEW_DRAG } from '../view-navigation'
import type { DropZone, Intake, ReceiveDestination } from './intake'
import type { PageAccess } from './page-access'

interface TransferOptions {
  intake: Pick<Intake, 'receive' | 'captureTarget'>
  pages: Pick<PageAccess, 'active' | 'groupActive'>
  activate(id: string): void
  notify(text: string): void
}

/** 仅负责 DOM 输入、高亮和目标定位；读取／下载前捕获规则，交由收录流程执行。 */
interface DropTarget { tab: string; header: boolean; zone?: string; view?: string; destination: ReceiveDestination; internal: boolean }

export function useTransferInput({ intake: { receive, captureTarget: receiveTarget }, pages, activate, notify: showToast }: TransferOptions) {
  const [drop, setDrop] = useState<DropTarget>()
  useEffect(() => {
    let depth = 0
    let zoneEl: HTMLElement | null = null
    let disposed = false
    const transfer = async (snapshot: ReturnType<typeof snapshotTransfer>, tab: string, destination: ReceiveDestination, where?: DropZone, paste = false) => {
      try {
        // 下载完成前用户可能切换筛选或编辑视图；仍按放下那一刻的目标接纳。
        const target = receiveTarget(destination, where)
        const source = paste ? await window.bridge.clipboardSource().catch(() => null) : null
        const { incoming, warnings } = await resolveTransfer(snapshot, source ?? undefined)
        if (disposed) return
        await receive(tab, incoming, where, target)
        if (warnings.length) showToast([...new Set(warnings)].join('；'))
      } catch (e) { if (!disposed) showToast(`收录失败：${e instanceof Error ? e.message : String(e)}`) }
    }
    const accepts = (e: DragEvent) =>
      !e.defaultPrevented && !editingTarget(e.target) && !asElement(e.target)?.closest('dialog,[role="dialog"]') && !!e.dataTransfer && !e.dataTransfer.types.includes(SAVED_VIEW_DRAG) &&
      [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/plain' || t === 'text/html' || t === 'text/uri-list' || t === ENTITY_DRAG_TYPE)
    const targetOf = (e: DragEvent): Omit<DropTarget, 'internal'> & { el: HTMLElement | null } => {
      const el = asElement(e.target)
      const view = el?.closest<HTMLElement>('[data-saved-view]')
      if (view?.dataset.savedView) return { tab: '', header: false, view: view.dataset.savedView, destination: { type: 'view', id: view.dataset.savedView }, el: view }
      const zone = el?.closest<HTMLElement>('[data-drop-zone]') ?? null
      const content = el?.closest<HTMLElement>('[data-tab-content]')
      const owner = contentDropOwner(el ?? null)
      if (owner) return { tab: '', header: false, zone: zone?.dataset.dropZone, destination: { type: 'content', owner }, el: zone }
      // 导航空白、分面和设置控件不隐式变成当前中央页的导入入口。
      if (el?.closest('.sidebar')) return { tab: '', header: false, destination: { type: 'page', id: '' }, el: null }
      const tab = el?.closest('[data-tab]') as HTMLElement | null
      if (tab?.dataset.tab) return { tab: tab.dataset.tab, header: true, destination: { type: 'page', id: tab.dataset.tab }, el: null }
      // 标签页里的拖入区域（例如看板的一列）
      const groupId = el?.closest<HTMLElement>('[data-editor-group]')?.dataset.editorGroup
      const groupActive = pages.groupActive(groupId)
      const id = content?.dataset.tabContent ?? groupActive ?? pages.active() ?? ''
      return { tab: id, header: false, destination: { type: 'page', id }, zone: zone?.dataset.dropZone, el: zone }
    }
    // 拖入区域的高亮直接加在元素上：区域由布局画出，窗口只知道 DOM 上的标记
    const highlight = (el: HTMLElement | null) => {
      if (el === zoneEl) return
      zoneEl?.classList.remove('drop-target')
      el?.classList.add('drop-target')
      zoneEl = el
    }
    const canReceive = (t: Omit<DropTarget, 'internal'>) => {
      if (t.destination.type === 'page' && !t.destination.id) return false
      try { receiveTarget(t.destination, t.zone ? { zone: t.zone, title: '' } : undefined); return true } catch { return false }
    }
    const onEnter = (e: DragEvent) => {
      if (!accepts(e)) return
      depth++
      const { el, ...t } = targetOf(e)
      highlight(canReceive(t) ? el : null)
      setDrop({ ...t, internal: !!e.dataTransfer?.types.includes(ENTITY_DRAG_TYPE) })
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) {
        highlight(null)
        setDrop(undefined)
      }
    }
    const onOver = (e: DragEvent) => {
      if (!accepts(e)) return
      e.preventDefault()
      const { el, ...t } = targetOf(e)
      const allowed = canReceive(t)
      if (e.dataTransfer) e.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
      highlight(allowed ? el : null)
      setDrop((d) => (d && d.tab === t.tab && d.view === t.view && d.destination.type === t.destination.type && (d.destination.type !== 'content' || t.destination.type === 'content' && d.destination.owner === t.destination.owner) && d.header === t.header && d.zone === t.zone ? d : { ...t, internal: !!e.dataTransfer?.types.includes(ENTITY_DRAG_TYPE) }))
    }
    const onDrop = (e: DragEvent) => {
      depth = 0
      const t = targetOf(e)
      const { el, tab, zone, destination } = t
      const title = el?.dataset.dropTitle ?? ''
      highlight(null)
      setDrop(undefined)
      if (!accepts(e)) return
      e.preventDefault()
      if (!canReceive(t)) return
      const dt = e.dataTransfer
      if (!dt) return
      const where = zone ? { zone, title } : undefined
      if (tab) activate(tab)
      void transfer(snapshotTransfer(dt), tab, destination, where)
    }
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || editingTarget(e.target) || asElement(e.target)?.closest('dialog,[role="dialog"]') || !pages.active() || !e.clipboardData) return
      const tab = pages.active()!
      e.preventDefault()
      void transfer(snapshotTransfer(e.clipboardData), tab, { type: 'page', id: tab }, undefined, true)
    }
    const offs = [onDisplayEvent('dragenter', onEnter), onDisplayEvent('dragleave', onLeave), onDisplayEvent('dragover', onOver), onDisplayEvent('drop', onDrop), onDisplayEvent('paste', onPaste)]
    return () => {
      disposed = true
      highlight(null)
      offs.forEach(off => off())
    }
  }, [receive, receiveTarget, showToast, activate, pages])

  return drop
}
