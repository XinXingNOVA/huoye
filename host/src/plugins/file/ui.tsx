import type { UiPlugin, ViewProps, InspectorSectionProps } from '../../plugin-api/ui/contracts'
import { formatBytes } from '../../plugin-api/ui/widgets'
import { RenameDialog, FileTitleEditor } from './rename'
import { FileStorageSection } from './storage'

function FileCover({ view }: ViewProps) {
  const ext = String(view.blocks.file.data.ext || '?').toUpperCase()
  return (
    <div className="cover-file">
      <span>{ext}</span>
    </div>
  )
}

function FileSection({ view, host, summarizedFields = [] }: InspectorSectionProps) {
  const f = view.blocks.file.data
  const shown = (field: string) => summarizedFields.some(s => s.kind === 'file' && s.field === field)
  return (
    <dl className="props">
      {!shown('name') && <><dt>文件名</dt><dd className="breakable">{String(f.name)}</dd></>}
      {!shown('ext') && <><dt>格式</dt>
      <dd>
        <button className="link" onClick={() => host.toggleFilter({ op: 'eq', kind: 'file', field: 'ext', value: String(f.ext) })}>
          {String(f.ext || '无')}
        </button>
      </dd></>}
      {!shown('size') && <><dt>大小</dt><dd>{formatBytes(Number(f.size))}</dd></>}
      <FileStorageSection key={`${view.id}:${f.path}`} id={view.id} host={host} />

    </dl>
  )
}

export const fileUi: UiPlugin = {
  id: 'file',
  covers: [{ priority: 100, match: (v) => !!v.blocks.file, Component: FileCover }],
  titles: [
    {
      priority: 100,
      TitleEditor: FileTitleEditor,
      get: (v) => (v.blocks.file ? String(v.blocks.file.data.name) : undefined),
      // 标题是文件名，改标题就是给文件改名（设计文档 11.14）
      rename: (views, host) => host.showDialog((close) => <RenameDialog views={views} host={host} close={close} />)
    }
  ],
  dragOut: [{ priority: 100, get: (v, host) => (v.blocks.file ? host.abs(String(v.blocks.file.data.path)) : undefined) }],
  sections: [{ id: 'file', title: '文件', order: 10, kinds: ['file'], actions: ['file.storage'], Component: FileSection }],
  facets: [{ title: '格式', kind: 'file', field: 'ext', order: 20 }],
  actions: [
    {
      id: 'file.rename',
      group: 20,
      order: -1,
      title: (vs) => (vs.length > 1 ? `重命名 ${vs.length} 项…` : '重命名…'),
      accelerator: 'Enter',
      when: (vs) => vs.every((v) => v.blocks.file && !v.deletedAt),
      run: (vs, host) => host.rename(vs.map((v) => v.id))
    },
    {
      id: 'file.reveal', inspector: 'shortcut', icon: 'folder',
      group: 30,
      order: 10,
      title: '在访达中显示',
      when: (vs) => vs.length === 1 && !!vs[0].blocks.file,
      run: ([v], host) => host.reveal(host.abs(String(v.blocks.file.data.path)))
    }
  ]
}

export { fileUi as plugin }
