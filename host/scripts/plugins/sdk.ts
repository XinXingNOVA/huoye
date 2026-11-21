import { resolve } from 'node:path'

/** 外部开发导入名 → 已有公共入口；不包含宿主私有模块。 */
export function sdkSources(root: string): Record<string, string> {
  const files: Record<string, string> = {
    'local-service': 'plugin-api/local-service.ts',
    ingest: 'plugin-api/ingest.ts',
    'content-selection': 'plugin-api/content-selection.ts', 'ui/selection': 'plugin-api/ui/selection.tsx',
    urls: 'plugin-api/urls.ts', format: 'plugin-api/format.ts', 'pdf-text': 'plugin-api/pdf-text.ts', blocks: 'shared/blocks.ts', query: 'shared/query.ts',
    files: 'plugin-api/files.ts', core: 'plugin-api/core.ts', operations: 'plugin-api/operations.ts', queries: 'plugin-api/queries.ts',
    'core/contracts': 'plugin-api/core/contracts.ts', 'core/process': 'plugin-api/core/process.ts',
    'core/images': 'plugin-api/core/images.ts', 'core/playback': 'plugin-api/core/playback.ts',
    'ui/contracts': 'plugin-api/ui/contracts.ts', 'ui/entities': 'plugin-api/ui/entities.ts', 'ui/editing': 'plugin-api/ui/editing.ts', 'ui/file-editing': 'plugin-api/ui/file-editing.ts',
    'ui/extensions': 'plugin-api/ui/extensions.tsx',
    'ui/local-state': 'plugin-api/ui/local-state.ts',
    'ui/settings': 'plugin-api/ui/settings.ts', 'ui/commands': 'plugin-api/ui/commands.ts',
    'ui/plugin-presets': 'plugin-api/ui/plugin-presets.ts',
    'ui/workbench-presets': 'plugin-api/ui/workbench-presets.ts',
    'ui/collection': 'plugin-api/ui/collection.tsx',
    'ui/data': 'plugin-api/ui/data.ts', 'ui/media': 'plugin-api/ui/media.tsx',
    'ui/locale': 'plugin-api/ui/locale.ts', 'ui/kit': 'plugin-api/ui/kit.tsx', 'ui/fields': 'plugin-api/ui/fields.tsx', 'ui/widgets': 'plugin-api/ui/widgets.tsx',
    'ui/hooks': 'plugin-api/ui/hooks.ts', 'ui/navigation': 'plugin-api/ui/navigation.ts',
    'ui/playback': 'plugin-api/ui/playback.ts',
    'ui/search': 'plugin-api/ui/search.tsx', 'ui/layout': 'plugin-api/ui/layout.ts'
  }
  return Object.fromEntries(Object.entries(files).map(([key, path]) => [`@resource-manager/plugin-api/${key}`, resolve(root, 'src', path)]))
}
export const uiExports: Record<string, string[]> = {
  'ui/locale': ['pluginMessages', 'useLocale', 'kindTitle', 'fieldTitle', 'enumTitle'],
  'ui/extensions': ['ExtensionBoundary'],
  'ui/local-state': ['usePluginState'],
  'ui/selection': ['ContentSurface', 'useContentSelection', 'selectedText', 'selectionRect'],
  'ui/data': ['useEntityState', 'useEntity', 'useGone', 'useKinds'],
  'ui/collection': ['ResourceCollection', 'collectionQuery'],
  'ui/media': ['ResourceBadge', 'ResourceCard', 'ResourceCover', 'Embed', 'RESOURCE_CARD_CAPTION_HEIGHT'],
  'ui/fields': ['editable', 'writeField', 'editsInPopover', 'editsInPlace', 'FieldEditor', 'BlockEditor'],
  'ui/kit': ['Button', 'IconButton', 'Icon', 'Input', 'TextArea', 'Select', 'Switch', 'Checkbox', 'SegmentedControl', 'Badge', 'Tag', 'Popover', 'DropdownMenu', 'Dialog', 'ConfirmDialog', 'Tooltip', 'SectionHeader', 'StatBar', 'Toolbar', 'ToolbarSeparator', 'ListRow', 'TreeRow', 'EmptyState', 'Tabs'],
  'ui/widgets': ['formatBytes', 'formatDuration', 'isEnter', 'formatDate', 'FieldValue', 'AutoSaveText', 'acceleratorLabel', 'Overlay', 'UiPortal', 'useUiDocument'],
  'ui/hooks': ['useKeys', 'useUiEffect', 'useUiFrame'], 'ui/navigation': ['useNeighbors'],
  'ui/playback': ['usePlaybackRecord'],
  'ui/search': ['SearchContext', 'useSearch', 'useSearchText', 'useSnippet', 'Marked', 'markTermsIn']
}
