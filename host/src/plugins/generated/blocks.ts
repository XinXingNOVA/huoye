// 自动生成：npm run plugins:generate。请修改各插件的 plugin.json / distribution.json，勿手工编辑。
import type { BlockKind } from '../../shared/blocks'
import { blocks as b0 } from "../file/blocks.ts"
import { blocks as b1 } from "../preview/blocks.ts"
import { blocks as b2 } from "../image/blocks.ts"
import { blocks as b3 } from "../video/blocks.ts"
import { blocks as b4 } from "../audio/blocks.ts"
import { blocks as b5 } from "../pdf/blocks.ts"
import { blocks as b6 } from "../text/blocks.ts"
import { blocks as b7 } from "../view/blocks.ts"

export const entries: { id: string; blocks: BlockKind[] }[] = [
  { id: "file", blocks: b0 },
  { id: "preview", blocks: b1 },
  { id: "image", blocks: b2 },
  { id: "video", blocks: b3 },
  { id: "audio", blocks: b4 },
  { id: "pdf", blocks: b5 },
  { id: "text", blocks: b6 },
  { id: "view", blocks: b7 }
]
