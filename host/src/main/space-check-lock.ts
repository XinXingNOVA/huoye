// 工作台和外部接入共用空间的核对／处置互斥范围。
const active = new Set<string>()
export function reserveSpaceCheck(spaceId: string) {
  if (active.has(spaceId)) throw new Error('[SPACE_CHECK_BUSY] 此空间正在核对或处置')
  active.add(spaceId)
  return () => { active.delete(spaceId) }
}
