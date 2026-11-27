import { useLayoutEffect, useMemo, type FC } from 'react'
import type { ToolViewProps } from '../../../plugin-api/ui/page-context'
import { pageImageReads } from '../app/page-image-reads'
import { toolOwner } from '../ui-registry'

export function ToolContent({ id, Component, ...props }: ToolViewProps & { id: string; Component: FC<ToolViewProps> }) {
  const { host, active, context } = props
  const selection = JSON.stringify(context?.selection ?? [])
  const resources = useMemo(() => pageImageReads(host.core, host.url, toolOwner(id) ?? '', active),
    [host.core, id, active, context?.pageId, selection])
  useLayoutEffect(() => {
    if (active) resources.open()
    return resources.close
  }, [resources, active])
  return <Component {...props} imageReads={resources.reads} capabilities={resources.capabilities}/>
}
