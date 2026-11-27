import type { ReceiveItem } from '../../shared/transfer'
import type { CoreClient } from './core-client'
import type { ImportInput } from '../../shared/ingest-input'
import type { TransferEntry } from './transfer-input'
import { uiText } from '../../shared/i18n/interface-display'

/** 目标消失后，只提示确实写入过的去向。 */
export function undeliveredImportNotice(items: readonly ReceiveItem[]): string | undefined {
  const library = items.some(i => i.status === 'created' || i.status === 'restored')
  const space = items.some(i => i.status === 'saved')
  if (library && space) return uiText("接收位置已不可用，可在仓库和文件空间查看已保存的内容")
  if (library) return uiText("接收位置已不可用，可在仓库查看已收录的素材")
  if (space) return uiText("接收位置已不可用，文件已保存到文件空间")
}

/** 每个输入保留自己的槽位。文件夹可以对应多个结果，同一 ID 可以出现多次。 */
export async function receiveItems(entries: TransferEntry[], core: Pick<CoreClient, 'query' | 'importToLibrary'>,
  identify: (paths: string[]) => (string | null)[]): Promise<ReceiveItem[]> {
  const slots: ReceiveItem[][] = entries.map(() => [])
  const resolved = entries.slice()
  const paths = entries.flatMap((entry, index) => 'path' in entry ? [{ path: entry.path, index }] : [])
  for (let start = 0; start < paths.length; start += 1000) {
    const chunk = paths.slice(start, start + 1000)
    try {
      const ids = identify(chunk.map(p => p.path))
      chunk.forEach(({ index }, i) => { if (ids[i]) resolved[index] = { id: ids[i]! } })
    } catch (error) {
      for (const { index } of chunk) resolved[index] = { error: String(error) }
    }
  }
  const refs: { id: string; index: number }[] = [], inputs: ImportInput[] = [], positions: number[] = []
  for (const [index, entry] of resolved.entries()) {
    if ('error' in entry) slots[index].push({ index, status: 'failed', message: entry.error })
    else if ('id' in entry) refs.push({ id: entry.id, index })
    else {
      inputs.push('input' in entry ? entry.input : { type: 'file', path: entry.path })
      positions.push(index)
    }
  }
  if (refs.length) {
    try {
      const live = new Set((await core.query({ ids: [...new Set(refs.map(r => r.id))] })).ids)
      for (const { id, index } of refs) slots[index].push(live.has(id)
        ? { index, status: 'reference', id } : { index, status: 'failed', message: uiText("素材已不存在") })
    } catch (error) {
      for (const { index } of refs) slots[index].push({ index, status: 'failed', message: String(error) })
    }
  }
  if (inputs.length) {
    try {
      const report = await core.importToLibrary(inputs, { requestId: crypto.randomUUID() })
      const indexOf = (expanded: number) => positions[report.expandedFrom?.[expanded] ?? expanded]
      const results = new Map<number, ReceiveItem>()
      for (const row of report.saved) results.set(row.index, { index: indexOf(row.index), status: 'saved' })
      for (const row of report.items) results.set(row.index, { index: indexOf(row.index), status: row.outcome, id: row.id })
      for (const row of report.errors) results.set(row.index, { index: indexOf(row.index), status: 'failed', message: row.message })
      for (const [, result] of [...results].sort(([a], [b]) => a - b)) slots[result.index].push(result)
    } catch (error) {
      for (const index of positions) slots[index].push({ index, status: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }
  return slots.flatMap((items, index) => items.length ? items : [{ index, status: 'failed' as const, message: uiText("没有可收录的输入") }])
}
