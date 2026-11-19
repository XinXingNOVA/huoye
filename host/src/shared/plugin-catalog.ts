import type { BlockKind } from './blocks'
import type { PluginInfo } from './plugin-plan'

/** 在各自运行环境校验声明与实际导出，避免 ID 对错却悄悄装配。 */
export function catalogEntries<T extends { id: string }>(manifest: PluginInfo[], side: 'core' | 'ui' | 'service', entries: { id: string; plugin: T }[]): T[] {
  const expected = manifest.filter((p) => p.entries?.[side]).map((p) => p.id)
  const actual = entries.map((p) => p.id)
  if (new Set(actual).size !== actual.length || expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) throw new Error(`${side} 入口清单与声明不一致，请重新生成`)
  return entries.map(({ id, plugin }) => {
    if (!plugin || id !== plugin.id) throw new Error(`插件 ${id} 的 ${side} 入口导出 ID 为 ${plugin?.id}`)
    return plugin
  })
}

export function catalogBlocks(manifest: PluginInfo[], entries: { id: string; blocks: BlockKind[] }[]): BlockKind[] {
  const expected = manifest.filter((p) => p.entries?.blocks).map((p) => p.id)
  if (expected.length !== entries.length || expected.some((id, i) => entries[i].id !== id)) throw new Error('数据块入口清单与声明不一致，请重新生成')
  const seen = new Set<string>()
  for (const { id, blocks } of entries) {
    if (!Array.isArray(blocks)) throw new Error(`插件 ${id} 的 blocks 入口必须导出数组`)
    for (const block of blocks) {
      if (block.plugin !== id) throw new Error(`数据块 ${block.id} 的归属 ${block.plugin} 与插件 ${id} 不符`)
      if (seen.has(block.id)) throw new Error(`数据块 ID 重复：${block.id}`)
      seen.add(block.id)
    }
  }
  return entries.flatMap((p) => p.blocks)
}
