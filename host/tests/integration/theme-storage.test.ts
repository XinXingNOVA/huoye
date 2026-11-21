import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { zipSync } from 'fflate'
import { ThemeStore } from '../../src/main/theme-store'
import { decodeTheme, themeDigest } from '../../src/plugin-packages/theme-archive'
import { SuiteCatalog, decodeSuite } from '../../src/plugin-packages/suites'
import { packSuite } from '../../scripts/plugins/suite-entry'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'huoye-themes-')); dirs.push(dir); return dir }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
const manifest = { formatVersion: 2, id: 'paper', name: '纸', base: 'warm-paper' }
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY4QAAAAASUVORK5CYII=', 'base64')
const packaged = (name: string) => Buffer.from(zipSync({ 'theme.json': Buffer.from(JSON.stringify({ ...manifest, name })), 'images/cover.png': image }))

it('打包和发行登记固定主题版本，更新与接续尊重手动跟随，最后一份引用移除才回收图片', () => {
  const dir = temp(), themes = new ThemeStore(join(dir, 'themes'))
  const catalog = new SuiteCatalog(join(dir, 'suites.json'), (bytes, hash) => themes.install(bytes, hash))
  function release(version: string, name: string) {
    const bytes = packaged(name)
    writeFileSync(join(dir, 'paper.hytheme'), bytes)
    writeFileSync(join(dir, 'suite.json'), JSON.stringify({ formatVersion: 1, id: 'book', title: '书房', description: '', version, packages: [],
      themes: ['paper.hytheme'], presets: [{ id: 'read', title: '阅读', plugins: [], recommendedTheme: 'external:paper' }] }))
    packSuite(join(dir, 'suite.json'), join(dir, 'book.hysuite'))
    const archive = decodeSuite(readFileSync(join(dir, 'book.hysuite')))
    catalog.provisionBundled([{ manifest: archive.manifest, hash: archive.hash, themeFiles: { 'paper.hytheme': bytes.toString('base64') } }])
    return catalog.presets()[0].recommendedTheme!
  }
  const a = randomUUID(), b = randomUUID(), job = randomUUID()
  const first = release('1.0.0', '纸一')
  themes.recommend(a, job, first)
  expect(themes.snapshot(a).library?.presetId).toBe(first)
  const second = release('1.1.0', '纸二')
  expect(first).not.toBe(second)
  themes.recommend(b, randomUUID(), second)
  themes.change(a, { action: 'follow' })
  themes.recommend(a, job, first)
  const reopened = new ThemeStore(join(dir, 'themes'))
  expect(reopened.snapshot(a).library).toBeUndefined()
  expect(reopened.snapshot(b).library?.presetId).toBe(second)
  const file = themeDigest(image) + '.png'
  reopened.remove(first)
  expect(reopened.image(file)).toEqual(image)
  reopened.remove(second)
  expect(reopened.snapshot(b).library?.presetId).toBe('huoye-standard')
  expect(reopened.image(file)).toBeUndefined()
  expect(readdirSync(join(dir, 'themes', 'images'))).toEqual([])
  const missing = randomUUID()
  reopened.recommend(missing, randomUUID(), first)
  expect(reopened.snapshot(missing).library).toBeUndefined()
  expect(reopened.snapshot(missing).warning).toContain('跟随应用')
  const repaired = new SuiteCatalog(join(dir, 'suites.json'), (bytes, hash) => reopened.install(bytes, hash))
  repaired.install(decodeSuite(readFileSync(join(dir, 'book.hysuite'))))
  expect(reopened.image(file)).toEqual(image)
  expect(reopened.snapshot(b).library?.presetId).toBe('huoye-standard')
})

it('已有单色主题保留；在固定深色的内置主题上试用外部包，重启后也能还原', () => {
  const root = temp(), library = randomUUID()
  let store = new ThemeStore(root)
  expect(new ThemeStore(root).snapshot().application.presetId).toBe('huoye-standard')
  expect(new ThemeStore(temp(), undefined, true).snapshot().application.presetId).toBe('obsidian')
  // 老版本从未改过外观时只有 images；另一种旧目录已有按库偏好但没有应用偏好。
  const untouched = temp(), existing = temp()
  mkdirSync(join(untouched, 'images'))
  expect(new ThemeStore(untouched).snapshot().application.presetId).toBe('obsidian')
  writeFileSync(join(existing, 'catalog.json'), JSON.stringify({ version: 1, installed: [], migrated: [],
    libraries: { [library]: { prefs: { presetId: 'celadon-study', density: 'compact', radius: 'soft' } } } }))
  const previous = new ThemeStore(existing).snapshot(library)
  expect([previous.application.presetId, previous.library?.presetId]).toEqual(['obsidian', 'celadon-study'])
  store.change(undefined, { action: 'select', id: 'obsidian' })
  store.change(library, { action: 'select', id: 'celadon-reading' })
  store.change(library, { action: 'colorMode', value: 'dark' })
  store.install(packaged('纸'))
  store.change(library, { action: 'select', id: 'external:paper' })
  store = new ThemeStore(root)
  store.remove('external:paper')
  expect(store.snapshot(library).library).toMatchObject({ presetId: 'celadon-reading', colorMode: 'dark' })
  expect(store.snapshot().application.presetId).toBe('obsidian')
})

