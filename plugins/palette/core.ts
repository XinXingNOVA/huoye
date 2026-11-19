import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'
import { extractPalette } from './lib/palette'
import { FAMILY_KIND, paletteFamilies } from './lib/color-families'
export const plugin: CorePlugin = {
  id: 'palette', version: 1, blocks,
  dataLifecycle: { version: 1 },
  systems: [{ id: 'palette.extract', priority: 60, has: ['thumb'], outputs: ['palette'],
    async run(ctx, _id, b) {
      const { data } = await ctx.images.sample({ source: String(b.thumb.data.path), maxSide: 64 }, ctx.signal)
      const swatches = extractPalette(data)
      return { palette: { colors: swatches.map(s => s.hex), weights: swatches.map(s => s.weight) } }
    }
  }, {
    id: 'palette.classify', priority: 65, has: ['palette'], inputs: ['palette.colors'], outputs: [FAMILY_KIND],
    async run(_ctx, _id, blocks) { return { [FAMILY_KIND]: { values: paletteFamilies(blocks.palette.data.colors) } } }
  }]
}
