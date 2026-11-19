import { z } from 'zod'
import type { IngestMetadataDefinition } from '@resource-manager/plugin-api/ingest'

export const ingestMetadata: IngestMetadataDefinition[] = [{
  id: 'tags.add', title: '导入时添加标签',
  description: '向新建、已有或恢复的素材追加具体标签，去重且保留其他标签；不修改标签分组。',
  input: z.object({ add: z.array(z.string().trim().min(1).max(100)).min(1).max(20) }).strict(),
  apply(ctx, input) {
    const current = ctx.blocksOf().tags?.data
    const previous = (current?.values ?? []) as string[]
    const next = [...new Set([...previous, ...(input.add as string[])])]
    // 即使值未变也声明本意图写入 tags，保证与 tags.set 互斥；Store 会跳过相同数据。
    ctx.put('tags', { ...current, values: next })
    return { status: next.length === previous.length ? 'unchanged' : 'applied' }
  }
}, {
  id: 'tags.set', title: '导入时设置标签',
  description: '用给定列表整体替换素材标签，去掉首尾空白并去重；空数组表示清空。调用者负责避免同组互斥值；与 tags.add 不能同时使用。',
  input: z.object({ values: z.array(z.string().trim().min(1).max(100)).max(100) }).strict(),
  apply(ctx, input) {
    const current = ctx.blocksOf().tags?.data
    const previous = (current?.values ?? []) as string[]
    const next = [...new Set(input.values as string[])]
    const unchanged = !!current && next.length === previous.length && next.every((value, index) => value === previous[index])
    // 同值 put 不改数据序号，但仍参与本次 metadata 的重复写入检查。
    ctx.put('tags', { ...current, values: next })
    return { status: unchanged ? 'unchanged' : 'applied' }
  }
}]
