// 公共后端契约：插件声明能力，宿主提供事务、调度和数据访问。
// 不导入核心实现、MCP 协议或装配清单。

import type { BlockData, BlockKind, Blocks } from '../../shared/blocks'
import type { Query, QueryResult } from '../../shared/query'
import type { IngestInput } from '../../shared/ingest-input'
import type { OperationDefinition } from '../operations'
import type { IngestMetadataDefinition } from '../ingest'
import type { QueryDefinition } from '../queries'
import type { ImageTools } from './images'

export interface CorePlugin {
  id: string
  /** 插件版本。变化时，它的加工 System 产出的数据全部过期。 */
  version: number
  /** 依赖的外部程序。缺少任何一个时，整个插件标记为不可用，它的加工都不运行。 */
  requires?: { programs?: string[] }
  /** 显式清理时的责任声明；停用仍保留数据。外部包声明 data-lifecycle-v1。 */
  dataLifecycle?: import('../../shared/plugin-data').DataLifecycle
  blocks?: BlockKind[]
  recognizers?: Recognizer[]
  systems?: ProcessorSystem[]
  /** 单值扩展点：卡片宽高比。按 priority 从小到大，第一个给出值的生效。 */
  aspect?: { priority: number; get(blocks: Blocks): number | undefined }
  /** 不可重建数据块的迁移：把 from 版本的数据升级到下一版本。 */
  migrations?: Record<string, (data: BlockData, from: number) => BlockData>
  /** 完整旧定义：仅允许增添字段／枚举项及显示元信息，已有值保持原样。外部包需声明 compatible-schemas-v1。 */
  compatibleSchemas?: BlockKind[]
  /**
   * 由数据定义的数据块：kind 这种数据块的每一块，定义一种新的数据块（例如用户的模板）。
   * 宿主启动时、这种数据块变化时重新注册，并通知界面。定义出来的数据块属于这个插件，必须不可重建。
   */
  defines?: {
    kind: string
    /** 外部包必填，并与 manifest.definitions 一致；输出 ID 为 prefix + entityId。 */
    prefix?: string
    /** 纯函数；只根据该管理记录生成附加字段，不读取其他状态或产生副作用。 */
    build(entityId: string, data: BlockData): BlockKind
  }
  /**
   * 命令：要在数据旁边、一个事务里完成的批量修改（例如改模板字段的类型要同时改所有素材上的值）。
   * 每次执行是一个可撤销的操作；也可以预演——在事务里跑一遍再回滚，只拿结果（例如影响多少项）。
   */
  commands?: Record<string, Command>
  /** 可供外部调用的业务操作白名单；沿用 commands 的事务、事件和撤销。 */
  operations?: OperationDefinition[]
  /** 已启用插件发布的同步业务只读查询；外部包声明 business-queries-v1。 */
  queries?: QueryDefinition[]
  /** 显式携带的导入附加意图，预校验后在收录事务内同步执行。 */
  ingestMetadata?: IngestMetadataDefinition[]
  /**
   * 接入之后：识别器建好身份后，每个插件都可以按输入再补一些数据块（例如来源插件记下网址）。
   * created：这次新建的身份；识别为已有内容时是 false。
   */
  afterIngest?(ctx: IngestContext, id: string, input: IngestInput, created: boolean): void
  /** 导出（输出，设计文档 11.12）：这个插件认识的素材怎么写成一个文件。 */
  exporters?: Exporter[]
  /** 为自己的数据块贡献格式导出片段；未被接管的字段继续通用输出。 */
  exportSections?: ExportSection[]
}

/**
 * 导出时一个身份写成的文件。单值：同一个身份上 priority 小的写（文字插件写 Markdown，先于文件插件复制原文件）。
 * 宿主负责：挑选、重名、文件夹、失败了跳过并记下、索引；插件只管它认识的东西怎么写。
 */
export interface Exporter {
  priority: number
  match(blocks: Blocks): boolean
  /** 放在哪个文件夹（素材、文字、局部……）、叫什么。重名由宿主处理。 */
  place(blocks: Blocks, title: string): { folder: string; name: string }
  /** 预览估算，不提供时不计入字节数。 */
  bytes?(blocks: Blocks): number
  /** 写出去。dest 是绝对路径。 */
  write(ctx: ExportContext, id: string, blocks: Blocks, dest: string): Promise<void>
}

