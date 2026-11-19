import './style.css'
import type { ApplicationUiPlugin } from '../../plugin-api/ui/application'
import { McpSettings } from './McpSettings'

export const plugin: ApplicationUiPlugin = {
  id: 'mcp',
  settingsSections: [{ id: 'mcp.connection', order: 10, Component: McpSettings }]
}
