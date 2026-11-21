import { uiText } from '../../../shared/i18n/interface-display'
import { displayDocument, onDisplayEvent, asElement } from '../display-windows'
import { useEffect } from 'react'
import type { EditSessions } from '../editing-sessions'
import type { PageTransitions } from '../page-transitions'
import type { KeyHandler, UiHost } from '../plugin'
import { editingTarget } from '../transfer-input'
import { ALL_VIEW, collectionTab, newTabId, type TabEntry } from '../workspace'
import type { Intake } from './intake'
import type { PageAccess } from './page-access'

interface WindowNavigation {
  activate(id: string): void
  openTab(entry: TabEntry): void
  closeTab(id: string): void
  cycle(step: number): void
  togglePanel(side: 'sidebar' | 'inspector'): void
}
interface InputOverlays {
  preview?: string
  modalOpen: boolean
  commandPaletteOpen?: boolean
  previewKeys(): KeyHandler | null
  closePreview(): void
  openCommandPalette?(): void
  closeCommandPalette?(): void
  exportItems(ids: string[], name: string): void
}
interface CommandOptions {
  host: Pick<UiHost, 'core' | 'notify' | 'trash' | 'purge' | 'openSettings' | 'quickAttach'>
  pages: Pick<PageAccess, 'active' | 'api' | 'focus' | 'keys' | 'activeGroupTabs'>
  navigation: WindowNavigation
  overlays: InputOverlays
  editing: Pick<EditSessions, 'handleHistory'>
  transitions: Pick<PageTransitions, 'busy'>
  createNew(): Promise<void>
  receive: Intake['receive']
  captureTarget: Intake['captureTarget']
}

/** 能打字的输入框（滑块、勾选框不算）。 */
const textField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && /^(text|search|url|email|tel|password|number)$/.test((el as HTMLInputElement).type))

/**
 * ⌘⌫ 在输入框里：删掉光标前的这一行（行首再按就并到上一行），和系统的行为一样。
 * 菜单的"移到回收站"占了这个快捷键，按键先到菜单，这里替系统做。用 execCommand 删，能撤销，界面也收得到输入。
 */
function deleteLineBefore(el: HTMLInputElement | HTMLTextAreaElement): void {
  const start = el.selectionStart ?? 0
  if (start === (el.selectionEnd ?? 0)) {
    const lineStart = el.value.lastIndexOf('\n', start - 1) + 1
    el.setSelectionRange(lineStart < start ? lineStart : Math.max(0, start - 1), start)
  }
  el.ownerDocument.execCommand('delete')
}

