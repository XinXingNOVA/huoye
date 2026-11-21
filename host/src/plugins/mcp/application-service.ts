import { libraryTaskSchema } from '../../shared/library-task'
import { batchReviewSchema } from '../../shared/batch-review'
import { managementSchemas, type ManagementAction } from '../../shared/application-management'
import { creationPreviewSchema, creationRequestSchema } from '../../shared/application-creation'
import { ecosystemCatalogSchema } from '../../shared/ecosystem-catalog'
import { historyPageSchema, historyDetailSchema } from '../../shared/history'
import { fileToolActions, mcpPrepareFileEditSchema } from './file-tools'
import { fileActionSchema } from '../../shared/file-actions'
import { itemLifecyclePreviewSchema, itemLifecycleSchema } from '../../shared/item-lifecycle'
import { observedImportSchema } from '../../shared/observed-import'
import { readPreviewSchema } from '../../shared/preview'
import { sourceListSchema, directoryPageSchema, directoryAdoptSchema, sourceCheckSchema } from '../../shared/source-automation'
import { spaceItemQuery } from '../../shared/space-items'
import { spacePageSchema, adoptSpaceSchema } from '../../shared/file-spaces'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ApplicationServicePlugin } from '../../plugin-api/service'
import { applicationSettingsSchema, createLibrarySchema, libraryTargetSchema } from '../../shared/application-access'
import { executeOperationSchema, parseInput, readContentSchema, readItemSchema, readItemsSchema, facetPageSchema, searchPageSchema } from '../../shared/automation'
import { listenLocal } from './local'
import { executeQuerySchema } from '../../shared/business-queries'
import { libraryStatusSchema } from '../../shared/library-status'
import { processingWaitSchema } from '../../shared/processing-status'
import { sessionReadSchema, sessionPresentSchema } from '../../shared/workbench-session'
import { developmentSchemas, setDevelopmentGrantSchema, type DevelopmentAction } from '../../shared/development-access'

