// 数据块与值类型：核心进程与界面共用的定义。

/** 值类型。每种值类型自带默认的显示、编辑、索引方式。 */
export type FieldType =
  | 'text' // 单行文本
  | 'longtext' // 多行文本
  | 'number'
  | 'boolean'
  | 'date' // 毫秒时间戳
  | 'enum'
  | 'color' // #rrggbb
  | 'ref' // 另一个身份的 ID
  | 'json' // 不透明的结构化数据，不索引

export interface FieldDef {
  type: FieldType
  title: string
  /** 列表字段：值是数组，索引时每个值一行。 */
  list?: boolean
  /** enum 的可选值。 */
  options?: string[]
  /** ref 字段的引用类型：依附 / 关联。 */
  ref?: 'attach' | 'link'
  /** 可筛选、可排序：写入字段索引。 */
  index?: boolean
  /** 全文搜索：这个字段的文字写入全文索引（文本、长文本，以及文本列表）。 */
  search?: boolean
  /** 文本分页的起始偏移数组所在字段。外部读取可据此按页读；偏移使用 JavaScript UTF-16 单位。 */
  pageOffsets?: string
  /** 显示格式，通用显示与编辑按它呈现：数字的时长、字节、像素、评分（星星）；文本的网址；长文本的 Markdown。 */
  format?: 'duration' | 'bytes' | 'px' | 'rating' | 'url' | 'markdown'
  /**
   * 公共文件引用。不可重建的数据块里的是原件，可重建的数据块里的是缓存。
   * 删除素材记录保留原件；应用级原件处置按这些声明解析文件空间身份，不推断普通文字或链接。
   */
  file?: boolean
  /** 数字的取值范围（例如评分 1–5）。 */
  min?: number
  max?: number
}

/** 一种数据块的定义，由插件提供。 */
export interface BlockKind {
  id: string
  /** 定义它的插件。 */
  plugin: string
  title: string
  /** 可重建：能从库内其他数据重新算出，存入 derived.db。 */
  rebuildable: boolean
  /** 可进入内容视图的身份块，包括普通素材和可浏览的容器。 */
  content?: boolean
  /** 该内容块赋予身份容器角色；成员身上的关系块不声明。 */
  container?: boolean
  /** 附加块可用于容器，例如插件提供的文件夹说明。 */
  allowOnContainer?: boolean
  /** 不可重建的数据块默认保留历史版本；高频写入的行为数据（例如播放位置）可以关掉。 */
  history?: boolean
  version: number
  fields: Record<string, FieldDef>
  /** 通用呈现所用的字段，随定义快照保留；不依赖插件的界面代码。优先级从小到大。 */
  display?: {
    title?: string; summary?: string; priority?: number
    /** false：不在检查器的通用信息分区展开；原始数据详情仍可读。 */
    inspector?: boolean
  }
  /** 由管理记录生成的动态定义：来源身份 ID（如模板）。静态定义没有此标记；来源与使用者均消失后核心可回收快照。 */
  template?: string
  /** 独立数据块：自己就构成一个身份（视图、模板），不挂到素材上，快速附加不提供它。 */
  standalone?: boolean
  /** 插件管理记录：独立存在，通用界面只读；生命周期由所属插件命令管理。
   * emptyWhen：该列表为空且记录没有其他块时，启动时可清理旧版留下的空容器。 */
  management?: { emptyWhen?: string }
  /** 从属记录的唯一归属字段（单值 attach）。记录独立持有身份，随所属内容回收。 */
  ownedBy?: string
  /** 接入时捕获的数据（例如来源）：不可重建，能看、能改，但不是用户手写的，快速附加不提供它。 */
  captured?: boolean
  /**
   * 休眠：定义它的插件在这个仓库里没有启用，定义来自仓库里存的快照（设计文档 8.4）。
   * 数据照样能显示、查询、筛选，但不能修改，也不再加工。
   */
  dormant?: boolean
  /** 字段类型之外的约束（例如模板块的字段列表结构），不满足时抛错。 */
  validate?(data: BlockData): void
}

export type BlockData = Record<string, unknown>

export interface BlockValue {
  data: BlockData
  /** 全库递增的写入序号。 */
  seq: number
  /** 写入时数据块定义的版本。 */
  ver: number
}

export type Blocks = Record<string, BlockValue>

export interface JobState {
  status: 'ok' | 'failed' | 'skipped'
  error?: string
}

export interface EntityIdentity {
  id: string
  createdAt: number
  deletedAt: number | null
}

/** 一个身份连同它挂着的全部数据块。 */
export interface EntityView extends EntityIdentity {
  blocks: Blocks
  /** 各加工 System 在这个身份上的状态，只列出失败的。 */
  failures: Record<string, string>
}

/** 校验并规整一份数据块数据：只保留声明的字段，按值类型转换。 */
export function normalizeBlock(kind: BlockKind, data: BlockData): BlockData {
  const out: BlockData = {}
  for (const [name, def] of Object.entries(kind.fields)) {
    const value = data[name]
    if (value === undefined || value === null) continue
    if (def.list) {
      if (!Array.isArray(value)) {
        throw new Error(`数据块 ${kind.id} 的字段 ${name} 应为列表`)
      }
      out[name] = value.map((v) => normalizeValue(kind.id, name, def, v))
    } else {
      out[name] = normalizeValue(kind.id, name, def, value)
    }
  }
  kind.validate?.(out)
  return out
}

function normalizeValue(kind: string, name: string, def: FieldDef, value: unknown): unknown {
  const fail = (): never => {
    throw new Error(`数据块 ${kind} 的字段 ${name} 不是有效的 ${def.type}：${JSON.stringify(value)}`)
  }
  switch (def.type) {
    case 'text':
    case 'longtext':
    case 'ref':
      return typeof value === 'string' ? value : fail()
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail()
      if ((def.min !== undefined && (value as number) < def.min) || (def.max !== undefined && (value as number) > def.max)) fail()
      return value
    case 'date':
      return typeof value === 'number' && Number.isFinite(value) ? value : fail()
    case 'boolean':
      return typeof value === 'boolean' ? value : fail()
    case 'enum':
      return typeof value === 'string' && (!def.options || def.options.includes(value)) ? value : fail()
    case 'color':
      return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fail()
    case 'json':
      return value
  }
}

/** 数据的归属和交互角色分开：插件产生的音频、摘录等仍是素材。 */
export function managementKind(blocks: Blocks, kindOf: (id: string) => BlockKind | undefined): BlockKind | undefined {
  return Object.keys(blocks).map(kindOf).find(k => k?.management !== undefined)
}

export function isContainer(blocks: Blocks, kindOf: (id: string) => BlockKind | undefined): boolean {
  return Object.keys(blocks).some(kind => kindOf(kind)?.container)
}
