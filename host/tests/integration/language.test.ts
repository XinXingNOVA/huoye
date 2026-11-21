import { interfaceEnglish } from '../../src/shared/i18n/interface-en'
import { packageLocalesSchema, packageText } from '../../src/shared/package-locales'
import { expect, it } from 'vitest'
import { preferredLanguage, translator, type MessageKey } from '../../src/shared/i18n'
import { chinese } from '../../src/shared/i18n/zh-CN'
import { english } from '../../src/shared/i18n/en'

it('keeps every message and its interpolation parameters available in both languages', () => {
  const slots = (value: string) => [...new Set([...value.matchAll(/{(\w+)}/g)].map(match => match[1]))].sort()
  for (const [source, translation] of Object.entries(interfaceEnglish)) {
    expect(translation.trim(), source).not.toBe('')
    expect(slots(translation), source).toEqual(slots(source))
  }
  expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort())
  for (const key of Object.keys(chinese) as MessageKey[]) {
    expect(english[key].trim(), key).not.toBe('')
    expect(slots(english[key]), key).toEqual(slots(chinese[key]))
  }
  expect(translator('en')('collect.intro', { name: '我的资料 {name}' })).toContain('我的资料 {name}')
})

it('uses only the package dictionary and substitutes values after choosing the translation', () => {
  const words = packageLocalesSchema.parse({ en: { '移入{name}': 'Move to {name}', '标签': 'Tags' } })
  expect(packageText(words, 'en', '移入{name}', { name: '标签 {name}' })).toBe('Move to 标签 {name}')
  expect(packageText(words, 'en', '未知')).toBe('未知')
  expect(packageText(undefined, 'en', '标签')).toBe('标签')
  expect(packageText(words, 'zh-CN', '标签')).toBe('标签')
  expect(packageText(words, 'en', '标签', undefined, 'value.tags.values.标签')).toBe('标签')
  expect(packageLocalesSchema.safeParse({ en: { '移入{name}': 'Move to {item}' } }).success).toBe(false)
})

it('uses the first supported system language and falls back to Simplified Chinese', () => {
  expect(preferredLanguage(['fr-CA', 'en-GB', 'zh-Hans'])).toBe('en')
  expect(preferredLanguage(['zh-Hant-TW', 'en-US'])).toBe('zh-CN')
  expect(preferredLanguage(['ja-JP'])).toBe('zh-CN')
  expect(preferredLanguage([])).toBe('zh-CN')
})
