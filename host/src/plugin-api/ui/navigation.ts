import { uiText } from '../../shared/i18n/interface-display'
// 单素材标签页（播放器、图片查看器）在打开它的列表里切上一个 / 下一个。
// 第二个用到它的标签页出现时从播放器里抽出来（共性候选，设计文档 10.10）。

import { useEffect, useState } from 'react'
import type { Query } from '../../shared/query'
import type { UiHost } from './contracts'

/** UI 导航来源；orderedIds 是当前呈现顺序的快照，不属于仓库查询协议。 */
export interface NavigationList extends Query {
  orderedIds?: string[]
}

/** 读取同类型素材；有显式顺序时，先限定范围，再按快照顺序排列。 */
export async function navigationIds(host: Pick<UiHost, 'core'>, list: NavigationList, kinds: string[]): Promise<string[]> {
  const { orderedIds, ...query } = list
  const order = orderedIds && [...new Set(orderedIds)]
  const ids = order ? order.filter(id => !query.ids || query.ids.includes(id)) : query.ids
  if (ids?.length === 0) return []
  const base = { ...query, ...(ids ? { ids } : {}) }
  const parts = await Promise.all(kinds.map(kind => host.core.query({ ...base, has: [...new Set([...(base.has ?? []), kind])] }).then(r => r.ids)))
  const keep = new Set(parts.flat())
  if (order) return order.filter(id => keep.has(id))
  if (parts.length === 1) return parts[0]
  return (await host.core.query(base)).ids.filter(id => keep.has(id))
}

export interface Neighbors {
  prev?: string
  next?: string
  /** 在列表里的位置（从 0 开始），不在列表里是 -1。 */
  index: number
  total: number
}

/**
 * 列表在打开时取一次快照：从"没看完的"里打开，看完一个它就离开了这个列表，快照让顺序保持不变。
 * kind：只在挂着这种数据块的身份之间切换（例如图片查看器只切图片）；给几种时挂着其中任何一种都算
 * （例如文字标签页在摘录和文档之间切换）。
 */
export function useNeighbors(host: UiHost, list: NavigationList | undefined, id: string, kind: string | string[]): Neighbors {
  const [ids, setIds] = useState<string[]>([])
  const kinds = typeof kind === 'string' ? kind : kind.join(',')
  useEffect(() => {
    if (!list) return setIds([])
    let alive = true
    setIds([])
    navigationIds(host, list, kinds.split(',')).then(
      r => { if (alive) setIds(r) },
      error => { if (alive) host.notify(uiText("读取前后项失败：{value1}", { value1: String(String(error)) })) }
    )
    return () => {
      alive = false
    }
  }, [host, list, kinds])
  const i = ids.indexOf(id)
  return { prev: i > 0 ? ids[i - 1] : undefined, next: i >= 0 ? ids[i + 1] : undefined, index: i, total: ids.length }
}
