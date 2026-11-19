import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { jsonSchema } from '../../shared/automation'
import { managementSchemas, type ManagementAction } from '../../shared/application-management'
const descriptions: Record<ManagementAction, string> = {
  preview_workbench: '读取 admin 仓库当前工作台布局、revision、可用工具及预设。可带 WorkbenchLayout JSON 预演分屏、侧栏、标签页安排，返回内容支持情况与 issues，不写入。先读取 current 或 presets.layout 作为起点；collection 页可用 target:{presetId:"all"} 或 {viewId:"保存视图身份"}，presentation 指定已启用的浏览布局。',
  configure_workbench: '提交 preview_workbench 后的 layout/revision 和新 requestId，需要 admin。复用工作台布局控制器，保留已有页面、草稿和素材，保存后返回 completed；不会自动弹窗（交付使用 show_library）。工作台改变会拒绝旧预演。失败可原样重试，响应丢失先 get_workbench_configuration；completed 重试仅返回回执，不覆盖后续人工调整。不自动创建命名预设。',
  get_workbench_configuration: '查询本连接对目标库提交的工作台请求回执。pending 可按原参数重试；不自动在重启时重放。completed 仅表示此请求曾保存成功，不代表当前布局仍与之相同。',
  request_package_installation: '预览并固定本地 .hyplugin/.rmplugin 插件或 .hysuite/.rmsuite 套件 的输入快照，不安装或执行。paths 最多50项，新任务使用新 requestId；相同请求始终使用原文件快照。approvalRequired 列出需要人工授信的确切包版本，用户在应用设置 → AI 接入批准；AI 不能自行批准。只添加包与新套件，不更新既有套件、不卸载或跨库替换。',
  get_package_installation: '读取安装请求的持久状态、逐项结果及仍需批准的确切包。completed/cancelled 是历史回执，不表示包现在仍安装或启用。',
  install_packages: '继续已固定的安装请求。仅应用随附或人工允许的确切摘要可安装；缺许可返回 PACKAGE_APPROVAL_REQUIRED 待处理状态。逐项失败可用同 requestId 重试，不重装成功项，不启用到任何库。安装后重新读取目录、预演建库或本库插件组合。',
  preview_library_plugins: '预演已打开 admin 仓库的插件组合；preset 用目录 id/revision/versions，或 plugins=[{id,hash?}] 明确组合，二选一。mode 默认 add 保留已有选择，replace 替换可选能力；必需依赖自动补齐。返回 current/selection/revision/issues；不写入。这里只调整插件，不应用方案布局，已有待接续布局会明确阻止提交。',
  configure_library_plugins: '以预演返回的 selection/revision 和新 requestId 提交插件选择，需要 admin。复用应用内保存页面、提交配置和重载；停用保留数据。失败重试全部原参数，结果 saved 表示配置已确认，runtimeProblems 表示运行问题；响应丢失先 get_library_configuration。已完成只返回回执，不覆盖后来的手工配置。',
  cancel_library_configuration: '取消本请求后续的插件调整或重试，需要 admin。已保存的选择、数据和已执行重载保持；运行阶段在下一检查点停止。取消后同 requestId 不再重试，完成任务不撤销。',
  get_library_configuration: '查询本连接 requestId 对应的本库插件调整回执和当前运行问题。state=pending 且 running=false 可原样重试 configure_library_plugins；saved 不保证插件成功运行，完成回执也不代表当前选择仍相同。',
  list_allowed_file_spaces: '列出用户明确允许 AI 关联的文件空间身份与名称，不扫描目录，不披露其他空间。允许关联不授予原件更新或回收权限。',
  link_library_file_space: '把允许名单中的 spaceId 关联到 admin 仓库，拒绝任意路径和身份变化。复用原空间成员规则，不改变独享/共享模式，不改其他成员权限，不自动收录或改变默认保存空间。重复关联同一身份可安全接续。'
}
const reads = new Set<ManagementAction>(['preview_workbench', 'get_workbench_configuration', 'get_package_installation', 'preview_library_plugins', 'get_library_configuration', 'list_allowed_file_spaces'])
export const managementTools: Tool[] = (Object.keys(managementSchemas) as ManagementAction[]).map(name => ({
  name, description: descriptions[name], inputSchema: jsonSchema(managementSchemas[name]) as Tool['inputSchema'],
  annotations: { readOnlyHint: reads.has(name), destructiveHint: name === 'configure_library_plugins' || name === 'configure_workbench', idempotentHint: true, openWorldHint: false }
}))
