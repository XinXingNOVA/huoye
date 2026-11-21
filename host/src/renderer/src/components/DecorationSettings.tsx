import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useRef, useState } from 'react'
import { Button, Select, Switch } from '../../../plugin-api/ui/kit'
import { useEntity } from '../../../plugin-api/ui/data'
import type { ThemeAction } from '../../../shared/appearance'
import { decorationControls, stickerCorner, wallpaperAnchor, type DecorationControl, type DecorationSlot, type LocalDecoration } from '../../../shared/theme-decoration'
import type { ThemePreset } from '../../../shared/theme-presets'
import { decorationPlacement, decorationValue, previewDecorationControl, setDecorationImage } from '../theme'
import { SettingGroup, SettingRow } from './ui-primitives'

const anchorLabels = { get 'top-left'() { return uiText("左上") }, get top() { return uiText("上方") }, get 'top-right'() { return uiText("右上") }, get left() { return uiText("左侧") }, get center() { return uiText("居中") },
  get right() { return uiText("右侧") }, get 'bottom-left'() { return uiText("左下") }, get bottom() { return uiText("下方") }, get 'bottom-right'() { return uiText("右下") } } as const

function Adjustment({ name, value, save }: { name: DecorationControl; value: number; save(value: number): Promise<void> }) {
  const { label, min, max, unit } = decorationControls[name]
  const [draft, setDraft] = useState<number>()
  const pending = useRef<number>(undefined)
  const saving = useRef<Promise<void>>(undefined)
  useEffect(() => () => {
    pending.current = undefined
    saving.current = undefined
    previewDecorationControl(name)
  }, [name])
  const clear = () => {
    pending.current = undefined
    setDraft(undefined)
    previewDecorationControl(name)
  }
  const preview = (next: number) => {
    pending.current = next
    setDraft(next)
    previewDecorationControl(name, next)
  }
  const finish = async () => {
    const next = pending.current
    if (next === undefined) return
    pending.current = undefined
    if (next === value && !saving.current) { clear(); return }
    const write = save(next)
    saving.current = write
    try { await write }
    finally {
      if (saving.current === write) {
        saving.current = undefined
        if (pending.current === undefined) clear()
      }
    }
  }
  return <label className="decoration-adjustment">
    <span>{label}</span>
    <input type="range" aria-label={label} aria-valuetext={String(draft ?? value) + unit} min={min} max={max} value={draft ?? value}
      onChange={e => preview(e.currentTarget.valueAsNumber)}
      onPointerUp={finish} onKeyUp={finish} onBlur={finish}
      onPointerCancel={clear} />
    <output>{draft ?? value}{unit}</output>
  </label>
}

