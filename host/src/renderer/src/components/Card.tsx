import { memo } from 'react'
import { useEntity } from '../../../plugin-api/ui/data'
import { ResourceBadge, type ResourceCardProps } from '../../../plugin-api/ui/media'
import { Marked, useSearch, useSnippet } from '../search'
import { badgeList, coverFor, titleFor } from '../ui-registry'
import { GenericCover } from './DataDetails'

export const Card = memo(function Card({ id, host, selected, highlighted, style, onPointer, onOpen, dragIds }: ResourceCardProps) {
  const view = useEntity(id)
  const cover = view && coverFor(view)
  const failed = view && Object.keys(view.failures).length > 0
  // 在搜索：封面底部显示命中的那一句
  const snippet = useSnippet(host, view, useSearch())

  return (
    <div
      className={`card${selected ? ' selected' : ''}${highlighted ? ' ai-highlighted' : ''}`}
      data-entity-id={id}
      style={style}
      onMouseDown={(e) => onPointer(id, e)}
      onDoubleClick={() => onOpen(id)}
      draggable={!!view}
      onDragStart={(e) => host.startDrag(e, dragIds?.(id) ?? [id])}
    >
      <div className="card-cover">
        {view ? (cover ? <cover.Component view={view} host={host} /> : <GenericCover view={view} host={host} />) : <div className="cover-pending" />}
        {view && (
          <div className="badges">
            {badgeList.map((badge, i) => {
              if (badge.Component) return <badge.Component key={badge.id} view={view} host={host} />
              const value = badge.get(view)
              return value && <ResourceBadge key={badge.id ?? `legacy-${i}`} color={value.color}>{value.text}</ResourceBadge>
            })}
          </div>
        )}
        {snippet && (
          <div className="card-snippet">
            <span className="card-snippet-label">{snippet.label}</span>
            <Marked text={snippet.text} marks={snippet.marks} />
          </div>
        )}
      </div>
      <div className="card-caption" title={view ? titleFor(view) : ''}>
        {failed && <span className="badge-failed" title={Object.values(view.failures).join('\n')}>!</span>}
        {view ? titleFor(view) : ''}
      </div>
    </div>
  )
})
