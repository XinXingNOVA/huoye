import { gunzipSync, gzipSync } from 'node:zlib'
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { decodePackage, digest } from './archive'
import { decodeTheme } from './theme-archive'
import { MAX_THEME_BYTES } from '../shared/theme-package'
import { suiteManifestSchema, suitePresetId, suiteThemeId, type SuiteManifest, type SuiteRegistration } from '../shared/plugin-suites'
import type { PluginPreset } from '../shared/plugin-presets'
export const MAX_SUITE_BYTES = 128 * 1024 * 1024
const magic = Buffer.from('RMSUITE1\n')
export const isSuite = (bytes: Buffer) => bytes.subarray(0, magic.length).equals(magic)
export interface SuiteArchive extends SuiteRegistration { packages: Map<string, Buffer>; themes: Map<string, Buffer> }
const member = z.object({ file: z.string(), content: z.string() }).strict()
const suiteEnvelope = z.object({
  manifest: suiteManifestSchema,
  packages: z.array(member).max(50),
  themes: z.array(member.extend({ content: z.string().max(Math.ceil(MAX_THEME_BYTES / 3) * 4) })).max(8).optional()
}).strict()

export function decodeSuite(bytes: Buffer): SuiteArchive {
  if (!isSuite(bytes) || bytes.length > MAX_SUITE_BYTES) throw new Error('不支持的套件格式或超过 128 MB')
  const json = gunzipSync(bytes.subarray(magic.length), { maxOutputLength: 192 * 1024 * 1024 })
  const raw = suiteEnvelope.parse(JSON.parse(json.toString('utf8')))
  if (raw.packages.length !== raw.manifest.packages.length) throw new Error('套件包清单不完整')
  const packages = new Map<string, Buffer>(); let total = 0
  for (const item of raw.packages) {
    const ref = raw.manifest.packages.find(p => p.file === item.file), data = Buffer.from(item.content, 'base64')
    if (!ref || packages.has(item.file) || data.toString('base64') !== item.content || digest(data) !== ref.hash) throw new Error('套件内插件重复、越界或摘要不符')
    total += data.length; if (total > MAX_SUITE_BYTES) throw new Error('套件包含的插件超过 128 MB')
    const pack = decodePackage(data)
    if (pack.manifest.id !== ref.id || pack.manifest.version !== ref.version) throw new Error('套件包身份与清单不符')
    packages.set(item.file, data)
  }
  const themes = new Map<string, Buffer>()
  for (const item of raw.themes ?? []) {
    const ref = raw.manifest.themes?.find(t => t.file === item.file)
    const data = Buffer.from(item.content, 'base64')
    if (!ref || themes.has(item.file) || digest(data) !== ref.hash || data.toString('base64') !== item.content || decodeTheme(data).manifest.id !== ref.id) throw new Error('套件主题重复、身份或摘要不符')
    total += data.length
    if (total > MAX_SUITE_BYTES) throw new Error('套件资源超过 128 MiB')
    themes.set(item.file, data)
  }
  if (themes.size !== (raw.manifest.themes?.length ?? 0)) throw new Error('套件主题清单不完整')
  return { manifest: raw.manifest, hash: digest(bytes), packages, themes }
}
export function encodeSuite(manifest: SuiteManifest, packages: Map<string, Buffer>, themes = new Map<string, Buffer>()): Buffer {
  const entries = (files: Map<string, Buffer>) => [...files].map(([file, data]) => ({ file, content: data.toString('base64') }))
  const envelope = { manifest, themes: themes.size ? entries(themes) : undefined, packages: entries(packages) }
  const bytes = Buffer.concat([magic, gzipSync(Buffer.from(JSON.stringify(envelope)), { level: 9 })])
  decodeSuite(bytes); return bytes
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const registration = z.object({ manifest: suiteManifestSchema, hash: hashSchema }).strict()
const registry = z.object({
  version: z.literal(1), suites: z.array(registration).max(100),
  bundled: z.array(z.object({ id: suiteManifestSchema.shape.id, hash: hashSchema }).strict()).max(100).default([])
}).strict()
type SuiteState = z.infer<typeof registry>

function compareVersions(a: string, b: string) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

/** 仅登记静态方案。插件安装、授权与仓库启用仍由各自服务管理。 */
export class SuiteCatalog {
  private release = new Set<string>()
  constructor(private file: string, private installTheme?: (bytes: Buffer, hash: string) => void) {}
  private importThemes(manifest: SuiteManifest, read: (file: string) => Buffer | undefined) {
    for (const ref of manifest.themes ?? []) {
      const data = read(ref.file)
      if (!data || !this.installTheme || digest(data) !== ref.hash || decodeTheme(data).manifest.id !== ref.id) throw new Error('套件主题无效：' + ref.file)
      this.installTheme(data, ref.hash)
    }
  }
  private read(): SuiteState {
    try {
      const data = readFileSync(this.file); if (data.length > 8 * 1024 * 1024) throw new Error('目录过大')
      const state = registry.parse(JSON.parse(data.toString('utf8')))
      if (new Set(state.suites.map(r => r.manifest.id)).size !== state.suites.length) throw new Error('重复套件')
      return state
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, suites: [], bundled: [] }; throw new Error('套件目录损坏，未重置或覆盖', { cause: e }) }
  }
  list(): SuiteRegistration[] {
    return this.read().suites.map(s => this.release.has(s.hash) ? { ...s, bundled: true } : s)
  }
  private write(state: SuiteState) {
    const data = JSON.stringify(registry.parse(state)); if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error('套件目录过大')
    mkdirSync(dirname(this.file), { recursive: true }); const tmp = this.file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' }); renameSync(tmp, this.file) } finally { rmSync(tmp, { force: true }) }
  }
  provisionBundled(raw: unknown) {
    const entries = z.array(registration.extend({ themeFiles: z.record(z.string(), z.string()).optional() })).max(100).parse(raw)
    const state = this.read()
    let changed = false
    for (const entry of entries) {
      const { id, version } = entry.manifest
      const seen = state.bundled.find(p => p.id === id)
      if (seen?.hash === entry.hash) continue
      const index = state.suites.findIndex(p => p.manifest.id === id)
      const current = state.suites[index]
      if ((!current && !seen) || (current && (!seen || current.hash === seen.hash) && compareVersions(version, current.manifest.version) > 0)) {
        this.importThemes(entry.manifest, file => entry.themeFiles?.[file] ? Buffer.from(entry.themeFiles[file], 'base64') : undefined)
        const registration = { manifest: entry.manifest, hash: entry.hash }
        if (current) state.suites[index] = registration; else state.suites.push(registration)
      }
      // 即使用户移除过套件，也记下本次发行摘要，避免重启或升级时重新添加。
      if (seen) seen.hash = entry.hash
      else state.bundled.push({ id, hash: entry.hash })
      changed = true
    }
    if (changed) this.write(state)
    this.release = new Set(entries.map(s => s.hash))
  }
  inspect(value: SuiteRegistration) {
    const old = this.read().suites.find(s => s.manifest.id === value.manifest.id)
    if (old?.manifest.version === value.manifest.version && old.hash !== value.hash) throw new Error('相同套件版本已登记不同内容，请提升版本')
    if (old && compareVersions(old.manifest.version, value.manifest.version) > 0) throw new Error('已有较新套件，不自动降级')
    return old?.hash === value.hash
  }
  install(value: SuiteRegistration & { themes?: Map<string, Buffer> }) {
    const existing = this.inspect(value)
    this.importThemes(value.manifest, file => value.themes?.get(file))
    if (existing) return
    const state = this.read()
    state.suites = [...state.suites.filter(s => s.manifest.id !== value.manifest.id), { manifest: value.manifest, hash: value.hash }]
    this.write(state)
  }
  remove(id: string, hash: string) {
    const state = this.read(), old = state.suites.find(s => s.manifest.id === id)
    if (!old || old.hash !== hash) throw new Error('套件已变化，请刷新后重试')
    state.suites = state.suites.filter(s => s !== old)
    this.write(state)
  }
  presets(): PluginPreset[] {
    return this.list().flatMap(({ manifest, hash, bundled }) => manifest.presets.map(preset => ({
      ...preset,
      recommendedTheme: suiteThemeId(manifest, preset.recommendedTheme),
      id: suitePresetId(manifest.id, preset.id), revision: hash, editable: false,
      source: { kind: 'suite', id: manifest.id, title: manifest.title, version: manifest.version, ...(manifest.locales && { locales: manifest.locales }), ...(bundled && { bundled }) }
    })))
  }
}
