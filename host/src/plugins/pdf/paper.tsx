import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useState } from 'react'
import type { UiHost } from '../../plugin-api/ui/contracts'
import { DropdownMenu, Icon, SegmentedControl } from '../../plugin-api/ui/kit'
import { usePluginState } from '../../plugin-api/ui/local-state'
import { SettingRow } from '../../plugin-api/ui/widgets'
import type { PdfState } from './reading'

type Paper = NonNullable<PdfState['paper']>
const labels = { get theme() { return uiText("跟随主题") }, get original() { return uiText("原色") }, get warm() { return uiText("暖纸护眼") }, get dark() { return uiText("暗色反色") } } satisfies Record<Paper, string>
const choices = Object.entries(labels).map(([value, label]) => ({ value: value as Paper, label }))
const nextPaper = { theme: 'warm', warm: 'dark', dark: 'original', original: 'theme' } as const
export const pdfAppearanceId = 'pdf.appearance'

export function usePdfDefaultPaper(host: UiHost) {
  const pref = usePluginState<Paper>(host, 'pdf', 'defaultPaper', 'theme')
  return { ...pref, value: Object.hasOwn(labels, pref.value) ? pref.value : 'theme' as const }
}

export function PdfPaperSettings({ host }: { host: UiHost }) {
  useUiLocale()
  const pref = usePdfDefaultPaper(host)
  return <SettingRow title={uiText("默认纸面")} description={uiText("应用于本库中跟随默认设置的 PDF。")}>
    <SegmentedControl label={uiText("PDF 默认纸面")} value={pref.value}
      options={choices.map(option => ({ ...option, disabled: !pref.ready || pref.busy }))}
      onChange={value => { if (value !== pref.value) void pref.set(value as Paper).catch(() => {}) }} />
    {pref.error && <p role="alert">{pref.error}</p>}
  </SettingRow>
}

export function PdfPaperControls({ host, paper, change }: { host: UiHost; paper: Paper; change(value: Paper): void }) {
  useUiLocale()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [error, setError] = useState('')
  const label = (mode: Paper) => mode === 'theme' ? uiText("跟随本库默认") : labels[mode]
  const openDefaults = async () => {
    try { await host.openSettings({ scope: 'library', section: pdfAppearanceId }) }
    catch (e) { setError(String(e)) }
  }
  return <>
    <button className="pdf-paper" aria-label={uiText("纸张模式：") + label(paper)} title={label(paper) + uiText(" · 切换到") + label(nextPaper[paper])}
      onClick={() => change(nextPaper[paper])}><span aria-hidden="true">◐</span></button>
    <button aria-label={uiText("纸面选项")} aria-haspopup="menu" aria-expanded={!!anchor} title={uiText("纸面选项")}
      onClick={e => { setError(''); setAnchor(e.currentTarget) }}><Icon name="down" size={12} /></button>
    {anchor && <DropdownMenu anchor={anchor} label={uiText("纸面选项")} onClose={() => setAnchor(null)}
      groups={[{ items: choices.map(({ value }) => ({ id: value, label: label(value), checked: value === paper })) },
        { items: [{ id: 'settings', label: uiText("设置本库默认纸面…") }] }]}
      onSelect={id => { if (id === 'settings') void openDefaults(); else change(id as Paper) }} />}
    {error && <span role="alert">{error}</span>}
  </>
}
