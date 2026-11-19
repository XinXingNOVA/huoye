// 退出旧格式前的离线检查。只读 SQLite，不实例化 Host/FileSpace，不升级或恢复数据。
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

type Json = Record<string, any>
export interface StorageAudit {
  root: string
  libraryId?: string
  status: 'clear' | 'review' | 'incomplete'
  counts: { legacyReferences: number; undeclaredCandidates: number; historyReferences: number; derivedReferences: number; tasks: number }
  samples: { source: string; entity?: string; kind?: string; field: string; reference: string; trashed?: boolean; declared: boolean }[]
  spaces: { root: string; id?: string; binding?: string; version?: number; state: string }[]
  issues: { code: string; location: string; message: string; count?: number }[]
  sampleLimit: number
}
const has = (db: Database.Database, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const parse = (text: string): Json => { const value = JSON.parse(text); if (!object(value)) throw new Error('记录不是对象'); return value }
const normalize = (s: string) => s.replaceAll('\\', '/')
const legacyLike = (s: string) => /^(files|shared)\//.test(normalize(s)) || normalize(s).startsWith('spaces/v1/')
function readDb<T>(path: string, fn: (db: Database.Database) => T): T {
  if (realpathSync(path) !== join(realpathSync(dirname(path)), basename(path))) throw new Error('数据库不能使用符号链接')
  // SQLite 即使以 readonly 打开 WAL 库，也可能在原目录建立 -shm/-wal。
  // 连同 WAL 复制快照后只在临时目录打开；绝不能用 immutable 忽略尚未 checkpoint 的提交。
  const stamp = (file: string) => { if (!existsSync(file)) return ''; const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` }
  const wal = path + '-wal', journal = path + '-journal', before = [stamp(path), stamp(wal), stamp(journal)]
  if (before[2] && statSync(journal).size) throw new Error('存在回滚日志，请先用原版本完成恢复')
  const dir = mkdtempSync(join(tmpdir(), 'rm-storage-audit-')), copy = join(dir, 'snapshot.db')
  let db: Database.Database | undefined
  try {
    copyFileSync(path, copy)
    if (before[1]) {
      if (realpathSync(wal) !== join(realpathSync(dirname(wal)), basename(wal))) throw new Error('WAL 不能使用符号链接')
      copyFileSync(wal, copy + '-wal')
    }
    if (JSON.stringify(before) !== JSON.stringify([stamp(path), stamp(wal), stamp(journal)])) throw new Error('复制检查快照时数据库变化，请关闭仓库后重试')
    db = new Database(copy, { readonly: true, fileMustExist: true }); db.pragma('query_only = ON')
    const result = db.transaction(() => fn(db!))()
    if (JSON.stringify(before) !== JSON.stringify([stamp(path), stamp(wal), stamp(journal)])) throw new Error('检查期间数据库变化，请关闭仓库后重试')
    return result
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }) }
}

export function auditLibrary(directory: string, sampleLimit = 40): StorageAudit {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > 1000) throw new Error('样本上限须为 0～1000 的整数')
  const root = resolve(directory), result: StorageAudit = { root, status: 'clear', counts: { legacyReferences: 0, undeclaredCandidates: 0, historyReferences: 0, derivedReferences: 0, tasks: 0 }, samples: [], spaces: [], issues: [], sampleLimit }
  const issue = (code: string, location: string, message: string, count?: number) => result.issues.push({ code, location, message, ...(count === undefined ? {} : { count }) })
  const incomplete = (location: string, e: unknown) => { result.status = 'incomplete'; issue('unreadable', location, e instanceof Error ? e.message : String(e)) }
  const task = (location: string, count: number, message: string) => { if (count) { result.counts.tasks += count; issue('unfinished', location, message, count) } }
  const recovery = (directory: string) => {
    const path = join(directory, '.file-recovery')
    try { if (existsSync(path)) task(path, readdirSync(path).length, '存在旧文件恢复目录，需确认恢复完成') } catch (e) { incomplete(path, e) }
  }
  const inspectSpace = (directory: string, binding?: { id: string; state: string }) => {
    const path = join(directory, '.file-space.db'), info: StorageAudit['spaces'][number] = { root: directory, binding: binding?.state, state: 'unreadable' }
    result.spaces.push(info)
    if (binding?.state === 'detached') { info.id = binding.id; info.state = 'detached'; return } // 不重新访问已解除的外置目录。
    try {
      readDb(path, db => {
        const rows = db.prepare('SELECT id,version FROM space').all() as { id: string; version: number }[]
        if (rows.length !== 1 || typeof rows[0].id !== 'string') throw new Error('空间身份不完整')
        const row = rows[0]; info.id = row.id; info.version = row.version
        if (binding && binding.id !== row.id) throw new Error('空间身份与仓库关联不匹配')
        info.state = row.version === 4 ? 'versioned' : row.version === 5 ? 'retired' : 'legacy'
        if (row.version === 5 && binding) issue('retired-binding', directory, '仓库仍关联已封存的旧空间')
        else if ([1, 2, 3].includes(row.version)) issue('legacy-space', directory, '仍有旧格式空间')
        else if (![4, 5].includes(row.version)) throw new Error(`不支持的空间版本 ${row.version}`)
        if (row.version === 5) return // 已完成迁移的封存记录不等于活跃旧依赖。
        if (has(db, 'files')) task(path + ':files', Number(db.prepare("SELECT count(*) FROM files WHERE state='pending'").pluck().get()), '存在未完成的旧文件保存')
        if (has(db, 'version_drafts')) task(path + ':version_drafts', Number(db.prepare("SELECT count(*) FROM version_drafts WHERE state NOT IN ('committed','discarded')").pluck().get()), '存在未结束的版本草稿；这是现行能力，不能随兼容清理删除')
        if (has(db, 'space_maintenance')) task(path + ':space_maintenance', Number(db.prepare('SELECT count(*) FROM space_maintenance WHERE retired=0').pluck().get()), '存在空间维护记录')
      })
      const marker = join(directory, '.migration-owner.json')
      if (existsSync(marker) && !parse(readFileSync(marker, 'utf8')).complete) task(marker, 1, '空间迁移准备尚未结束')
      recovery(directory)
    } catch (e) { incomplete(path, e) }
  }
  if (existsSync(join(root, '.lock'))) issue('open-library', root, '仓库仍有打开标记；请关闭仓库后复查，当前结果不是跨数据库一致快照')
  const defs = new Map<string, Json>()
  const scan = (data: Json, context: Omit<StorageAudit['samples'][number], 'field' | 'reference' | 'declared'>) => {
    const fields = defs.get(context.kind ?? '')?.fields
    const walk = (value: unknown, field: string, declared: boolean) => {
      if (typeof value === 'string') {
        const ref = normalize(value)
        const old = legacyLike(ref) || (declared && !ref.startsWith('spaces/v2/') && !ref.startsWith('cache/'))
        if (!old) return
        if (context.source === 'history') result.counts.historyReferences++
        else if (context.source === 'derived') result.counts.derivedReferences++
        else if (declared) result.counts.legacyReferences++
        else result.counts.undeclaredCandidates++
        if (result.samples.length < sampleLimit) result.samples.push({ ...context, field, reference: value, declared })
      } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${field}[${i}]`, declared))
      else if (object(value)) Object.entries(value).forEach(([k, v]) => walk(v, `${field}.${k}`, false))
    }
    for (const [field, value] of Object.entries(data)) {
      const def = fields?.[field]
      if (def?.file && value != null && !(def.list ? Array.isArray(value) && value.every(v => typeof v === 'string') : typeof value === 'string')) incomplete(`${context.source}:${context.entity}/${context.kind}.${field}`, '文件字段形状不符，需核对')
      walk(value, field, !!def?.file)
    }
  }
  try {
    readDb(join(root, 'library.db'), db => {
      const id = db.prepare("SELECT value FROM meta WHERE key='library_id'").pluck().get()
      if (typeof id !== 'string' || !id) throw new Error('缺少仓库身份')
      result.libraryId = id
      for (const row of db.prepare('SELECT id,def FROM kind_def').iterate() as Iterable<{ id: string; def: string }>) {
        try { const def = parse(row.def); if (!object(def.fields)) throw new Error('定义缺少字段信息'); defs.set(row.id, def) } catch (e) { incomplete(`kind_def:${row.id}`, e) }
      }
      for (const row of db.prepare('SELECT b.entity_id,b.kind,b.data,e.deleted_at FROM block b LEFT JOIN entity e ON e.id=b.entity_id').iterate() as Iterable<{ entity_id: string; kind: string; data: string; deleted_at: number | null }>) {
        try { scan(parse(row.data), { source: 'original', entity: row.entity_id, kind: row.kind, trashed: row.deleted_at != null }) }
        catch (e) { incomplete(`block:${row.entity_id}/${row.kind}`, e) }
      }
      if (has(db, 'block_history')) for (const row of db.prepare('SELECT entity_id,kind,data,new_data FROM block_history').iterate() as Iterable<{ entity_id: string; kind: string; data: string | null; new_data: string | null }>) {
        for (const value of [row.data, row.new_data]) if (value) {
          try { scan(parse(value), { source: 'history', entity: row.entity_id, kind: row.kind }) } catch (e) { incomplete(`history:${row.entity_id}/${row.kind}`, e) }
        }
      }
      if (has(db, 'ingest_pending')) task('ingest_pending', Number(db.prepare('SELECT count(*) FROM ingest_pending').pluck().get()), '存在未完成导入，先接续或确认其归属')
      if (has(db, 'file_edits')) for (const row of db.prepare('SELECT id,data FROM file_edits').iterate() as Iterable<{ id: string; data: string }>) {
        try { const d = parse(row.data); if (!d.discarded && (!d.result || d.result.library?.state === 'pending')) task(`file_edits:${row.id}`, 1, '文件编辑尚未结束或尚待仓库接纳') }
        catch (e) { incomplete(`file_edits:${row.id}`, e) }
      }
      if (has(db, 'space_publications')) for (const row of db.prepare('SELECT request_id,result FROM space_publications').iterate() as Iterable<{ request_id: string; result: string | null }>) {
        try { if (!row.result || parse(row.result).library?.state === 'pending') task(`space_publications:${row.request_id}`, 1, '空间发布尚待完成或接纳') }
        catch (e) { incomplete(`space_publications:${row.request_id}`, e) }
      }
      if (has(db, 'file_migrations')) for (const row of db.prepare('SELECT id,data FROM file_migrations').iterate() as Iterable<{ id: string; data: string }>) {
        try { const d = parse(row.data); if (d.state !== 'abandoned' && !(d.state === 'complete' && d.retired)) task(`file_migrations:${row.id}`, 1, '迁移尚未完成或封存收尾未完成') }
        catch (e) { incomplete(`file_migrations:${row.id}`, e) }
      }
      const inspected = new Set<string>()
      if (has(db, 'file_spaces')) for (const row of db.prepare('SELECT id,root,state,embedded FROM file_spaces').all() as { id: string; root: string; state: string; embedded: number }[]) {
        if (row.embedded && (isAbsolute(row.root) || relative(root, resolve(root, row.root)).startsWith('..'))) { incomplete(`file_spaces:${row.id}`, '随库空间位置越界'); continue }
        if (!row.embedded && !isAbsolute(row.root)) { incomplete(`file_spaces:${row.id}`, '外置空间位置不是绝对路径'); continue }
        const path = row.embedded ? resolve(root, row.root) : row.root
        inspected.add(path)
        if (!['active', 'pending', 'detaching', 'detached'].includes(row.state)) incomplete(`file_spaces:${row.id}`, '关联状态无法识别')
        if (row.state === 'pending' || row.state === 'detaching') task(`file_spaces:${row.id}`, 1, '两端关联或解除未完成')
        inspectSpace(path, row)
      }
      if (!inspected.has(root) && existsSync(join(root, '.file-space.db'))) inspectSpace(root)
    })
  } catch (e) { incomplete(join(root, 'library.db'), e) }
  if (!result.spaces.some(s => s.binding && s.binding !== 'detached')) issue('no-active-space', root, '没有可确认的活跃文件空间关联')
  if (existsSync(join(root, '.file-storage.json'))) issue('legacy-sharing-index', root, '仍存在旧逐文件共享登记；只报告，不清理')
  if (!result.spaces.some(s => s.root === root && s.state !== 'detached')) recovery(root)
  const derived = join(root, 'derived.db')
  if (existsSync(derived)) try {
    readDb(derived, db => { if (has(db, 'block')) for (const row of db.prepare('SELECT entity_id,kind,data FROM block').iterate() as Iterable<{ entity_id: string; kind: string; data: string }>) {
      scan(parse(row.data), { source: 'derived', entity: row.entity_id, kind: row.kind })
    } })
  } catch (e) { incomplete(derived, e) }
  if (result.counts.legacyReferences) issue('legacy-references', 'block', '原始记录仍引用旧文件格式，含回收站与已保存的停用插件定义', result.counts.legacyReferences)
  if (result.counts.undeclaredCandidates) issue('undeclared-candidates', 'block', '非文件字段含疑似旧引用；可能是普通文字，需人工判断，不能自动删除', result.counts.undeclaredCandidates)
  if (result.counts.derivedReferences) issue('derived-references', 'derived.block', '可重建数据仍有旧引用，退出前需要重建', result.counts.derivedReferences)
  if (result.status !== 'incomplete' && result.issues.length) result.status = 'review'
  return result
}
