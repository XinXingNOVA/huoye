import type { ResourceCoverProps } from '../../../plugin-api/ui/media'
import { coverFor } from '../ui-registry'
import { GenericCover } from './DataDetails'

export function ResourceCover({ view, host, fallback }: ResourceCoverProps) {
  const cover = coverFor(view)
  return cover ? <cover.Component view={view} host={host} /> : <>{fallback === undefined ? <GenericCover view={view} host={host} /> : fallback}</>
}
