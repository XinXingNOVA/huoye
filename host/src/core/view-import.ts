import { basename, extname } from 'node:path'
import { stat } from 'node:fs/promises'
import { FILE_MIME } from '../shared/file-metadata'
import { MAX_IMPORT_BYTES, type ImportInput } from '../shared/ingest-input'
import { describeCondition, searchesOf, splitConditions, type Query } from '../shared/query'
import { querySchema } from '../shared/query-input'
import type { ViewImportCandidate } from '../shared/view-import'
import type { Registry } from './registry'
import { expandInputs } from './ingest'

/** 只读的保守预检：不复制原件、不执行插件加工，未知条件必须由用户显式选择。 */
export async function previewViewImport(reg: Registry, inputs: ImportInput[], rawQuery: Query): Promise<ViewImportCandidate[]> {
  const query = querySchema.parse(rawQuery), split = splitConditions(query, id => reg.kind(id))
  const result: ViewImportCandidate[] = []
  for (const [sourceIndex, input] of inputs.entries()) {
    for (const source of await expandInputs([input])) {
      const title = source.type === 'file' ? basename(source.path) : source.type === 'bytes' ? source.name : source.text.trim().slice(0, 80) || '文字内容'
      const row = { sourceIndex, title, ...(source.type === 'file' ? { path: source.path } : {}) }
      try {
        let file: Record<string, string | number> | undefined
        if (source.type !== 'text') {
          const size = source.type === 'file' ? await stat(source.path).then(s => { if (!s.isFile()) throw new Error('不是普通文件'); return s.size }) : source.bytes.byteLength
          if (source.type === 'bytes' && (!size || size > MAX_IMPORT_BYTES)) throw new Error('无路径文件必须有内容，且不能超过 32 MB')
          const ext = extname(title).slice(1).toLowerCase()
          file = { name: title, size, ext, mime: FILE_MIME[ext] ?? 'application/octet-stream' }
        }
        if (!split) { result.push({ ...row, status: 'unmatched', reason: query.role === 'management' ? '管理视图不接受拖入' : '回收站不接受拖入' }); continue }
        const check = split.check, failed: string[] = [], unknown: string[] = []
        const describe = (c: Parameters<typeof describeCondition>[0]) => describeCondition(c, id => reg.kind(id))
        for (const kind of check.has ?? []) {
          if (kind !== 'file' || !file) unknown.push(describe({ has: kind }))
        }
        for (const kind of check.lacks ?? []) {
          if (kind === 'file' && file) failed.push(describe({ lacks: kind })); else unknown.push(describe({ lacks: kind }))
        }
        for (const c of check.where ?? []) {
          if (c.op === 'subtree') { unknown.push(describe(c)); continue }
          if (c.kind !== 'file' || !file || !(c.field in file)) { unknown.push(describe(c)); continue }
          const value = file[c.field]
          // 混用数值／文字等需要 SQLite 转换的查询留待正式入口，不另造一套强制转换规则。
          const values = c.op === 'eq' ? [c.value] : c.op === 'in' ? c.values : []
          if (values.some(v => typeof v !== typeof value)) { unknown.push(describe(c)); continue }
          const pass = c.op === 'eq' ? value === c.value : c.op === 'in' ? c.values.includes(value) : c.op === 'empty' ? false :
            typeof value === 'number' && (c.min === undefined || value >= c.min) && (c.max === undefined || value <= c.max)
          if (!pass) failed.push(describe(c))
        }
        if (searchesOf(check).length) unknown.push('搜索内容需要收录加工后确认')
        if (check.ids) unknown.push('需要确认是否属于指定素材范围')
        result.push({ ...row, status: failed.length ? 'unmatched' : unknown.length ? 'unknown' : 'matched',
          ...(failed.length ? { reason: `未满足：${failed.join('；')}` } : unknown.length ? { reason: `待确认：${unknown.join('；')}` } : {}) })
      } catch (e) { result.push({ ...row, status: 'error', reason: e instanceof Error ? e.message : String(e) }) }
    }
  }
  return result
}
