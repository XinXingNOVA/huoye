import { uiText } from '../../../shared/i18n/interface-display'
import { undeliveredImportNotice } from '../receive-items'
import { emitBatch, type ReceiveBatch } from './intake-feedback'
import { contentDropOwner, type ContentDropOwner } from '../content-drop'
import type { ReceiveIntent } from '../../../shared/transfer'
import { asElement, onDisplayDragCancel, onDisplayEvent } from '../display-windows'
import { useEffect, useRef, useState } from 'react'
import { ENTITY_DRAG_TYPE } from '../entity-drag'
import { editingTarget, ordinaryInputs, resolveTransfer, snapshotTransfer } from '../transfer-input'
import { SAVED_VIEW_DRAG } from '../view-navigation'
import type { DropZone, Intake, ReceiveDestination } from './intake'
import type { PageAccess } from './page-access'

interface TransferOptions {
  intake: Pick<Intake, 'receive' | 'captureTarget' | 'collectItems'>
  pages: Pick<PageAccess, 'active' | 'groupActive'>
  activate(id: string): void
  notify(text: string, doc?: Document): void
}

/** 仅负责 DOM 输入、高亮和目标定位；读取／下载前捕获规则，交由收录流程执行。 */
interface DropTarget { tab: string; header: boolean; zone?: string; view?: string; destination: ReceiveDestination; internal: boolean }

