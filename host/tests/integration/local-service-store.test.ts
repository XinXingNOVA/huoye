import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { pluginLocalStore, type SecretProtection } from '../../src/main/plugin-local-store'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'rm-local-store-')); dirs.push(dir); return dir }
const key = randomBytes(32)
const protection: SecretProtection = {
  available: () => true,
  encrypt(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
  decrypt(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() }
}
it('本机共享配置跨库复用，库配置按路径、插件隔离，重新创建实例保留配置与加密凭据', () => {
  const dir = directory(), make = (plugin = 'a', root = '/one') => pluginLocalStore({ directory: dir, plugin, root, active: () => true, protection })
  const a = make(), b = make('a', '/two'), other = make('b')
  a.settings.set('application', 'endpoint', { url: 'https://example.invalid', models: ['a'] })
  a.settings.set('library', 'mode', 'first'); b.settings.set('library', 'mode', 'second')
  expect(b.settings.get('application', 'endpoint')).toEqual(a.settings.get('application', 'endpoint'))
  expect(other.settings.get('application', 'endpoint')).toBeUndefined()
  expect(a.settings.get('library', 'mode')).toBe('first')
  a.secrets.set('application', 'key', 'private-test-value')
  expect(make().secrets.get('application', 'key')).toBe('private-test-value')
  expect(b.secrets.get('application', 'key')).toBe('private-test-value')
  expect(other.secrets.has('application', 'key')).toBe(false)
  expect(readFileSync(join(dir, 'a', 'application.secrets.json'), 'utf8')).not.toContain('private-test-value')
  b.settings.set('application', 'other', true)
  expect(make().settings.get('application', 'endpoint')).toEqual({ url: 'https://example.invalid', models: ['a'] })
  a.secrets.remove('application', 'key'); expect(b.secrets.has('application', 'key')).toBe(false)
})
it('系统保护不可用时拒绝落盘，损坏配置不覆盖，停用后的旧接口失效', () => {
  const dir = directory(); let active = true
  const store = pluginLocalStore({ directory: dir, plugin: 'a', root: '/one', active: () => active, protection: { ...protection, available: () => false } })
  expect(store.secrets.available()).toBe(false)
  expect(() => store.secrets.set('application', 'key', 'plain')).toThrow('SECRET_STORAGE_UNAVAILABLE')
  expect(readdirSync(dir)).toEqual([])
  store.settings.set('application', 'key', 1)
  const file = join(dir, 'a', 'application.json'); writeFileSync(file, '{broken')
  expect(() => store.settings.set('application', 'key', 2)).toThrow('LOCAL_CONFIG_INVALID')
  expect(readFileSync(file, 'utf8')).toBe('{broken')
  active = false
  expect(() => store.settings.get('application', 'key')).toThrow('SERVICE_UNAVAILABLE')
  expect(() => store.secrets.remove('application', 'key')).toThrow('SERVICE_UNAVAILABLE')
})
it('拒绝非法键、非 JSON、过大内容；解密失败不丢弃原凭据', () => {
  const dir = directory(), base = { directory: dir, plugin: 'a', root: '/one', active: () => true }
  const store = pluginLocalStore({ ...base, protection })
  expect(() => store.settings.set('application', '../key', true)).toThrow()
  expect(() => store.settings.set('application', '__proto__', true)).toThrow()
  expect(() => store.settings.set('application', 'key', new Date() as any)).toThrow('JSON')
  expect(() => store.settings.set('application', 'key', NaN)).toThrow('JSON')
  expect(() => store.settings.set('application', 'key', 'x'.repeat(300000))).toThrow('过大')
  store.secrets.set('application', 'key', 'keep')
  const broken = pluginLocalStore({ ...base, protection: { ...protection, decrypt() { throw new Error('decrypt failed with sensitive contents') } } })
  expect(() => broken.secrets.get('application', 'key')).toThrow('SECRET_DECRYPT_FAILED')
  expect(store.secrets.get('application', 'key')).toBe('keep')
})
