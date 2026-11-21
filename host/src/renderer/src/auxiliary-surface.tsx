import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { UiDocumentContext } from '../../plugin-api/ui/internal/document'
import { markDisplayWindow, registerDisplayWindow } from './display-windows'
import type { AuxiliaryKind, WindowBounds } from '../../shared/auxiliary-windows'

const surfaces = new Map<AuxiliaryKind, Window>()
export async function prepareAuxiliarySurface(kind: AuxiliaryKind, bounds?: Partial<WindowBounds>): Promise<Window> {
  const existing = surfaces.get(kind)
  if (existing && !existing.closed) return existing
  await window.bridge.auxiliary.prepare(kind, bounds)
  const child = window.open('about:blank', `rm-${kind}`)
  if (!child) throw new Error(uiText("窗口未能打开，内容已保留"))
  surfaces.set(kind, child)
  return child
}
export function discardAuxiliarySurface(kind: AuxiliaryKind): Promise<void> {
  surfaces.delete(kind)
  return window.bridge.auxiliary.close(kind)
}
/** 退出检查前触发真实输入框 blur，沿用自动保存控件的现有提交约定。 */
export function blurAuxiliaryInputs(): void {
  for (const win of surfaces.values()) if (!win.closed) (win.document.activeElement as HTMLElement | null)?.blur?.()
}

/** 一个受控窗口承载一棵既有 React 子树。外壳不拥有设置、仓库或插件业务。 */
export function AuxiliarySurface({ kind, title, onClose, onLost, onFocus, onBounds, bounds, focusOnMount = true, children }: {
  kind: AuxiliaryKind; title: string; onClose(): Promise<boolean>; onLost(): void; onFocus?(): void; onBounds?(bounds: WindowBounds): void; focusOnMount?: boolean; bounds?: Partial<WindowBounds>; children: ReactNode
}) {
  useUiLocale()
  const callbacks = useRef({ onClose, onLost, onFocus, onBounds, focusOnMount })
  callbacks.current = { onClose, onLost, onFocus, onBounds, focusOnMount }
  const [target, setTarget] = useState<HTMLElement>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false, cleanup: (() => void) | undefined
    const mountWindow = (child: Window) => {
      if (disposed) { void discardAuxiliarySurface(kind); return }
      const unregister = kind === 'settings' ? () => {} : registerDisplayWindow(kind, child)
      surfaces.set(kind, child)
      const doc = child.document
      doc.title = title
      const base = doc.createElement('base'); base.href = document.baseURI; doc.head.append(base)
      // 包含外部插件的样式与开发时 HMR 注入；保留元素身份以免每次更新重新加载所有样式。
      const clones = new Map<Element, Element>()
      const syncStyles = () => {
        const sources = [...document.head.querySelectorAll('style, link[rel="stylesheet"]')]
        for (const [source, clone] of clones) if (!sources.includes(source)) { clone.remove(); clones.delete(source) }
        for (const source of sources) {
          let clone = clones.get(source)
          if (!clone || !clone.isEqualNode(source)) {
            const next = source.cloneNode(true) as Element
            if (clone) clone.replaceWith(next); else doc.head.append(next)
            clones.set(source, next)
          }
        }
      }
      const syncRoot = () => {
        for (const attr of [...doc.documentElement.attributes]) if (!document.documentElement.hasAttribute(attr.name)) doc.documentElement.removeAttribute(attr.name)
        for (const { name, value } of document.documentElement.attributes) {
          if (doc.documentElement.getAttribute(name) !== value) doc.documentElement.setAttribute(name, value)
        }
      }
      syncStyles()
      syncRoot()
      const observer = new MutationObserver(records => {
        if (records.some(record => record.target === document.documentElement)) syncRoot()
        if (records.some(record => record.target !== document.documentElement)) syncStyles()
      })
      observer.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true })
      observer.observe(document.documentElement, { attributes: true })
      const mount = doc.createElement('div'); mount.className = 'auxiliary-surface'; doc.body.append(mount)
      setTarget(mount)
      const off = window.bridge.auxiliary.onEvent(event => {
        if (event.kind !== kind) return
        if (event.type === 'close-request') { markDisplayWindow(child); callbacks.current.onFocus?.(); blurAuxiliaryInputs(); void callbacks.current.onClose() }
        else if (event.type === 'closed') callbacks.current.onLost()
        else if (event.type === 'focus') { markDisplayWindow(child); callbacks.current.onFocus?.() }
        else if (event.type === 'bounds' && event.bounds) callbacks.current.onBounds?.(event.bounds)
        else if (event.type === 'find') doc.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
      })
      void window.bridge.auxiliary[callbacks.current.focusOnMount ? 'focus' : 'show'](kind)
      cleanup = () => { unregister(); if (surfaces.get(kind) === child) surfaces.delete(kind); off(); observer.disconnect(); void window.bridge.auxiliary.close(kind) }
    }
    if (kind === 'settings') { const child = window.open('about:blank', `rm-${kind}`); if (child) mountWindow(child); else setError(uiText("设置窗口未能打开，请关闭后重试。")) }
    else void prepareAuxiliarySurface(kind, bounds).then(mountWindow).catch(() => { if (!disposed) callbacks.current.onLost() })
    return () => { disposed = true; cleanup?.() }
  }, [kind])
  useEffect(() => { const child = surfaces.get(kind); if (child && !child.closed) child.document.title = title }, [kind, title])
  useEffect(() => {
    if (!target) return
    const doc = target.ownerDocument
    if (!doc.activeElement || doc.activeElement === doc.body) doc.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }, [target])
  if (error) return <div className="toast" role="alert">{error}<button onClick={onLost}>{uiText("关闭")}</button></div>
  if (!target) return null
  return createPortal(<UiDocumentContext.Provider value={target.ownerDocument}>{children}</UiDocumentContext.Provider>, target)
}
