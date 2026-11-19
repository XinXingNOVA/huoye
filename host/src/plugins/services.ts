import { catalogEntries } from '../shared/plugin-catalog'
import { PLUGINS } from './manifest'
import { entries } from './generated/service'

export const servicePlugins = catalogEntries(PLUGINS, 'service', entries)
