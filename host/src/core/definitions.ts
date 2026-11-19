// 持久定义快照、动态定义与休眠定义的接续。由 Store 事务调用，不承担业务编辑。
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import type { CorePlugin } from './plugin'
import type { BlockKind } from '../shared/blocks'
import type { PluginInfo, PluginPlan } from '../plugins/manifest'
import { canonical, kindSnapshot } from '../shared/external-plugins'
import { registerPluginData } from './plugin-data-registration'
import { collectUnusedDefinedKinds } from './kind-snapshots'

export class Definitions {
  constructor(private lib: Library, private reg: Registry, private store: Store) {}

  initialize(manifest: PluginInfo[], plan: PluginPlan, active: CorePlugin[], plugins: CorePlugin[]): void {
    this.store.definers = new Set(this.reg.definers().map(d => d.kind))
    this.store.onDefine = () => this.load()
    // 结构版本、快照和外部契约同一事务，失败不留下半次接续。
    this.store.batch(() => {
      this.snapshotKinds(this.reg.pluginKinds())
      for (const p of manifest.filter(p => p.external && plan.enabled.has(p.id))) {
        const schema = this.reg.pluginKinds().filter(k => k.plugin === p.id && !k.rebuildable).map(kindSnapshot).sort((a, b) => a.id.localeCompare(b.id))
        this.lib.db.prepare('INSERT INTO main.config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`externalSchema:${p.id}`, canonical(schema))
        const d = active.find(plugin => plugin.id === p.id)?.defines
        this.lib.db.prepare('INSERT OR IGNORE INTO main.config (key, value) VALUES (?, ?)').run(`externalDefinitions:${p.id}`, canonical(d ? { kind: d.kind, prefix: d.prefix } : null))
      }
      this.load()
      collectUnusedDefinedKinds(this.lib.db)
      this.loadDormantKinds(new Set(active.map(p => p.id)), plugins)
      this.store.migrate()
      registerPluginData(this.lib.db, active, manifest)
    })
    this.store.cleanEmptyManagement()
  }

  /**
   * 数据块定义的快照（名称、字段、是否内容类……，不含代码）存进仓库。
   * 插件停用后，宿主靠它认得插件留下的数据：显示字段名、能查询、素材还算素材。
   */
  private snapshotKinds(kinds: BlockKind[]): void {
    const up = this.lib.db.prepare('INSERT INTO main.kind_def (id, def) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET def = excluded.def')
    this.lib.db.transaction(() => {
      for (const k of kinds) {
        up.run(k.id, JSON.stringify(kindSnapshot(k)))
      }
    })()
  }

  /** 没有启用的插件留下的数据块：按快照注册成休眠的定义（能看能查，不能写，不加工）。 */
  private loadDormantKinds(active: Set<string>, plugins: CorePlugin[]): void {
    const defs = (this.lib.db.prepare('SELECT def FROM main.kind_def').pluck().all() as string[]).map((d) => JSON.parse(d) as BlockKind)
    const known = plugins.flatMap(p => p.blocks ?? [])
    this.reg.setDormant(defs.filter(k => !active.has(k.plugin) && (!k.template || this.store.exists(k.template) || this.lib.db.prepare('SELECT 1 FROM main.block WHERE kind = ? LIMIT 1').get(k.id))).map(k => ({
      ...k, management: k.management ?? known.find(d => d.id === k.id && d.plugin === k.plugin)?.management
    })))
  }

  /**
   * 由数据定义的数据块：读出所有定义它们的数据块（包括回收站里的——已经填的数据要照样能显示），
   * 重新注册。旧内置定义保留容错；声明前缀的新契约严格失败，由写事务完整回滚。
   */
  load(): void {
    const kinds: { plugin: string; kind: BlockKind }[] = []
    const problems: string[] = []
    for (const d of this.reg.definers()) {
      const rows = this.lib.db
        .prepare(`SELECT entity_id, data FROM ${this.reg.schemaOf(d.kind)}.block WHERE kind = ?`)
        .all(d.kind) as { entity_id: string; data: string }[]
      for (const r of rows) {
        try {
          kinds.push({ plugin: d.plugin, kind: d.build(r.entity_id, JSON.parse(r.data)) })
        } catch (e) {
          if (d.prefix) throw e
          problems.push(`${d.kind} ${r.entity_id}：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    problems.push(...this.reg.setDefined(kinds, this.reg.definers().some(d => !!d.prefix)))
    for (const p of problems) console.warn('[core] 跳过数据块定义', p)
    this.snapshotKinds(this.reg.definedKinds())
  }
}
