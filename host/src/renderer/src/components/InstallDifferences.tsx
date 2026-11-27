import { packageText } from '../../../shared/package-locales'
import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import type { PackageInstallItem, PackageRow } from '../../../shared/external-plugins'

export const installStatus = { get ready() { return uiText("待安装") }, get existing() { return uiText("已存在") }, get duplicate() { return uiText("重复包，跳过") }, get invalid() { return uiText("无法安装") }, get installed() { return uiText("安装成功") }, get failed() { return uiText("安装失败") }, get reused() { return uiText("复用已安装") }, get skipped() { return uiText("暂不安装") } } as const

export function InstallDifferences({ items, baseline, choices, busy, title, onChoice }: {
  items: PackageInstallItem[]
  baseline: Map<string, PackageRow[]>
  choices: Record<number, string | null>
  busy: boolean
  title(id: string): string
  onChoice(index: number, hash: string | null): void
}) {
  const locale = useUiLocale()
  const sections = [
    ['issue', uiText("需要处理")], ['version', uiText("版本变化")],
    ['new', uiText("新增插件")], ['same', uiText("已有或复用")]
  ] as const
  function group(row: PackageInstallItem) {
    if (row.error || row.status === 'invalid' || row.status === 'failed') return 'issue'
    if (['duplicate', 'existing', 'reused', 'skipped'].includes(row.status)) return 'same'
    return row.manifest && baseline.has(row.manifest.id) ? 'version' : 'new'
  }
  return <>{sections.map(([key, heading]) => {
    const members = items.filter(row => group(row) === key)
    if (!members.length) return null
    return <details className="package-install-group" key={key} open={key !== 'same'} data-install-group={key}>
      <summary>{heading} · {members.length}</summary>
      {members.map(row => {
        const m = row.manifest, previous = m && baseline.get(m.id)?.[0]
        const choice = choices[row.index] === null ? 'skip' : choices[row.index] ?? row.reuseHash ?? row.hash
        const alt = row.alternatives?.find(a => a.hash === choice && choice !== row.hash)
        const sameVersion = key === 'version' && previous?.manifest.version === m?.version
        return <article className="package-install-row" key={row.index} data-install-index={row.index} data-install-status={row.status}>
          <div className="package-install-name">
            <strong>{m ? packageText(m.locales, locale, m.title) : row.file}</strong>
            {m && <span className="muted">{previous && key === 'version' && !alt && !sameVersion && previous.manifest.version + ' → '}{m.version}{sameVersion && ' · ' + row.hash?.slice(0, 8)}</span>}
            <span className={'package-install-status ' + row.status}>{installStatus[row.status]}</span>
          </div>
          {m && <details className="package-install-meta"><summary>{uiText("详情")}</summary>
            <div className="muted package-install-file">{row.file} · {m.id} · {m.author}</div>
            {m.description && <p>{packageText(m.locales, locale, m.description)}</p>}
            {m.capabilities?.runtimes?.map(r => <p key={r.program}>{uiText('随包程序')} · <code>{r.program}</code> · {r.targets.join(' · ')}</p>)}
            {!!m.requires.length && <p>{uiText("启用时需要：")}{m.requires.map(title).join('、')}</p>}
          </details>}
          {row.alternatives && !['installed', 'existing', 'duplicate'].includes(row.status) &&
            <label>{uiText("准备方式")}{' '}
              <select aria-label={uiText("{id}安装方式", { id: m?.id ?? '' })} disabled={busy} value={choice}
                onChange={e => onChoice(row.index, e.target.value === 'skip' ? null : e.target.value)}>
                <option value={row.hash}>{uiText("安装附带推荐版")} {m?.version}</option>
                {row.alternatives.filter(a => a.hash !== row.hash).map(a => <option key={a.hash} value={a.hash}>{uiText("使用已安装")} {a.version}</option>)}
                <option value="skip">{uiText("暂不安装，先登记方案")}</option>
              </select>
            </label>}
          {row.status === 'reused' && alt && <small>{uiText("使用已安装")} {alt.version}</small>}
          {row.error && <p className="package-error">{row.error}</p>}
        </article>
      })}
    </details>
  })}</>
}
