import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import type { UiHost } from '../../plugin-api/ui/contracts'
import type { FileUpdatePreview } from '../../shared/file-updates'
import { directoryImage } from '../../shared/directory-spaces'
import { formatBytes } from '../../shared/format'

export function UpdateComparison({ preview, host }: { preview: FileUpdatePreview; host: UiHost }) {
  useUiLocale()
  return <div className="space-version-compare">{([[uiText("本仓库已采用"), preview.previous], [uiText("空间当前内容"), preview.current]] as const).map(([label, version]) =>
    <section key={label}>
      <h4>{label}{version.ordinal !== undefined && ` · V${version.ordinal}`}</h4>
      <p>{version.name} · {formatBytes(version.size)}{version.createdAt !== undefined && ` · ${new Date(version.createdAt).toLocaleString()}`}</p>
      <p className="muted space-hash" title={version.hash}>SHA-256 {version.hash.slice(0, 16)}…</p>
      {version.unavailable && <p className="package-error">{uiText("旧内容不可读取。")}{version.unavailable}</p>}
      {!version.unavailable && directoryImage(version.name) && <img src={host.url(version.reference)} alt={label + uiText("的图片预览")} />}
      {version.sample !== undefined && <pre>{version.sample}{version.size > 4096 ? uiText("\n…（前 4 KB）") : ''}</pre>}
    </section>)}</div>
}