export function useTransferInput({ intake: { receive, collectItems, captureTarget: receiveTarget }, pages, activate, notify: showToast }: TransferOptions) {
  const [drop, setDrop] = useState<DropTarget>()
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let depth = 0
    let zoneEl: HTMLElement | null = null
    let hovered: Extract<ContentDropOwner, { kind: 'view' }> | undefined
    const hover = (target?: ContentDropOwner) => {
      const next = target?.kind === 'view' ? target : undefined
      if (next === hovered) return
      hovered?.hover(false)
      hovered = next
      hovered?.hover(true)
    }
    const transfer = async (snapshot: ReturnType<typeof snapshotTransfer>, tab: string, destination: ReceiveDestination, intent: ReceiveIntent, doc: Document, where?: DropZone) => {
      const owner = destination.type === 'content' ? destination.owner : undefined
      const batch: ReceiveBatch | undefined = owner?.kind === 'view' ? { id: crypto.randomUUID(), viewId: owner.viewId(), surface: owner } : undefined
      try {
        // 下载完成前用户可能切换筛选或编辑视图；仍按放下那一刻的目标接纳。
        const surface = destination.type === 'content' && destination.owner.kind === 'items' ? destination.owner : undefined
        const deliver = surface?.capture(intent)
        const target = surface ? undefined : receiveTarget(destination, where)
        if (batch) emitBatch(batch, { phase: 'processing' })
        const source = intent.source === 'paste' ? await window.bridge.clipboardSource().catch(() => null) : null
        const entries = await resolveTransfer(snapshot, source ?? undefined, !!surface)
        if (!mounted.current || batch?.surface.signal.aborted) return
        if (surface && !surface.isCurrent()) {
          showToast(uiText("接收位置已不可用，本次接收已取消"), doc)
          return
        }
        if (surface && deliver) {
          const items = await collectItems(entries)
          if (!mounted.current) return
          if (surface.isCurrent()) await deliver(items)
          else {
            const notice = undeliveredImportNotice(items)
            if (notice) showToast(notice, doc)
          }
          return
        }
        const warnings = entries.flatMap(entry => 'error' in entry ? [entry.error] : [])
        await receive(tab, ordinaryInputs(entries), where, target, batch, batch ? warnings : [], doc)
        if (!batch && warnings.length) showToast([...new Set(warnings)].join('；'), doc)
      } catch (e) {
        if (!mounted.current) return
        const message = uiText("收录失败：{value1}", { value1: String(e instanceof Error ? e.message : e) })
        if (batch) emitBatch(batch, { phase: 'done', accepted: 0, rejected: 0, skipped: 0, savedOnly: 0, errors: 1, message })
        else showToast(message, doc)
      }
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
      if (owner) return { tab: '', header: false, zone: zone?.dataset.dropZone, destination: { type: 'content', owner },
        el: zone ?? el?.closest<HTMLElement>('[data-hy-receive-surface]') ?? null }
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
      if (t.destination.type === 'content' && t.destination.owner.kind === 'items') return true
      try { receiveTarget(t.destination, t.zone ? { zone: t.zone, title: '' } : undefined); return true } catch { return false }
    }
    const clearDrag = () => {
      depth = 0
      hover()
      highlight(null)
      setDrop(undefined)
    }
    const transient = (e: DragEvent) => contentDropOwner(asElement(e.target) ?? null)?.kind === 'transient'
    const clearTransient = (e: DragEvent) => {
      if (!transient(e)) return
      if (e.type === 'dragover') e.preventDefault()
      clearDrag()
    }
    const finishDrop = (e: DragEvent) => {
      if (transient(e)) e.preventDefault()
      clearDrag()
    }
    const onEnter = (e: DragEvent) => {
      if (transient(e) || !accepts(e)) return
      depth++
      const { el, ...t } = targetOf(e)
      const allowed = canReceive(t)
      hover(allowed && t.destination.type === 'content' ? t.destination.owner : undefined)
      highlight(allowed ? el : null)
      setDrop({ ...t, internal: !!e.dataTransfer?.types.includes(ENTITY_DRAG_TYPE) })
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) {
        hover()
        highlight(null)
        setDrop(undefined)
      }
    }
    const onOver = (e: DragEvent) => {
      if (transient(e) || !accepts(e)) return
      e.preventDefault()
      const { el, ...t } = targetOf(e)
      const allowed = canReceive(t)
      hover(allowed && t.destination.type === 'content' ? t.destination.owner : undefined)
      if (e.dataTransfer) e.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
      highlight(allowed ? el : null)
      setDrop((d) => (d && d.tab === t.tab && d.view === t.view && d.destination.type === t.destination.type && (d.destination.type !== 'content' || t.destination.type === 'content' && d.destination.owner === t.destination.owner) && d.header === t.header && d.zone === t.zone ? d : { ...t, internal: !!e.dataTransfer?.types.includes(ENTITY_DRAG_TYPE) }))
    }
    const onDrop = (e: DragEvent) => {
      const t = targetOf(e)
      const { el, tab, zone, destination } = t
      const title = el?.dataset.dropTitle ?? ''
      if (transient(e) || !accepts(e)) return
      e.preventDefault()
      if (!canReceive(t)) return
      const dt = e.dataTransfer
      if (!dt) return
      const where = zone ? { zone, title } : undefined
      const pageId = tab || (destination.type === 'content' && destination.owner.kind === 'items' ? asElement(e.target)?.closest<HTMLElement>('[data-tab-content]')?.dataset.tabContent : undefined)
      if (pageId) activate(pageId)
      void transfer(snapshotTransfer(dt), tab, destination, { source: 'drop', point: { clientX: e.clientX, clientY: e.clientY }, zone }, asElement(e.target)?.ownerDocument ?? document, where)
    }
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || editingTarget(e.target) || asElement(e.target)?.closest('dialog,[role="dialog"]') || !e.clipboardData) return
      const el = asElement(e.target)
      const doc = el?.ownerDocument ?? (e.currentTarget as Window).document
      const active = pages.active()
      let page = el?.closest<HTMLElement>('[data-tab-content]') ?? (active ? doc.querySelector<HTMLElement>(`[data-tab-content="${CSS.escape(active)}"]:not([inert])`) : null)
      if (!page) {
        const visible = doc.querySelectorAll<HTMLElement>('[data-tab-content]:not([inert])')
        if (visible.length === 1) page = visible[0]
      }
      let owner = contentDropOwner(el ?? null)
      if (!page && (!owner || owner.kind === 'query')) return
      const tab = page?.dataset.tabContent ?? ''
      if ((!owner || owner.kind === 'query') && page) {
        const surfaces = page.querySelectorAll('[data-hy-receive-surface]')
        if (surfaces.length === 1) owner = contentDropOwner(surfaces[0])
        else if (Array.from(surfaces).some(surface => contentDropOwner(surface)?.kind === 'transient')) return
      }
      if (owner?.kind === 'transient') return
      const destination: ReceiveDestination = owner && owner.kind !== 'query' ? { type: 'content', owner } : { type: 'page', id: tab }
      e.preventDefault()
      void transfer(snapshotTransfer(e.clipboardData), tab, destination, { source: 'paste' }, doc)
    }
    const offs = [onDisplayDragCancel(clearDrag), onDisplayEvent('drop', finishDrop, true), onDisplayEvent('dragend', clearDrag, true),
      onDisplayEvent('dragenter', clearTransient, true), onDisplayEvent('dragover', clearTransient, true), onDisplayEvent('dragenter', onEnter), onDisplayEvent('dragleave', onLeave), onDisplayEvent('dragover', onOver), onDisplayEvent('drop', onDrop), onDisplayEvent('paste', onPaste)]
    return () => {
      hover()
      highlight(null)
      offs.forEach(off => off())
    }
  }, [receive, collectItems, receiveTarget, showToast, activate, pages])

  return drop
}
