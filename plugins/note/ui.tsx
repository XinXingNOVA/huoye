import type { UiPlugin, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { AutoSaveText } from '@resource-manager/plugin-api/ui/widgets'

import { pluginMessages, useLocale } from '@resource-manager/plugin-api/ui/locale'

const msg = pluginMessages('note')

function NoteSection({ view, host }: ViewProps) {
  useLocale()
  return (
    <AutoSaveText
      value={String(view.blocks.note?.data.text ?? '')}
      placeholder={msg('为什么存它？写点什么…')}
      onSave={(text) => {
        // 写了内容就挂上笔记块，清空就移除
        if (text.trim()) host.core.put(view.id, 'note', { text })
        else if (view.blocks.note) host.core.remove(view.id, 'note')
      }}
    />
  )
}

export const noteUi: UiPlugin = {
  id: 'note',
  // 笔记分区始终显示：随手就能写，写下第一个字时才挂上数据块
  sections: [{ id: 'note', get title() { return msg("笔记") }, order: 50, kinds: ['note'], match: () => true, Component: NoteSection }]
}

export { noteUi as plugin }