export interface ExportContext {
  /** 通过宿主定位文件引用（当前兼容库内相对路径）；返回本次使用的本地路径，不持久化或自行拼接 root。 */
  abs(rel: string): string
  /** 一起导出的另一个身份写到了哪里，相对 from 这个文件夹；没有一起导出（或者它没有文件）时 undefined。 */
  linkTo(id: string, from: string): string | undefined
  /** 按索引字段找身份；文件名等具体解释由使用方决定。 */
  findByField(kind: string, field: string, value: string | number): string | undefined
  /** 这个身份的属性：标签、状态、模板字段、来源……由数据块定义生成，插件不用各写一套。 */
  properties(id: string): ExportProperty[]
  title(id: string): string
}

export interface ExportProperty {
  kind: string
  field: string
  /** 给人看的名字（数据块只有一个字段时用数据块的名字，例如"标签"）。 */
  label: string
  value: string | string[]
  /** 机器格式中的属性名，例如 Markdown front matter 的 tags；默认使用 label。 */
  key?: string
  /** 另有专用正文呈现时可省略索引中的属性行；仍提供给其他导出器。 */
  index?: boolean
}

export interface ExportSection {
  id: string
  /** 只能接管本插件静态定义的字段；重复认领视为装配错误。 */
  kind: string
  fields: string[]
  order?: number
  /** 同步纯呈现。返回 undefined 时不认领字段；抛错时报告并保留通用输出。 */
  render(data: BlockData): ExportSectionValue | undefined
}

export interface ExportSectionValue {
  properties?: Omit<ExportProperty, 'kind'>[]
  /** 索引中的完整 Markdown 段落。 */
  markdown?: string
  /** 作为依附记录列出时的一行摘要，不包括文件链接。 */
  inline?: string
  /** 此片段已输出该身份的完整内容，无独立文件时也算成功，例如文字摘录。 */
  content?: boolean
}

export interface CommandContext {
  kind(id: string): BlockKind | undefined
  query(q: Query): QueryResult
  blocksOf(id: string): Blocks
  createEntity(): string
  /** 仅写已有身份（可在本命令中创建）的持久业务块；派生块由加工生成。file 仅可修改显示名，引用／版本快照走文件编辑协议。 */
  put(id: string, kind: string, data: BlockData): void
  /** 移除已有素材的持久业务块；不可移除 file、派生块或管理记录。删除动态来源后仍可清理其残留值。 */
  remove(id: string, kind: string): void
  /** 将最多 100 项普通素材移入回收站；attach 依附者随行，link 不随行。加入当前命令的事务／撤销，可预演。 */
  trash(ids: string[]): void
  /** 恢复最多 100 项普通素材；沿用回收批次的 attach 恢复规则，link 不随行。事务、预演与撤销同 trash。 */
  restore(ids: string[]): void
  /** 删除本插件的管理记录，不进回收站；同一命令中修改的数据一起撤销。禁止删除素材或原文件。 */
  deleteRecord(id: string): void
}

/** 返回操作的名称（显示在"撤销 …"里）和给界面的结果。 */
export type Command = (ctx: CommandContext, args: Record<string, unknown>) => { label: string; result?: unknown }

/** 接入识别器：把一种外部输入变成身份和初始数据块。 */
export interface Recognizer {
  id: string
  /** 多个识别器都能处理时，priority 小的优先。 */
  priority?: number
  match(input: IngestInput): boolean
  /** 返回身份 ID；识别为已有内容时返回已有身份。 */
  ingest(ctx: IngestContext, input: IngestInput): Promise<string>
}

export interface IngestContext {
  /** 在收录准备阶段预留身份，整批提交前对其他调用不可见。 */
  createEntity(): string
  put(id: string, kind: string, data: BlockData): void
  /** 按字段索引查找一个身份（包括回收站中的）。 */
  findByField(kind: string, field: string, value: string | number): string | undefined
  /** 暂存本次新建身份的外部文件；提交后返回路径才可在库中读取。afterIngest 中不可调用。 */
  importFile(id: string, src: string, name: string): Promise<string>
}

