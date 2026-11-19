// 自动生成：npm run plugins:generate。请修改各插件的 plugin.json / distribution.json，勿手工编辑。
import type { UiPlugin } from '../../plugin-api/ui/contracts'
import { plugin as p0 } from "../file/ui.tsx"
import { plugin as p1 } from "../preview/ui.tsx"
import { plugin as p2 } from "../image/ui.tsx"
import { plugin as p3 } from "../video/ui.tsx"
import { plugin as p4 } from "../audio/ui.tsx"
import { plugin as p5 } from "../pdf/ui.tsx"
import { plugin as p6 } from "../text/ui.tsx"

export const entries: { id: string; plugin: UiPlugin }[] = [
  { id: "file", plugin: p0 },
  { id: "preview", plugin: p1 },
  { id: "image", plugin: p2 },
  { id: "video", plugin: p3 },
  { id: "audio", plugin: p4 },
  { id: "pdf", plugin: p5 },
  { id: "text", plugin: p6 }
]
