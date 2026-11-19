import { libraryPageWorkbench } from '../page-workbench'
import { useEffect } from 'react'
import type { TabProps, TabType } from '../plugin'
import { LibraryFileSpaces } from '../components/FileSpaces'
function FileSpacesTab({ host, setFocus, active, params }: TabProps) {
  useEffect(() => setFocus([]), [setFocus])
  return <LibraryFileSpaces host={host} visible={active} spaceId={typeof params.spaceId === 'string' ? params.spaceId : undefined} />
}
export const fileSpacesTabType: TabType = { id: 'file-spaces', workbench: { ...libraryPageWorkbench, describe: () => ({ title: '文件空间' }) }, Title: () => <>文件空间</>, Component: FileSpacesTab }
