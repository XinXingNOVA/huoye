import type { CorePlugin } from '../../../src/plugin-api/core/contracts'
import { blocks } from './note-blocks'

export const notePlugin: CorePlugin = {
  id: 'note',
  version: 1,
  blocks,
  exportSections: [{
    id: 'note.text', kind: 'note', fields: ['text'], order: 20,
    render(data) {
      const text = String(data.text ?? '').trim()
      return { properties: text ? [{ field: 'text', label: '笔记', value: text, index: false }] : [],
        markdown: text ? text.split('\n').map(line => `> ${line}`).join('\n') : undefined,
        inline: text.replace(/\n+/g, ' ') }
    }
  }]
}

export { notePlugin as plugin }
