import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { builtinDefaults, legacyAppKey, legacyLibraryKey, legacyThemeKey, preferencesSchema, type AppearanceSnapshot, type ThemeAction, type ThemePreferences } from '../shared/appearance'
import { themeManifestSchema, resolvePackage } from '../shared/theme-package'
import { THEME_PRESETS } from '../shared/builtin-themes'
import type { ThemePreset } from '../shared/theme-presets'
import { decodeTheme, themeDigest } from '../plugin-packages/theme-archive'
import { themeIconsSchema } from '../shared/theme-icons'
import { rasterFormat } from '../plugin-packages/theme-images'
import { localDecorationSchema, managedImageName, maxPersonalImageBytes, type DecorationSlot, type LocalDecoration } from '../shared/theme-decoration'

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const packSchema = z.object({ id: z.string().regex(/^external:[a-z][a-z0-9-]{0,63}(@[0-9a-f]{64})?$/), manifest: themeManifestSchema,
  icons: themeIconsSchema.optional(),
  variantIcons: z.object({ light: themeIconsSchema, dark: themeIconsSchema }).optional(),
  images: z.record(z.string().regex(/^images\/[a-z0-9][a-z0-9_-]{0,63}\.(?:png|webp)$/), z.string().regex(/^[0-9a-f]{64}\.(?:png|webp)$/)) })
const catalogSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), migrated: z.array(z.string()), installed: z.array(packSchema),
  application: preferencesSchema.optional(), libraries: z.record(z.string().uuid(), z.object({
    prefs: preferencesSchema.optional(), decoration: localDecorationSchema.optional(), creation: z.string().uuid().optional(), warning: z.string().optional()
  })) }).strict()
type Catalog = z.infer<typeof catalogSchema>

function personalImages(decoration?: LocalDecoration) {
  return [decoration?.wallpaper, decoration?.sticker].flatMap(source => source && 'file' in source ? [source.file] : [])
}

function writeAtomic(path: string, data: string | Buffer) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temp, data, { flag: 'wx', mode: 0o600 }); renameSync(temp, path) }
  finally { rmSync(temp, { force: true }) }
}

function installedPreset(pack: Catalog['installed'][number]): ThemePreset {
  const preset = resolvePackage(pack.manifest, pack.id)
  preset.icons = pack.icons
  if (preset.variants && pack.variantIcons) {
    preset.variants.light.icons = pack.variantIcons.light
    preset.variants.dark.icons = pack.variantIcons.dark
  }
  const [, revision] = pack.id.split('@')
  if (revision) preset.description = [preset.description, '套件版本 ' + revision.slice(0, 8)].filter(Boolean).join(' · ')
  if (Object.keys(pack.images).length) preset.images = Object.fromEntries(Object.entries(pack.images).map(([name, file]) => [name, 'huoye-theme://assets/' + file]))
  return preset
}

