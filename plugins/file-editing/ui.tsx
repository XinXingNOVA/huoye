import type { UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { FileEditingProvider } from './state'
import { FileEditingControls, startFileEditing } from './editing'
import { editingTabType, FileEditingNav, FileEditingBadge } from './view'

export const plugin: UiPlugin = {
  id: 'file-editing',
  windowProviders: [{ id: 'file-editing.state', order: 20, Component: FileEditingProvider }],
  fileEditingUis: [{ id: 'file-editing.editor', priority: 100, open: (request, host) => startFileEditing(host, request.id, request.intent === 'replace', request.intent === 'choose-editor') }],
  navs: [{ id: 'file-editing.nav', order: 810, Component: FileEditingNav }],
  tabTypes: [editingTabType],
  badges: [{ id: 'file-editing.state', order: 0, Component: FileEditingBadge }],
  sections: [{ id: 'file-editing.controls', title: '文件编辑', order: -10, kinds: [], match: view => !!view.blocks.file,
    Component: ({ view, host }) => <FileEditingControls id={view.id} host={host} onlyActive /> }]
}