export function DecorationSettings({ preset, local, update, run }: {
  preset?: ThemePreset; local?: LocalDecoration; update(action: ThemeAction): Promise<void>; run(action: () => Promise<void>): Promise<void>
}) {
  useUiLocale()
  const picker = useRef<HTMLInputElement>(null)
  const slot = useRef<DecorationSlot>('wallpaper')
  const [busy, setBusy] = useState(false)
  const source = local?.wallpaper
  const entityId = source && 'entityId' in source ? source.entityId : undefined
  const material = useEntity(entityId)
  const status = (key: DecorationSlot) => {
    const override = local?.[key]
    if (key === 'wallpaper' && entityId) return material && !material.deletedAt ? String(material.blocks.file?.data.name ?? uiText("本库素材")) : uiText("本库素材暂不可用")
    if (override) return uiText("本机图片")
    if (override === null) return uiText("已隐藏")
    return preset?.decoration?.[key] ? uiText("随主题") : uiText("未设置")
  }
  const active = (key: DecorationSlot) => local?.[key] !== undefined ? !!local[key] : !!preset?.decoration?.[key]
  const adjustment = (name: DecorationControl) => <Adjustment key={name} name={name} value={decorationValue(name, preset, local)}
    save={value => update({ action: 'decorationControl', key: name, value })} />
  const fit = decorationPlacement('wallpaperFit', preset, local)
  return <SettingGroup title={uiText("工作台装饰")}>
    <input ref={picker} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={uiText("选择工作台装饰图片")} onChange={e => {
      const file = e.currentTarget.files?.[0], target = slot.current
      e.currentTarget.value = ''
      if (!file) return
      setBusy(true)
      void run(() => setDecorationImage(target, file)).finally(() => setBusy(false))
    }} />
    {(['wallpaper', 'sticker'] as const).map(key => {
      const label = key === 'wallpaper' ? uiText("壁纸") : uiText("角落贴纸")
      return <SettingRow key={key} title={label} description={status(key)}>
        <Button size="sm" disabled={busy} aria-label={uiText("选择") + label} onClick={() => { slot.current = key; picker.current?.click() }}>{uiText("选择图片…")}</Button>
        {active(key) && <Button size="sm" variant="ghost" aria-label={uiText("隐藏") + label} onClick={() => update({ action: 'hideDecoration', slot: key })}>{uiText("隐藏")}</Button>}
      </SettingRow>
    })}
    <p className="muted decoration-hint">{uiText("也可以右键库内图片，选择「设为本库壁纸」。")}</p>
    <details className="theme-advanced decoration-adjustments">
      <summary>{uiText("调整壁纸、贴纸与表面")}</summary>
      {active('wallpaper') && <>
        <SettingRow title={uiText("壁纸铺设")}><Select aria-label={uiText("壁纸铺设")} value={fit}
          onChange={e => update({ action: 'decorationPlacement', value: { wallpaperFit: e.currentTarget.value === 'tile' ? 'tile' : 'cover' } })}>
          <option value="cover">{uiText("铺满")}</option><option value="tile">{uiText("平铺纹理")}</option>
        </Select></SettingRow>
        <SettingRow title={uiText("壁纸锚点")}><Select aria-label={uiText("壁纸锚点")} value={decorationPlacement('wallpaperAnchor', preset, local)}
          onChange={e => update({ action: 'decorationPlacement', value: { wallpaperAnchor: wallpaperAnchor.parse(e.currentTarget.value) } })}>
          {wallpaperAnchor.options.map(key => <option key={key} value={key}>{anchorLabels[key]}</option>)}
        </Select></SettingRow>
        {fit === 'tile' && adjustment('wallpaperTileSize')}
        {adjustment('wallpaperOpacity')}{adjustment('wallpaperBrightness')}{adjustment('wallpaperBlur')}
      </>}
      {active('sticker') && <>
        <SettingRow title={uiText("贴纸位置")}><Select aria-label={uiText("贴纸位置")} value={decorationPlacement('stickerAnchor', preset, local)}
          onChange={e => update({ action: 'decorationPlacement', value: { stickerAnchor: stickerCorner.parse(e.currentTarget.value) } })}>
          {stickerCorner.options.map(key => <option key={key} value={key}>{anchorLabels[key]}</option>)}
        </Select></SettingRow>
        {adjustment('stickerScale')}{adjustment('stickerOpacity')}
      </>}
      {adjustment('surfaceOpacity')}{adjustment('surfaceBlur')}
      <SettingRow title={uiText("素材卡片毛玻璃")} description={uiText("让卡片也使用上方的模糊强度。密集排列时会增加滚动绘制开销。")}>
        <Switch aria-label={uiText("素材卡片毛玻璃")} checked={local?.blurCards ?? preset?.decoration?.blurCards ?? false}
          onChange={event => update({ action: 'blurCards', enabled: event.currentTarget.checked })} />
      </SettingRow>
    </details>
    {local && <Button size="sm" variant="ghost" onClick={() => update({ action: 'resetDecoration' })}>{uiText("恢复主题装饰")}</Button>}
  </SettingGroup>
}
