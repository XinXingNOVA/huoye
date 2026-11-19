import type { CorePlugin } from '../../plugin-api/core/contracts'
import { blocks } from './blocks'

export const plugin: CorePlugin = { id: 'reviewmemo', version: 1, blocks }