/** 加工 System：识别数据块，产出新的可重建数据块。 */
export interface ProcessorSystem {
  id: string
  /** 调度顺序，小的先做。同一种数据块有多个产出者时，也按它仲裁。 */
  priority: number
  /** 识别条件：必须挂有这些数据块。 */
  has: string[]
  /**
   * 用到别的插件定义的数据块时，写明那些插件（例如视频插件为批注插件的时间段锚点截帧）。
   * 它们没有启用时，这个 System 不装配，而不是报"数据块未定义"。
   */
  needs?: string[]
  /** 额外的识别条件；不满足时记为 skipped，输入变化后重新判断。 */
  match?(blocks: Blocks): boolean
  /**
   * 新鲜度依赖的数据块，必须是 has 的子集；默认等于 has。
   * 也可以只依赖数据块里的一个字段，写成"数据块.字段"（按值比较，用在文字字段上）：
   * 例如视频截帧只关心文件的内容，写 'file.hash'——改名改了文件块，但内容没变，就不用重做（设计文档 11.14）。
   */
  inputs?: string[]
  /**
   * 新鲜度还依赖依附目标上的这些数据块（局部依赖原素材：原图换了要重裁，原文改了要重新找那一句）。
   * 目标是这个身份依附引用的那个身份（局部只有一个）；目标上这些数据块变了，这个加工就过期。
   * 和 inputs 一样可以写成"数据块.字段"。
   */
  targetInputs?: string[]
  /**
   * 产出的数据块，必须是可重建的。不同插件可以产出同一种数据块，
   * 在每个身份上，满足识别条件、priority 最小的那个才是写入者。
   */
  outputs: string[]
  /** 同时运行的上限。视频截帧这类重活设为 1~2。 */
  concurrency?: number
  /** 按需加工：平时不运行，使用场景请求时才运行（例如播放时才转码）。 */
  demand?: boolean
  /** 返回产出：值为 null 表示移除这个数据块。 */
  run(ctx: JobContext, id: string, blocks: Blocks): Promise<Record<string, BlockData | null>>
}

export interface SystemContext {
  /** 仓库身份与配置所在目录；文件定位使用 abs，不能据此推导原文件位置。 */
  root: string
  /** 宿主提供的图像原语；插件决定来源、区域、输出及加工依赖。 */
  images: ImageTools
  /** 通过宿主定位文件引用（当前兼容库内相对路径）；返回本次使用的本地路径，不持久化或自行拼接 root。 */
  abs(rel: string): string
  /** 派生文件缓存目录（使用 / 的库内相对路径），不存在时创建；拼接子路径用 posix.join。 */
  cacheDir(name: string): string
  /** 插件声明过的外部程序的绝对路径。 */
  program(name: string): string
  /**
   * 读另一个身份的数据块（例如局部读原素材的代表图来裁剪）。
   * 新鲜度只看自己身上的输入，和声明在 targetInputs 里的依附目标上的数据块；读别的身份不会自动重算。
   */
  blocksOf(id: string): Blocks
  /** 按字段索引查找一个身份（例如按文件名找到 ![[pic.png]] 指的是谁）。新鲜度同样不跟着别的身份走。 */
  findByField(kind: string, field: string, value: string | number): string | undefined
}

/** 一次加工运行的上下文。 */
export interface JobContext extends SystemContext {
  /** 素材被删除、宿主停止时触发；收到后应尽快结束（例如杀掉子进程）。 */
  signal: AbortSignal
  /** 报告进度（0~1），按需加工时显示给用户。 */
  progress(fraction: number): void
}

/** 新鲜度依赖的一项："数据块"或"数据块.字段"。 */
export function inputSpec(spec: string): { kind: string; field?: string } {
  const i = spec.indexOf('.')
  return i < 0 ? { kind: spec } : { kind: spec.slice(0, i), field: spec.slice(i + 1) }
}

export type { DataLifecycle } from '../../shared/plugin-data'
