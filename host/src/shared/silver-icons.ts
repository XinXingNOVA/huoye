import type { IconDrawing, ThemeIcons } from './theme-icons'

// 银盐画册的印刷图标，共用方形线端与斜接。
type Shape = IconDrawing['shapes'][number]
function plate(shapes: Shape[], strokeWidth = '1.75'): IconDrawing {
  return { viewBox: '0 0 24 24', shapes: shapes.map(({ tag, attrs }) => ({ tag,
    attrs: { fill: 'none', stroke: 'currentColor', strokeWidth, strokeLinecap: 'square', strokeLinejoin: 'miter', ...attrs } })) }
}

export const silverIcons: ThemeIcons = {
  book: plate([
    { tag: 'polygon', attrs: { points: '2.5,4.5 9.5,4.5 12,6.5 14.5,4.5 21.5,4.5 21.5,18.5 14.5,18.5 12,20.5 9.5,18.5 2.5,18.5' } },
    { tag: 'line', attrs: { x1: '12', y1: '6.5', x2: '12', y2: '20.5' } },
    { tag: 'line', attrs: { x1: '15', y1: '9', x2: '18.5', y2: '9', strokeWidth: '1.4' } },
    { tag: 'line', attrs: { x1: '15', y1: '12.25', x2: '18.5', y2: '12.25', strokeWidth: '1.4' } },
    { tag: 'line', attrs: { x1: '15', y1: '15.5', x2: '17.25', y2: '15.5', strokeWidth: '1.4' } }
  ]),
  filter: plate([
    { tag: 'polygon', attrs: { points: '3,4 21,4 21,6.25 14.5,12.75 14.5,20 9.5,18 9.5,12.75 3,6.25' } }
  ]),
  folder: plate([
    { tag: 'polygon', attrs: { points: '2.5,5 9.5,5 11.5,7.5 21.5,7.5 21.5,19.5 2.5,19.5' } },
    { tag: 'line', attrs: { x1: '2.5', y1: '10.5', x2: '21.5', y2: '10.5', strokeWidth: '1.4' } }
  ]),
  grid: plate([
    { tag: 'rect', attrs: { x: '3', y: '3', width: '7', height: '7' } },
    { tag: 'rect', attrs: { x: '14', y: '3', width: '7', height: '7' } },
    { tag: 'rect', attrs: { x: '3', y: '14', width: '7', height: '7' } },
    { tag: 'rect', attrs: { x: '14', y: '14', width: '7', height: '7' } },
    { tag: 'rect', attrs: { x: '5.5', y: '5.5', width: '2', height: '2', fill: 'currentColor', stroke: 'none' } }
  ]),
  import: plate([
    { tag: 'line', attrs: { x1: '12', y1: '3.5', x2: '12', y2: '15' } },
    { tag: 'polyline', attrs: { points: '7.5,10.75 12,15.25 16.5,10.75' } },
    { tag: 'polyline', attrs: { points: '3.5,15.5 3.5,20.5 20.5,20.5 20.5,15.5' } }
  ]),
  layout: plate([
    { tag: 'rect', attrs: { x: '3', y: '4', width: '18', height: '16' } },
    { tag: 'line', attrs: { x1: '9', y1: '4', x2: '9', y2: '20' } },
    { tag: 'line', attrs: { x1: '9', y1: '11.5', x2: '21', y2: '11.5' } },
    { tag: 'rect', attrs: { x: '5', y: '6.5', width: '2', height: '2', fill: 'currentColor', stroke: 'none' } }
  ]),
  list: plate([
    { tag: 'rect', attrs: { x: '3', y: '5', width: '2.5', height: '2.5', fill: 'currentColor', stroke: 'none' } },
    { tag: 'rect', attrs: { x: '3', y: '10.75', width: '2.5', height: '2.5', fill: 'currentColor', stroke: 'none' } },
    { tag: 'rect', attrs: { x: '3', y: '16.5', width: '2.5', height: '2.5', fill: 'currentColor', stroke: 'none' } },
    { tag: 'line', attrs: { x1: '8.5', y1: '6.25', x2: '21', y2: '6.25' } },
    { tag: 'line', attrs: { x1: '8.5', y1: '12', x2: '21', y2: '12' } },
    { tag: 'line', attrs: { x1: '8.5', y1: '17.75', x2: '21', y2: '17.75' } }
  ]),
  plus: plate([
    { tag: 'line', attrs: { x1: '12', y1: '4.5', x2: '12', y2: '19.5' } },
    { tag: 'line', attrs: { x1: '4.5', y1: '12', x2: '19.5', y2: '12' } }
  ], '1.9'),
  search: plate([
    { tag: 'circle', attrs: { cx: '10.5', cy: '10.5', r: '6.75' } },
    { tag: 'line', attrs: { x1: '9', y1: '10.5', x2: '12', y2: '10.5', strokeWidth: '1.25' } },
    { tag: 'line', attrs: { x1: '10.5', y1: '9', x2: '10.5', y2: '12', strokeWidth: '1.25' } },
    { tag: 'line', attrs: { x1: '15.75', y1: '15.75', x2: '20.75', y2: '20.75', strokeWidth: '2.25' } }
  ]),
  split: plate([
    { tag: 'rect', attrs: { x: '3', y: '4', width: '18', height: '16' } },
    { tag: 'line', attrs: { x1: '12', y1: '4', x2: '12', y2: '20' } },
    { tag: 'line', attrs: { x1: '5.75', y1: '8.5', x2: '9.25', y2: '8.5', strokeWidth: '1.4' } },
    { tag: 'line', attrs: { x1: '14.75', y1: '8.5', x2: '18.25', y2: '8.5', strokeWidth: '1.4' } },
    { tag: 'line', attrs: { x1: '14.75', y1: '12', x2: '18.25', y2: '12', strokeWidth: '1.4' } }
  ]),
  tag: plate([
    { tag: 'polygon', attrs: { points: '3,3 11.5,3 21,12.5 12.5,21 3,11.5' } },
    { tag: 'rect', attrs: { x: '6.5', y: '6.5', width: '2.5', height: '2.5', fill: 'currentColor', stroke: 'none' } }
  ]),
  text: plate([
    { tag: 'polygon', attrs: { points: '4.5,3 14.5,3 19.5,8 19.5,21 4.5,21' } },
    { tag: 'polyline', attrs: { points: '14.5,3 14.5,8 19.5,8' } },
    { tag: 'line', attrs: { x1: '8', y1: '11.5', x2: '16', y2: '11.5', strokeWidth: '1.5' } },
    { tag: 'line', attrs: { x1: '8', y1: '14.75', x2: '16', y2: '14.75', strokeWidth: '1.5' } },
    { tag: 'line', attrs: { x1: '8', y1: '18', x2: '13', y2: '18', strokeWidth: '1.5' } }
  ])
}
