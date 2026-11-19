import { useEffect } from 'react'
import { useEntity } from '../entity-cache'
import type { TabProps, TabType, UiHost } from '../plugin'
import { DataDetailsById } from '../components/DataDetails'

interface Params { id: string }
function DataTab({ params, host, setFocus, expose }: TabProps<Params>) {
  const view = useEntity(params.id)
  const contextTitle = view ? host.title(view) : '数据详情'
  useEffect(() => expose({ context: { title: contextTitle } }), [expose, contextTitle])
  useEffect(() => setFocus([params.id]), [params.id, setFocus])
  return <div className="data-tab"><DataDetailsById id={params.id} host={host} /></div>
}
function DataTitle({ params, host }: { params: Params; host: UiHost }) {
  const view = useEntity(params.id)
  return <>{view ? host.title(view) : '数据详情'}</>
}
export const dataTabType: TabType<Params> = { id: 'data.details', Title: DataTitle, Component: DataTab, key: p => p.id }
