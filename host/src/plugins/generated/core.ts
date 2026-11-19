// 自动生成：npm run plugins:generate。请修改各插件的 plugin.json / distribution.json，勿手工编辑。
import type { CorePlugin } from '../../plugin-api/core/contracts'
import { plugin as p0 } from "../file/core.ts"
import { plugin as p1 } from "../preview/core.ts"
import { plugin as p2 } from "../image/core.ts"
import { plugin as p3 } from "../video/core.ts"
import { plugin as p4 } from "../audio/core.ts"
import { plugin as p5 } from "../pdf/core.ts"
import { plugin as p6 } from "../text/core.ts"
import { plugin as p7 } from "../view/core.ts"

export const entries: { id: string; plugin: CorePlugin }[] = [
  { id: "file", plugin: p0 },
  { id: "preview", plugin: p1 },
  { id: "image", plugin: p2 },
  { id: "video", plugin: p3 },
  { id: "audio", plugin: p4 },
  { id: "pdf", plugin: p5 },
  { id: "text", plugin: p6 },
  { id: "view", plugin: p7 }
]
