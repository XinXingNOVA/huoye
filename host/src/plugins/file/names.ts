import { portableFileName } from '../../shared/paths'
// 文件名的规则（设计文档 11.14）：核心进程改名时按它检查，界面按它预览"改之前 → 改之后"，两边算出来一样。
// 扩展名不让改：.png 改成 .jpg 不会让文件变成 jpg，只会让程序认错它。

/** 文件名拆成能改的部分和扩展名（带点）。没有扩展名、以点开头的（.gitignore）整个都是能改的部分。 */
export function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.')
  return i > 0 ? { base: name.slice(0, i), ext: name.slice(i) } : { base: name, ext: '' }
}

/** macOS 上一个文件名最多 255 个字节（UTF-8，一个汉字 3 个字节）。 */
const MAX_BYTES = 255

/**
 * 用户写的名字整理成能跨系统使用的：替换保留字符和设备名、去掉首尾无效字符。
 * 换完是空的、太长的，抛出原因。
 */
export function cleanBase(base: string): string {
  // eslint-disable-next-line no-control-regex
  const s = portableFileName(base).replace(/^\.+/, '').trim()
  if (!s) throw new Error('名字不能是空的')
  return s
}

/** 新的文件名：整理过的名字加上原来的扩展名。不能用时抛出原因。 */
export function renamed(oldName: string, base: string): string {
  const name = portableFileName(cleanBase(base) + splitName(oldName).ext)
  if (new TextEncoder().encode(name).length > MAX_BYTES) throw new Error('名字太长了')
  return name
}

/** 批量改名的规则。 */
export type RenameRule =
  /** 统一命名、加序号：海报_01、海报_02……序号的位数按最大的那个补零（至少两位）。 */
  | { type: 'number'; base: string; start: number }
  /** 把名字里的一段文字换掉（全部出现的地方）。 */
  | { type: 'replace'; find: string; with: string }

export interface PlannedRename {
  id: string
  from: string
  /** 改成的完整文件名；不能用时没有，error 说明原因。 */
  to?: string
  /** 改成的、不含扩展名的部分（交给核心进程的就是它）。 */
  base?: string
  error?: string
}

/** 按规则算出每一项改成什么。items 的顺序就是序号的顺序。名字没变的 to 等于 from。 */
export function planRenames(items: { id: string; name: string }[], rule: RenameRule): PlannedRename[] {
  const width = rule.type === 'number' ? Math.max(2, String(rule.start + items.length - 1).length) : 0
  return items.map((item, i) => {
    const { base } = splitName(item.name)
    const next =
      rule.type === 'number'
        ? [rule.base.trim(), String(rule.start + i).padStart(width, '0')].filter(Boolean).join('_')
        : rule.find
          ? base.split(rule.find).join(rule.with)
          : base
    try {
      return { id: item.id, from: item.name, to: renamed(item.name, next), base: next }
    } catch (e) {
      return { id: item.id, from: item.name, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
