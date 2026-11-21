import { useState } from 'react'
import { SegmentedControl } from '../../../plugin-api/ui/kit'
import { setLanguage, t, useLanguage } from '../language'
import { SettingGroup, SettingRow } from './ui-primitives'

export function LanguageSettings() {
  const { preference } = useLanguage()
  const [error, setError] = useState('')
  return <SettingGroup title={t('common.language')}>
    <SettingRow title={t('settings.languageLabel')} description={t('settings.languageHint')}>
      <SegmentedControl label={t('common.language')} value={preference}
        options={[{ value: 'system', label: t('common.system') }, { value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }]}
        onChange={value => {
          if (value !== 'system' && value !== 'zh-CN' && value !== 'en') return
          setError('')
          void setLanguage(value).catch(e => setError(String(e)))
        }} />
    </SettingRow>
    {error && <p className="package-error" role="alert">{error}</p>}
  </SettingGroup>
}