export const plugin: ApplicationServicePlugin = {
  id: 'mcp',
  async start(ctx) {
    const dir = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'rm-mcp-app-'))
    if (dir) { chmodSync(dir, 0o700); ctx.onDispose(() => rmSync(dir, { recursive: true, force: true })) }
    const endpoint = dir ? join(dir, 's') : `\\\\.\\pipe\\rm-mcp-app-${process.pid}-${randomBytes(8).toString('hex')}`
    const server = await listenLocal(endpoint, async request => {
      ctx.access.authorize(request)
      const { name, args } = request
      if (Object.hasOwn(developmentSchemas, name)) return ctx.access.development(name as DevelopmentAction, args)
      if (name === 'get_library_status') return ctx.access.status(parseInput(libraryStatusSchema, args))
      if (Object.hasOwn(managementSchemas, name)) return ctx.access.manage(name as ManagementAction, args)
      if (name === 'list_libraries') { parseInput(z.object({}).strict(), args); return { libraries: ctx.access.list() } }
      if (name === 'list_ecosystem_catalog') return ctx.access.catalog(parseInput(ecosystemCatalogSchema, args))
      if (name === 'create_library') return ctx.access.create(parseInput(createLibrarySchema, args))
      if (name === 'preview_library_creation') return ctx.access.previewCreation(parseInput(creationPreviewSchema, args))
      if (name === 'get_library_creation') return ctx.access.creationStatus(parseInput(creationRequestSchema, args).requestId)
      if (name === 'resume_library_creation') return ctx.access.resumeCreation(parseInput(creationRequestSchema, args).requestId)
      if (name === 'cancel_library_creation') return ctx.access.cancelCreation(parseInput(creationRequestSchema, args).requestId)
      if (name === 'show_library') return ctx.access.open(parseInput(libraryTargetSchema, args).libraryId, false)
      if (name === 'open_library') {
        const input = parseInput(libraryTargetSchema.extend({ background: z.boolean().default(true) }), args)
        return ctx.access.open(input.libraryId, input.background)
      }
      const { libraryId, ...input } = args
      const { libraryId: id } = parseInput(libraryTargetSchema, { libraryId })
      if (name === 'get_workbench_session') return ctx.access.workbench(id, { action: 'read', input: parseInput(sessionReadSchema, input) })
      if (name === 'present_workbench') return ctx.access.workbench(id, { action: 'present', input: parseInput(sessionPresentSchema, input) })
      if (name === 'get_processing_status') return ctx.access.processing(id, parseInput(processingWaitSchema, input))
      if (Object.hasOwn(fileToolActions, name)) {
        if (name === 'prepare_file_edit') mcpPrepareFileEditSchema.parse(input)
        return ctx.access.call(id, 'externalFileAction', fileActionSchema.parse({ action: fileToolActions[name], input }))
      }
      if (name === 'describe_library') {
        parseInput(z.object({}).strict(), input)
        const description = await ctx.access.call(id, 'describeLibrary')
        return { ...description, mode: ctx.access.list().find(l => l.libraryId === id)?.mode }
      }
      if (name === 'search_items') return ctx.access.call(id, 'searchPage', parseInput(searchPageSchema, input))
      if (name === 'read_items') return ctx.access.call(id, 'readItems', parseInput(readItemsSchema, input))
      if (name === 'facet') return ctx.access.call(id, 'facetPage', parseInput(facetPageSchema, input))
      if (name === 'read_item') return ctx.access.call(id, 'readItem', parseInput(readItemSchema, input))
      if (name === 'read_preview') return ctx.access.call(id, 'readPreview', parseInput(readPreviewSchema, input))
      if (name === 'list_space_items') return ctx.access.call(id, 'listSpaceItems', parseInput(spaceItemQuery, input))
      if (name === 'check_file_space') return ctx.access.checkSource(id, parseInput(sourceCheckSchema, input))
      if (name === 'list_file_spaces') {
        const { includeDirectories, ...options } = parseInput(sourceListSchema, input)
        const managed = await ctx.access.call(id, 'listFileSpaces', options)
        if (!includeDirectories) return { spaces: managed }
        return { spaces: [...managed.map(s => ({ ...s, sourceKind: 'managed' })), ...await ctx.access.directorySources(id)] }
      }
      if (name === 'get_import_settings') { parseInput(z.object({}).strict(), input); return ctx.access.call(id, 'getImportSettings') }
      if (name === 'import_to_library') return ctx.access.importFiles(id, parseInput(observedImportSchema, input))
      if (name === 'list_space_files' || name === 'adopt_space_files') {
        if (input.sourceKind === 'directory') {
          if (name === 'list_space_files') return ctx.access.call(id, 'directoryFilePage', parseInput(directoryPageSchema, input))
          const selected = parseInput(directoryAdoptSchema, input)
          const replay = await ctx.access.call(id, 'prepareDirectoryAdoption', selected)
          return replay ?? ctx.access.call(id, 'commitDirectoryAdoption', selected)
        }
        const { sourceKind, ...params } = input
        if (sourceKind !== undefined && sourceKind !== 'managed') throw new Error('[INVALID_INPUT] 未知空间类型')
        return name === 'list_space_files' ? ctx.access.call(id, 'listSpaceFiles', parseInput(spacePageSchema, params))
          : ctx.access.call(id, 'adoptSpaceFiles', parseInput(adoptSpaceSchema, params))
      }
      if (name === 'preview_item_lifecycle') return ctx.access.call(id, 'previewItemLifecycle', parseInput(itemLifecyclePreviewSchema, input))
      if (name === 'apply_item_lifecycle') return ctx.access.call(id, 'applyItemLifecycle', parseInput(itemLifecycleSchema, input))
      if (name === 'preview_unlink_file_space') return ctx.access.call(id, 'previewUnlinkFileSpace', parseInput(z.object({ spaceId: z.string().uuid() }).strict(), input).spaceId)
      if (name === 'library_task') return ctx.access.call(id, 'libraryTask', parseInput(libraryTaskSchema, input))
      if (name === 'review_batch') return ctx.access.call(id, 'reviewBatch', parseInput(batchReviewSchema, input))
      if (name === 'list_history') return ctx.access.call(id, 'listHistory', parseInput(historyPageSchema, input))
      if (name === 'read_history') return ctx.access.call(id, 'readHistory', parseInput(historyDetailSchema, input))
      if (name === 'read_content') return ctx.access.call(id, 'readContent', parseInput(readContentSchema, input))
      if (name === 'execute_query') return ctx.access.call(id, 'executeQuery', parseInput(executeQuerySchema, input))
      if (name === 'execute_operation') {
        const op = parseInput(executeOperationSchema, input)
        return ctx.access.call(id, 'executeOperation', op)
      }
      throw new Error('[INVALID_INPUT] 未知的工具')
    })
    ctx.onDispose(() => server.close())
    if (dir) chmodSync(endpoint, 0o600)
    ctx.access.publishEndpoint(endpoint)
    return { async invoke(method, input) {
      if (method === 'developmentSources') return ctx.access.developmentSources(z.object({ key: z.string() }).strict().parse(input).key)
      if (method === 'setDevelopmentGrant') return ctx.access.setDevelopmentGrant(setDevelopmentGrantSchema.parse(input))
      if (method === 'management') return ctx.access.localManagement(input ?? { action: 'list' })
      if (method === 'setSpacePermission') return ctx.access.setSpacePermission(input as import('../../shared/application-access').ApplicationSpacePermissionInput)
      if (method === 'spaces') {
        const { libraryId } = libraryTargetSchema.parse(input)
        const settings = ctx.access.settings(), grant = settings.libraries.find(l => l.libraryId === libraryId)
        if (!grant || !grant.open || grant.mode === 'off') return []
        return [...await ctx.access.call(libraryId, 'listFileSpaces'), ...await ctx.access.directorySources(libraryId)]
      }
      if (method !== 'settings') throw new Error('[INVALID_INPUT] 未知的应用服务方法')
      const state = ctx.access.settings(parseInput(applicationSettingsSchema, input ?? {}))
      const executable = ctx.executable('mcp')
      return { ...state, config: JSON.stringify({ mcpServers: { 'huoye': { ...executable, args: [...executable.args, '--config', ctx.access.configFile] } } }, null, 2) }
    } }
  }
}