it('拒绝未声明格式与超限图片，安装失败保留已有版本', () => {
  const themes = new ThemeStore(temp())
  themes.install(packaged('有效'))
  const file = Buffer.from(JSON.stringify(manifest))
  for (const [path, bytes] of [['outside.png', image], ['images/graphic.svg', Buffer.from('<svg/>')], ['images/photo.webp', image],
    ['images/cover.png', Buffer.alloc(4 * 1024 * 1024 + 1)]] as const) {
    expect(() => themes.install(zipSync({ 'theme.json': file, [path]: bytes }))).toThrow()
  }
  expect(() => decodeTheme(zipSync({ 'images/cover.png': image }))).toThrow('theme.json')
  expect(themes.snapshot().installed.map(t => t.name)).toEqual(['有效'])
})


it('本机装饰按库授权，跨库共享副本直到最后一次释放，重开仍能读图', async () => {
  const root = temp(), a = randomUUID(), b = randomUUID()
  const store = new ThemeStore(root)
  const picture = await sharp({ create: { width: 10, height: 9, channels: 4, background: '#608873' } }).png().toBuffer()
  await store.setDecorationImage(a, 'wallpaper', picture)
  const files = readdirSync(join(root, 'images'))
  expect(files).toHaveLength(1)
  const file = files[0]
  expect(store.image(file, b)).toBeUndefined()
  expect(store.image(file)).toBeUndefined()
  expect(await sharp(store.image(file, a)).metadata()).toMatchObject({ width: 10, height: 9, format: 'webp' })
  await store.setDecorationImage(a, 'sticker', picture)
  await store.setDecorationImage(b, 'sticker', picture)
  await expect(store.setDecorationImage(a, 'wallpaper', Buffer.from('文本'))).rejects.toThrow()
  const reopened = new ThemeStore(root)
  expect(reopened.snapshot(a).decoration).toEqual({ wallpaper: { file }, sticker: { file } })
  reopened.change(a, { action: 'materialWallpaper', entityId: '素材-1' })
  reopened.change(a, { action: 'hideDecoration', slot: 'sticker' })
  expect(reopened.image(file, a)).toBeUndefined()
  expect(reopened.image(file, b)).toBeDefined()
  reopened.change(b, { action: 'follow' })
  expect(readdirSync(join(root, 'images'))).toEqual([])
  expect(reopened.snapshot(a).decoration?.wallpaper).toEqual({ entityId: '素材-1' })
  expect(() => reopened.change(undefined, { action: 'materialWallpaper', entityId: '素材-1' })).toThrow('当前仓库')
})

it('装饰清单校验引用、参数和静态图片尺寸，更新失败时保留之前的主题', async () => {
  const themes = new ThemeStore(temp())
  const reference = 'images/wallpaper.webp'
  const base = { ...manifest, formatVersion: 3, decoration: { wallpaper: reference } }
  const bytes = (art: Buffer) => zipSync({ 'theme.json': Buffer.from(JSON.stringify(base)), [reference]: art })
  const pipeline = sharp({ create: { width: 10, height: 8, channels: 4, background: '#dfe5ee' } })
  for (const lossless of [false, true]) themes.install(bytes(await pipeline.webp({ lossless }).toBuffer()))
  expect(() => themes.install(Buffer.from(JSON.stringify(base)))).toThrow('缺少装饰图片')
  expect(() => themes.install(Buffer.from(JSON.stringify({ ...base, decoration: { surfaceOpacity: 0 } })))).toThrow('surfaceOpacity')
  const large = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: '#fff' } }).png().toBuffer()
  expect(() => themes.install(zipSync({ 'theme.json': Buffer.from(JSON.stringify({ ...base, decoration: { wallpaper: 'images/large.png' } })), 'images/large.png': large }))).toThrow('1600 万像素')
  expect(themes.snapshot().installed[0].decoration?.wallpaper).toBe(reference)
})