/** 单一主进程串行提交目录与偏好；图片先按摘要落盘，目录原子替换后才释放旧图。 */
export class ThemeStore {
  private revision = 0
  private state: Catalog
  private readonly defaults: ThemePreferences
  private file: string
  private images: string
  constructor(root: string, private changed: () => void = () => {}, priorProfile = false) {
    this.images = join(root, 'images')
    this.file = join(root, 'catalog.json')
    const hadImageDirectory = existsSync(this.images)
    mkdirSync(this.images, { recursive: true })
    if (existsSync(this.file)) {
      const bytes = readFileSync(this.file)
      if (bytes.length > 16 * 1024 * 1024) throw new Error('本机主题目录过大')
      this.state = catalogSchema.parse(JSON.parse(bytes.toString('utf8')))
    } else {
      // 首发版只用 localStorage。过渡开发版还会创建 images。
      this.state = { version: priorProfile || hadImageDirectory ? 1 : 2, installed: [], libraries: {}, migrated: [] }
      writeAtomic(this.file, JSON.stringify(this.state))
    }
    // 初始外观与显式 application 偏好分开，旧 localStorage 偏好仍能优先迁入。
    this.defaults = this.state.version === 1 ? { ...builtinDefaults, presetId: 'obsidian' } : builtinDefaults
    this.collectImages()
  }
  private select(current: ThemePreferences, preset: ThemePreset): ThemePreferences {
    const base: ThemePreferences = current.presetId.startsWith('external:') ? current.previousBuiltin ?? this.defaults : current
    const external = preset.id.startsWith('external:')
    return { presetId: preset.id, density: preset.appearance?.density ?? base.density,
      radius: preset.appearance?.radius ?? base.radius, accent: external ? undefined : base.accent,
      previousBuiltin: external ? base : undefined }
  }
  private collectImages() {
    const refs = new Set(this.state.installed.flatMap(pack => Object.values(pack.images)))
    for (const entry of Object.values(this.state.libraries)) {
      for (const file of personalImages(entry.decoration)) refs.add(file)
    }
    for (const file of readdirSync(this.images)) {
      if (/^[0-9a-f]{64}\.(png|webp)$/.test(file) && !refs.has(file)) rmSync(join(this.images, file), { force: true })
    }
  }
  private commit(next: Catalog) {
    const data = JSON.stringify(next)
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error('本机主题目录已满')
    writeAtomic(this.file, data)
    this.state = next
    this.revision++
    this.changed()
  }
  private find(id: string, state = this.state) {
    const pack = state.installed.find(p => p.id === id)
    return pack ? installedPreset(pack) : THEME_PRESETS.find(p => p.id === id)
  }
  snapshot(libraryId?: string): Omit<AppearanceSnapshot, 'systemScheme'> {
    const local = libraryId ? this.state.libraries[libraryId] : undefined
    return { revision: this.revision, application: this.state.application ?? this.defaults, library: local?.prefs, decoration: local?.decoration, warning: local?.warning,
      installed: this.state.installed.map(installedPreset).sort((a,b) => a.name.localeCompare(b.name)) }
  }
  private addPack(next: Catalog, pack: ReturnType<typeof decodeTheme>, suiteHash?: string) {
    const id = 'external:' + pack.manifest.id + (suiteHash ? '@' + suiteHash : '')
    const images: Record<string, string> = {}
    for (const [name, data] of pack.images) {
      const file = themeDigest(data) + (name.endsWith('.png') ? '.png' : '.webp')
      images[name] = file
      if (!existsSync(join(this.images, file))) writeAtomic(join(this.images, file), data)
    }
    next.installed = [...next.installed.filter(p => p.id !== id), { id, manifest: pack.manifest, images, variantIcons: pack.variantIcons, icons: Object.keys(pack.icons).length ? pack.icons : undefined }]
  }
  install(bytes: Uint8Array, suiteHash?: string) {
    if (suiteHash && (hash.parse(suiteHash) !== themeDigest(bytes))) throw new Error('套件主题摘要不符')
    if (suiteHash && this.state.installed.some(p => p.id.endsWith('@' + suiteHash))) return
    const next = structuredClone(this.state)
    try { this.addPack(next, decodeTheme(bytes), suiteHash); this.commit(next) } finally { this.collectImages() }
  }
  remove(id: string) {
    const next = structuredClone(this.state)
    next.installed = next.installed.filter(p => p.id !== id)
    if (next.installed.length === this.state.installed.length) return
    if (next.application?.presetId === id) next.application = next.application.previousBuiltin ?? this.defaults
    for (const entry of Object.values(next.libraries)) if (entry.prefs?.presetId === id) entry.prefs = entry.prefs.previousBuiltin ?? this.defaults
    this.commit(next); this.collectImages()
  }
  async setDecorationImage(libraryId: string, slot: DecorationSlot, bytes: Uint8Array) {
    z.string().uuid().parse(libraryId)
    if (!bytes.byteLength || bytes.byteLength > maxPersonalImageBytes) throw new Error('请选择 20 MiB 以内的 PNG、JPEG 或 WebP 图片')
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (!rasterFormat(data)) throw new Error('仅支持 PNG、JPEG 或 WebP 图片')
    const original = JSON.stringify(this.state.libraries[libraryId])
    const { default: sharp } = await import('sharp')
    const pipeline = sharp(data, { limitInputPixels: 48_000_000, animated: false })
    const side = slot === 'wallpaper' ? 2560 : 768
    const image = await pipeline.rotate().resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true }).webp({ quality: 86 }).toBuffer()
    if (JSON.stringify(this.state.libraries[libraryId]) !== original) throw new Error('本库外观已变化，请重新选择图片')
    const file = themeDigest(image) + '.webp'
    const next = structuredClone(this.state)
    const entry = next.libraries[libraryId] ??= {}
    entry.prefs ??= next.application ?? this.defaults
    entry.decoration = { ...entry.decoration, [slot]: { file } }
    delete entry.warning
    try {
      if (!existsSync(join(this.images, file))) writeAtomic(join(this.images, file), image)
      this.commit(next)
    } finally { this.collectImages() }
  }
  image(file: string, libraryId?: string) {
    if (!managedImageName.test(file)) return
    const allowed = libraryId ? personalImages(this.state.libraries[libraryId]?.decoration).includes(file)
      : this.state.installed.some(p => Object.values(p.images).includes(file))
    if (!allowed) return
    const path = join(this.images, file)
    return existsSync(path) ? readFileSync(path) : undefined
  }
  change(libraryId: string | undefined, action: ThemeAction) {
    const next = structuredClone(this.state)
    const entry = libraryId ? (next.libraries[z.string().uuid().parse(libraryId)] ??= {}) : undefined
    const currentDecoration = entry?.decoration
    const current: ThemePreferences = entry?.prefs ?? next.application ?? this.defaults
    let prefs: ThemePreferences | undefined = { ...current }
    switch (action.action) {
      case 'materialWallpaper':
      case 'blurCards':
      case 'decorationPlacement':
      case 'decorationControl':
      case 'hideDecoration':
      case 'resetDecoration': {
        if (!entry) throw new Error('请选择当前仓库')
        if (action.action === 'resetDecoration') delete entry.decoration
        else {
          const decoration = { ...entry.decoration }
          if (action.action === 'materialWallpaper') decoration.wallpaper = { entityId: action.entityId }
          if (action.action === 'hideDecoration') decoration[action.slot] = null
          if (action.action === 'blurCards') decoration.blurCards = action.enabled
          if (action.action === 'decorationPlacement') Object.assign(decoration, action.value)
          if (action.action === 'decorationControl') decoration[action.key] = action.value
          entry.decoration = localDecorationSchema.parse(decoration)
        }
        break
      }
      case 'select': {
        const preset = this.find(action.id)
        if (!preset) throw new Error('此主题已移除，请重新安装')
        prefs = this.select(current, preset)
        if (current.presetId === preset.id && preset.variants) prefs.colorMode = current.colorMode
        break
      }
      case 'colorMode':
        if (!this.find(current.presetId)?.variants) throw new Error('当前主题没有昼夜版本')
        prefs.colorMode = action.value; break
      case 'restore': prefs = current.previousBuiltin ?? current; break
      case 'follow': if (!entry) throw new Error('请选择当前仓库'); prefs = undefined; delete entry.decoration; break
      case 'independent': if (!entry) throw new Error('请选择当前仓库'); break
      case 'resetColors': delete prefs.accent; delete prefs.customTokens; break
      case 'accent': prefs.accent = action.value; break
      case 'density': prefs.density = action.value; break
      case 'radius': prefs.radius = action.value; break
      case 'color': prefs.customTokens = { ...prefs.customTokens, [action.key]: action.value }; break
    }
    if (entry) { entry.prefs = prefs; delete entry.warning }
    else next.application = prefs
    this.commit(next)
    const keep = personalImages(entry?.decoration)
    if (personalImages(currentDecoration).some(file => !keep.includes(file))) this.collectImages()
  }
  recommend(libraryId: string, creation: string, id: string) {
    if (this.state.libraries[libraryId]) return
    const next = structuredClone(this.state), preset = this.find(id)
    z.string().uuid().parse(creation)
    next.libraries[z.string().uuid().parse(libraryId)] = preset ? { creation, prefs: this.select(next.application ?? this.defaults, preset) }
      : { creation, warning: '建库方案推荐的主题暂不可用，已跟随应用默认外观。' }
    this.commit(next)
  }
  migrate(origin: string, values: Record<string, string>) {
    const next = this.state.migrated.includes(origin) ? undefined : structuredClone(this.state)
    const migratedKeys: string[] = []
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith(legacyThemeKey)) continue
      let pack: ReturnType<typeof decodeTheme>
      try { pack = decodeTheme(Buffer.from(value)) } catch { continue }
      if (key !== legacyThemeKey + pack.manifest.id) continue
      if (next && !this.find('external:' + pack.manifest.id, next)) this.addPack(next, pack)
      migratedKeys.push(key)
    }
    for (const [key, value] of Object.entries(values)) {
      if (key !== legacyAppKey && !key.startsWith(legacyLibraryKey)) continue
      const library = key.startsWith(legacyLibraryKey) ? z.string().uuid().safeParse(key.slice(legacyLibraryKey.length)) : undefined
      if (library && !library.success) continue
      let prefs: ThemePreferences
      try { prefs = preferencesSchema.parse(JSON.parse(value)) } catch { continue }
      if (next) {
        if (!this.find(prefs.presetId, next)) prefs = prefs.previousBuiltin ?? this.defaults
        if (library?.success) next.libraries[library.data] ??= { prefs }
        else next.application ??= prefs
      }
      migratedKeys.push(key)
    }
    if (next && migratedKeys.length) {
      next.migrated.push(origin)
      this.commit(next)
    }
    return migratedKeys
  }
}
