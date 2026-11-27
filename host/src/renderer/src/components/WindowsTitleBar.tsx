import { useState } from 'react'
import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'

export function WindowsTitleBar({ title }: { title: string }) {
  useUiLocale()
  const [menuOpen, setMenuOpen] = useState(false)
  const label = uiText("应用菜单")
  return <header className="windows-title-bar">
    <button className="windows-menu-button" type="button" title={label} aria-label={label}
      aria-haspopup="menu" aria-expanded={menuOpen} onClick={async e => {
        if (menuOpen) return
        const { left, bottom } = e.currentTarget.getBoundingClientRect()
        setMenuOpen(true)
        try { await window.bridge.windowChrome.menu(left, bottom) }
        finally { setMenuOpen(false) }
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h16"/>
      </svg>
    </button>
    <span className="windows-window-title">{title}</span>
  </header>
}
