import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Registry } from './registry'
import type { RelatedInputs, RelatedSnapshot } from './plugin'
import type { Blocks } from '../shared/blocks'

const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'"
export const relatedDigest = (s: string) => createHash('sha256').update(s).digest('hex')

/** 所有查询复用当前事务中的 ref、block 及回收状态；没有第二份引用表需要恢复。 */
export class RelatedReader {
  readonly sqlKey: string
  private readonly rawKeyQuery: Database.Statement
  private readonly keyQuery: Database.Statement
  private readonly members?: Database.Statement
  private readonly sourceIds: Database.Statement
  private readonly sources: Database.Statement
  private readonly owners: Database.Statement

  constructor(db: Database.Database, reg: Registry, spec: RelatedInputs) {
    const kind = literal(spec.kind), field = literal(spec.field)
    const owned = spec.ownerField !== undefined
    const belongs = `m.kind=${kind} AND m.field=${literal(spec.ownerField ?? '')}`
    const links = `r.kind=${kind} AND r.field=${field}`
    const memberRows = (owner: string) => `FROM main.ref m
      JOIN main.entity child ON child.id=m.entity_id AND child.deleted_at IS NULL
      JOIN main.block b ON b.entity_id=m.entity_id AND b.kind=m.kind
      WHERE m.target_id=${owner} AND ${belongs}`
    if (owned) this.members = db.prepare(`SELECT b.entity_id id,b.data ${memberRows('@owner')} ORDER BY b.entity_id`)
    const sourceIds = (owner: string) => `SELECT DISTINCT r.target_id FROM main.ref r
      JOIN main.entity src ON src.id=r.target_id AND src.deleted_at IS NULL
      WHERE ${links} AND r.entity_id ${owned ? `IN (SELECT b.entity_id ${memberRows(owner)})` : '= ' + owner}`
    // 传入目标 ID 集后按块主键读取，避免扫描库内所有缩略图。
    const sourceRows = (owner: string, kinds: string[], columns: string) => {
      const rows = kinds.map(k => `SELECT ${columns} FROM ${reg.schemaOf(k)}.block
        WHERE entity_id IN (SELECT id FROM sources) AND kind=${literal(k)}`).join(' UNION ALL ')
      return `WITH sources(id) AS MATERIALIZED (${sourceIds(owner)}) ${rows}`
    }
    this.sourceIds = db.prepare(sourceIds('@owner')).pluck()
    this.sources = db.prepare(sourceRows('@owner', spec.sourceKinds, 'entity_id,kind,data,seq,schema_ver'))
    const key = (owner: string, kinds: string[]) => {
      const membership = owned
        ? `SELECT json_group_array(json_array(b.entity_id,b.seq) ORDER BY b.entity_id) ${memberRows(owner)}`
        : `SELECT json_extract(b.data,${literal('$.' + spec.field)}) FROM main.block b WHERE b.entity_id=${owner} AND b.kind=${kind}`
      const revisions = kinds.length
        ? `SELECT json_group_array(json_array(entity_id,kind,seq) ORDER BY entity_id,kind) FROM (${sourceRows(owner,kinds,'entity_id,kind,seq')})`
        : `SELECT json_group_array(target_id ORDER BY target_id) FROM (${sourceIds(owner)})`
      return `hy_related_digest(json_array((${membership}),(${revisions})))`
    }
    this.sqlKey = key('e.id', spec.sourceKinds)
    this.keyQuery = db.prepare('SELECT ' + key('@owner', spec.sourceKinds)).pluck()
    this.rawKeyQuery = db.prepare('SELECT ' + key('@owner', spec.sourceKinds.filter(k => !reg.kind(k)?.rebuildable))).pluck()
    const changed = 'SELECT value FROM json_each(@ids)'
    const back = `SELECT r.entity_id FROM main.ref r WHERE r.target_id IN (${changed}) AND ${links}`
    this.owners = db.prepare(owned ? `SELECT DISTINCT m.target_id FROM main.ref m WHERE ${belongs}
      AND m.entity_id IN (${back} UNION ALL ${changed})` : `SELECT DISTINCT entity_id FROM (${back})`).pluck()
  }
  key(owner: string) { return this.keyQuery.get({ owner }) as string }
  affected(ids: string[]) { return this.owners.all({ ids: JSON.stringify(ids) }) as string[] }
  rawKey(owner: string) { return this.rawKeyQuery.get({ owner }) as string }
  targets(owner: string) { return this.sourceIds.all({ owner }) as string[] }
  snapshot(owner: string): RelatedSnapshot {
    const sources = new Map<string, Blocks>()
    type Row = { entity_id: string; kind: string; data: string; seq: number; schema_ver: number }
    for (const row of this.sources.all({ owner }) as Row[]) {
      const blocks = sources.get(row.entity_id) ?? {}
      blocks[row.kind] = { data: JSON.parse(row.data), seq: row.seq, ver: row.schema_ver }
      sources.set(row.entity_id, blocks)
    }
    const members = (this.members?.all({ owner }) ?? []) as { id: string; data: string }[]
    return { sources, members: members.map(row => ({ id: row.id, data: JSON.parse(row.data) })) }
  }
}