it('昼夜包验证两个分支，重启保留各自图标并复用同一张图片', () => {
  const dir = temp(), store = new ThemeStore(dir), ref = 'images/shared.png'
  const svg = Buffer.from('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>')
  const light = { base: 'daylight', preview: ref, icons: { search: 'icons/day.svg' } }
  const dark = { base: 'obsidian', decoration: { wallpaper: ref }, icons: { search: 'icons/night.svg' } }
  const pack = { formatVersion: 6, id: 'cycle', name: '昼夜', variants: { light, dark } }
  const archive = (variants: object) => zipSync({ 'theme.json': Buffer.from(JSON.stringify({ ...pack, variants })),
    [ref]: image, 'icons/day.svg': svg, 'icons/night.svg': Buffer.from('<svg viewBox="0 0 24 24"><path d="M2 2 L10 10"/></svg>') })
  store.install(archive(pack.variants))
  for (const [variants, message] of [
    [{ light }, 'variants.dark'],
    [{ light, dark: { ...dark, base: 'daylight' } }, 'variants.dark.base'],
    [{ light, dark: { ...dark, preview: 'images/missing.png' } }, '缺少预览图'],
    [{ light, dark: { ...dark, icons: { search: 'icons/missing.svg' } } }, '缺少图标']
  ] as const) expect(() => store.install(archive(variants))).toThrow(message)
  const [theme] = new ThemeStore(dir).snapshot().installed
  expect(theme.variants?.light).toMatchObject({ preview: ref, icons: { search: { shapes: [{ tag: 'circle' }] } } })
  expect(theme.variants?.dark).toMatchObject({ decoration: { wallpaper: ref }, icons: { search: { shapes: [{ tag: 'path' }] } } })
  expect(theme.variants?.dark.preview).toBeUndefined()
  expect(Object.keys(theme.images!)).toEqual([ref])
  store.remove(theme.id)
  expect(readdirSync(join(dir, 'images'))).toEqual([])
})

it('v5 预览可以独立于壁纸使用，装饰覆盖按库持久化，安装失败保留原预览', () => {
  const dir = temp(), store = new ThemeStore(dir), library = randomUUID(), ref = 'images/example.png'
  const pack = { ...manifest, formatVersion: 5, preview: ref }
  const file = (fields: object, assets: Record<string, Uint8Array> = { [ref]: image }) =>
    zipSync({ 'theme.json': Buffer.from(JSON.stringify({ ...pack, ...fields })), ...assets })
  store.install(file({}))
  store.change(library, { action: 'select', id: 'external:paper' })
  store.change(library, { action: 'decorationPlacement', value: { wallpaperAnchor: 'right', stickerAnchor: 'top-left' } })
  store.change(library, { action: 'decorationControl', key: 'wallpaperTileSize', value: 256 })
  store.change(library, { action: 'blurCards', enabled: false })
  for (const invalid of [{ formatVersion: 4 }, { preview: '../preview.png' }, { decoration: { blurCards: 'true' } }, { decoration: { wallpaperFit: 'stretch' } },
    { decoration: { stickerAnchor: 'center' } }, { decoration: { wallpaperTileSize: 0 } }, { decoration: { stickerOpacity: 101 } },
    { decoration: { stickerScale: 201 } }]) expect(() => store.install(file(invalid))).toThrow()
  expect(() => store.install(file({}, {}))).toThrow('缺少预览图')
  expect(() => store.install(file({}, { [ref]: image.subarray(0, 8) }))).toThrow('有效的静态')
  const reopened = new ThemeStore(dir)
  const snapshot = reopened.snapshot(library)
  expect(snapshot.installed[0].images?.[ref]).toBe('huoye-theme://assets/' + themeDigest(image) + '.png')
  expect(snapshot.installed[0].preview).toBe(ref)
  expect(snapshot.decoration).toEqual({ wallpaperAnchor: 'right', stickerAnchor: 'top-left', wallpaperTileSize: 256, blurCards: false })
  expect(reopened.snapshot(randomUUID()).decoration).toBeUndefined()
  reopened.change(library, { action: 'resetDecoration' })
  expect(reopened.snapshot(library).decoration).toBeUndefined()
  expect(reopened.snapshot(library).library?.presetId).toBe('external:paper')
  reopened.remove('external:paper')
  expect(reopened.image(themeDigest(image) + '.png')).toBeUndefined()
})

it('图标包只保存已验证的几何图形，更新被拒绝时保留原版及选用它的库', () => {
  const dir = temp(), store = new ThemeStore(dir), library = randomUUID()
  const file = 'icons/search.svg'
  const make = (svg: string, icons = { search: file }) => zipSync({
    'theme.json': Buffer.from(JSON.stringify({ ...manifest, formatVersion: 4, icons })), [file]: Buffer.from(svg)
  })
  const root = (body: string) => '<svg viewBox="0 0 32 32">' + body + '</svg>'
  const original = root('<g stroke="currentColor"><circle cx="12" cy="12" r="9" /></g>')
  store.install(make(original))
  store.change(library, { action: 'select', id: 'external:paper' })
  for (const body of ['<image />', '<script/>', '<path onclick="" />', '<rect fill="url(#paint)" />', '<style/>']) {
    expect(() => store.install(make(root(body)))).toThrow('SVG')
  }
  expect(() => store.install(make(original, { search: 'icons/missing.svg' }))).toThrow('缺少图标')
  expect(() => store.install(make(original, { search: 'other/search.svg' }))).toThrow()
  const saved = new ThemeStore(dir).snapshot(library)
  expect(saved.library?.presetId).toBe('external:paper')
  expect(saved.installed[0].icons).toEqual({ search: {
    viewBox: '0 0 32 32', shapes: [{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '9', stroke: 'currentColor' } }]
  } })
})
