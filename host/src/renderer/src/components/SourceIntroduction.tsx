import { t, useLanguage } from '../language'
import { useEffect, useState } from 'react'
import type { SourceIntroduction as Introduction } from '../../../shared/library-creation'
import type { UiHost } from '../plugin'
import { Button, Dialog } from '../../../plugin-api/ui/kit'
import { DirectoryCollectionForm } from './DirectoryCollectionForm'

export function SourceIntroduction({ host }: { host: UiHost }) {
  useLanguage()
  const [source, setSource] = useState<Introduction | null>(null)
  const [busy, setBusy] = useState(false)
  const notify = host.notify
  useEffect(() => {
    let active = true
    void window.bridge.creation.introduction().then(v => {
      if (!active || !v) return
      setSource(v)
      return window.bridge.creation.dismissIntroduction(v.spaceId)
    }).catch(e => { if (active) notify(String(e)) })
    return () => { active = false }
  }, [notify])
  if (!source) return null
  const close = (browse = false) => {
    setSource(null)
    if (browse) host.openTab('file-spaces', { spaceId: source.spaceId })
  }
  return <Dialog title={t('collect.intro', { name: source.name })} busy={busy} onClose={() => void close()} footer={<>
    <Button disabled={busy} onClick={() => void close(true)}>{t('collect.browse')}</Button>
    <Button disabled={busy} onClick={() => void close()}>{t('collect.enter')}</Button>
  </>}>
    <DirectoryCollectionForm host={host} spaceId={source.spaceId} initialOpen standalone onBusy={setBusy}/>
  </Dialog>
}