/** 输入框 → 浮层 → 活动页 → 窗口。菜单保留自己的原生编辑路由，不另造一套业务命令。 */
export function useWindowCommands({ host, pages, navigation, overlays, editing, transitions, createNew, receive, captureTarget }: CommandOptions) {
  const { core, notify: showToast } = host
  const { activate, openTab, closeTab, cycle, togglePanel } = navigation
  const { preview, modalOpen, commandPaletteOpen, previewKeys, closePreview, openCommandPalette, closeCommandPalette, exportItems } = overlays
  // ---------- 键盘：输入框 → 浮层 → 当前标签页 → 窗口 ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (transitions.busy) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        if (e.isComposing || e.keyCode === 229) return
        e.preventDefault()
        if (commandPaletteOpen) closeCommandPalette?.()
        else if (!modalOpen && !preview) openCommandPalette?.()
        return
      }
      // 对话框开着：按键交给它（例如彻底删除的确认框，焦点在按钮上）
      if (editingTarget(e.target) || modalOpen) return
      if (preview) {
        if (previewKeys()?.(e)) return void e.preventDefault()
        if (e.key === 'Escape' || e.key === ' ') {
          e.preventDefault()
          closePreview()
        }
        return
      }
      const handler = pages.active() ? pages.keys(pages.active()!) : undefined
      if (handler?.(e)) return void e.preventDefault()
      // A：快速附加到当前标签页的焦点（网格里选中的、播放器里正在播的）
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ids = pages.focus(pages.active() ?? '')
        if (ids.length) {
          e.preventDefault()
          host.quickAttach(ids)
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const tabs = pages.activeGroupTabs()
        const t = e.key === '9' ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1]
        if (t) {
          e.preventDefault()
          activate(t)
        }
      }
    }
    return onDisplayEvent('keydown', onKey)
  }, [preview, modalOpen, commandPaletteOpen, previewKeys, closePreview, openCommandPalette, closeCommandPalette, host, activate, pages, transitions])

  // 菜单命令：⌘T、⌘W、⌃Tab、全选、导入
  useEffect(
    () =>
      window.bridge.onMenuCommand((command) => {
        if (transitions.busy) return
        if (command === 'commands') {
          if (commandPaletteOpen) closeCommandPalette?.()
          else if (!modalOpen && !preview) openCommandPalette?.()
          return
        }
        // 模态窗口内只处理原生文本编辑和关闭，不把菜单动作送到背后的素材。
        if (modalOpen && !['settings', 'tab.close', 'selectAll', 'undo', 'redo', 'trash'].includes(command)) return
        const doc = displayDocument(), active = pages.active()
        if (command === 'tab.new') openTab(collectionTab(ALL_VIEW))
        else if (command === 'panel.sidebar') togglePanel('sidebar')
        else if (command === 'panel.inspector') togglePanel('inspector')
        else if (command === 'history') openTab({ id: newTabId(), type: 'history', params: {} })
        else if (command === 'settings') void host.openSettings().catch(e => showToast(String(e)))
        else if (command === 'tab.close') {
          if (commandPaletteOpen) closeCommandPalette?.()
          else if (preview) closePreview()
          else if (active) closeTab(active)
        } else if (command === 'tab.next') cycle(1)
        else if (command === 'tab.prev') cycle(-1)
        else if (command === 'selectAll') {
          const el = doc.activeElement
          if (textField(el)) el.select()
          else if (!modalOpen && active) pages.api(active)?.selectAll?.()
        } else if (command === 'undo' || command === 'redo') {
          const el = doc.activeElement
          if (editing.handleHistory(el, command)) return
          if (textField(el)) {
            doc.execCommand(command)
            return
          }
          if (modalOpen) return
          const done = command === 'undo' ? core.undo() : core.redo()
          void done.then((label) =>
            showToast(label ? uiText("已{value1}：{label}", { value1: String(command === 'undo' ? uiText("撤销") : uiText("重做")), label }) : command === 'undo' ? uiText("没有可以撤销的操作") : uiText("没有可以重做的操作"))
          )
        } else if (command === 'trash') {
          // 输入框里：删掉光标前的这一行。否则当前标签页的焦点：在回收站里的彻底删除（先确认），其余移到回收站
          const el = doc.activeElement
          if (textField(el)) {
            if (window.bridge.platform === 'darwin') deleteLineBefore(el)
            else doc.execCommand('forwardDelete')
            return
          }
          if (asElement(el)?.closest('input, textarea, select')) return
          if (modalOpen) return
          const ids = active ? pages.focus(active) : []
          if (!ids.length) return showToast(uiText("没有选中的素材"))
          void core.get(ids).then((views) => {
            const live = views.filter((v) => !v.deletedAt).map((v) => v.id)
            if (live.length) host.trash(live)
            else host.purge(views.map((v) => v.id))
          })
        } else if (command === 'new') {
          void createNew()
        } else if (command === 'export') {
          // 导出当前标签页的：选中的，没选就是整个视图
          const what = active ? pages.api(active)?.exportable?.() : undefined
          if (what?.ids.length) exportItems(what.ids, what.name)
          else showToast(uiText("这个标签页里没有可以导出的素材"))
        } else if (command === 'find') {
          // 当前标签页能搜就在它里面搜；不能（播放器、文字标签页）就开一个"全部"来搜
          const api = active ? pages.api(active) : undefined
          if (api?.find) api.find()
          else openTab(collectionTab({ ...ALL_VIEW, find: true }))
        } else if (command === 'import' && active) {
          try {
            const target = captureTarget({ type: 'page', id: active })
            void window.bridge.pickImport().then(paths => {
              if (paths.length) return receive(active, { paths }, undefined, target)
            }).catch(e => showToast(String(e)))
          } catch (e) { showToast(e instanceof Error ? e.message : String(e)) }
        }
      }),
    [openTab, closeTab, cycle, preview, modalOpen, openCommandPalette, commandPaletteOpen, closePreview, closeCommandPalette, exportItems, receive, captureTarget, core, showToast, createNew, host, togglePanel, pages, transitions, editing]
  )
}
