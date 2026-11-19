import './tags.css'
import { useEffect, useState } from 'react'
import type { UiPlugin, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { isEnter } from '@resource-manager/plugin-api/ui/widgets'

function TagsSection({ view, host }: ViewProps) {
  const tags = (view.blocks.tags?.data.values as string[] | undefined) ?? []
  const [input, setInput] = useState('')
  const [known, setKnown] = useState<string[]>([])

  useEffect(() => {
    host.core.facet('tags', 'values').then((items) => setKnown(items.map((i) => i.value)))
  }, [host, tags.length])

  const update = (add: string[], remove: string[] = []) =>
    host.core.run('tags', 'update', { ids: [view.id], add, remove }).catch(e => host.notify(String(e)))

  const add = () => {
    const parts = input
      .split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^#/, ''))
      .filter(Boolean)
    if (parts.length) void update(parts)
    setInput('')
  }

  return (
    <div className="tags">
      {tags.map((t) => (
        <span key={t} className="chip">
          <button className="chip-label" title="按这个标签筛选" onClick={() => host.toggleFilter({ op: 'eq', kind: 'tags', field: 'values', value: t })}>
            {t}
          </button>
          <button className="chip-x" title="移除" onClick={() => void update([], [t])}>
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        list={`tags-${view.id}`}
        value={input}
        placeholder={tags.length ? '' : '添加标签，回车确认'}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (isEnter(e)) {
            e.preventDefault()
            add()
          } else if (e.key === 'Backspace' && !input && tags.length) {
            void update([], [tags[tags.length - 1]])
          }
        }}
        onBlur={() => input && add()}
      />
      <datalist id={`tags-${view.id}`}>
        {known
          .filter((k) => !tags.includes(k))
          .map((k) => (
            <option key={k} value={k} />
          ))}
      </datalist>
    </div>
  )
}

export const tagsUi: UiPlugin = {
  id: 'tags',
  sections: [{ id: 'tags', title: '标签', order: 40, kinds: ['tags'], match: () => true, Component: TagsSection }]
}

export { tagsUi as plugin }
