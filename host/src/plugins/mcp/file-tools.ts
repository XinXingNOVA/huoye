import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { fileActionSchemas, fileReadActions, type FileAction } from '../../shared/file-actions'
import { jsonSchema } from '../../shared/automation'
export const mcpPrepareFileEditSchema = fileActionSchemas.prepare.extend({ content: z.discriminatedUnion('type', [z.object({ type: z.literal('file'), path: z.string().min(1) }).strict(), z.object({ type: z.literal('text'), text: z.string().max(32000) }).strict()]) })
const definitions: [string, FileAction['action'], string][] = [
  ['get_file_edit_capabilities', 'capabilities', '查看素材原文件可发布、可另存的位置和受限原因。id 是仓库素材身份；副本只能放已关联的新版独享空间。旧空间需迁移才能原位发布新版。'],
  ['preview_file_update', 'previewUpdate', '预览本仓库已采用版与空间当前版，返回 expectedPath、contentVersion、revision 和有界内容。不会改变引用。'],
  ['accept_file_update', 'acceptUpdate', '按 preview_file_update 返回的基线接纳空间新版，仅改变本仓库引用并重建派生内容，保留笔记标签。需要 organize；不等于发布原件。使用新 requestId，重试保持全部参数。'],
  ['prepare_file_edit', 'prepare', '异步准备文件修改，不发布。先 get_file_edit_capabilities；content 可为 UTF-8 text（最多32000字符，限文字格式）或同扩展名本机 file.path。destination.publish 修改原件，需要 MCP 与空间两层 revise；copy 指定新版独享 spaceId，生成独立文件后仅替换本素材引用。返回预览和 editId。新任务新 requestId；相同参数重试接续。'],
  ['commit_file_edit', 'commit', '提交 prepare_file_edit 的 editId/previewToken 和新的 requestId。空间发布成功后本仓库接纳；结果分别报告 space 和 library accepted/pending/skipped。保留原件历史及业务数据，不进入仓库撤销。失败复用全部参数；冲突需重新准备，不能覆盖已变化基线。'],
  ['discard_file_edit', 'discard', '放弃未提交编辑；传 editId 和新的 requestId。保留草稿字节，不释放容量。已提交不能放弃。只管理本 MCP 入口的编辑。'],
  ['cancel_file_task', 'cancel', '请求取消本 MCP 在此仓库发起的复制/校验：准备传准备 requestId，编辑提交传 editId，空间恢复传 requestId。不能取消 UI 任务；不撤销已提交结果。'],
  ['list_file_versions', 'history', '分页读取空间原件版本元信息。spaceId+fileId 是空间身份，非仓库素材 id；从 list_space_files 获得。revision 可冻结分页，返回 canRestore/blocked。'],
  ['restore_file_version', 'restoreVersion', '将历史内容发布为新版本（保留所有旧版），不强制各仓库接纳。需 MCP 与空间两层 revise。传历史页的 spaceId/fileId/contentVersion/revision 和新 requestId；失败同参重试。原件已回收须先恢复可用性。'],
  ['preview_space_lifecycle', 'previewLifecycle', '预览空间原件 recycle/restore，不改仓库素材。必须先 list_space_files 取得文件 id/revision；返回 version、可执行性及本仓库引用数，其他仓库引用未知。'],
  ['apply_space_lifecycle', 'applyLifecycle', '按 preview_space_lifecycle 的 version 和文件修订执行 recycle/restore，需要 MCP 与空间两层 recycle。仅新版空间开放。回收立即阻止所有库后续读取所有历史版本，字节保留；恢复校验全部历史，不复活仓库素材、不自动收录。新 requestId；失败同参重试；SPACE_CHANGED 重新预览。']
]
export const fileToolActions = Object.fromEntries(definitions.map(([name, action]) => [name, action])) as Record<string, FileAction['action']>
export const fileTools: Tool[] = definitions.map(([name, action, description]) => ({ name, description,
  inputSchema: jsonSchema(action === 'prepare' ? mcpPrepareFileEditSchema : fileActionSchemas[action]) as Tool['inputSchema'],
  annotations: { readOnlyHint: fileReadActions.has(action), destructiveHint: !fileReadActions.has(action), idempotentHint: true, openWorldHint: false }
}))
