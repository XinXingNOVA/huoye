import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { developmentSchemas, type DevelopmentAction } from '../../shared/development-access'
import { jsonSchema } from '../../shared/automation'

const descriptions: Record<DevelopmentAction, string> = {
  create_development_project: '在获自主开发许可的 admin 库创建独立插件工程。传 pluginId、title 和 requestId，宿主返回 source 路径、sourceId、工具工程 toolchain。用客户端自己的文件编辑能力写入源码，再 prepare_development_build、get_development_status 及 apply_development_build。重试复用同一 requestId，保留已编辑源码。与内置、已安装或其他开发插件同名时换新 ID。',
  get_development_status: '读取获自主开发或开发验收许可的 admin 库的源码来源、构建状态/摘要、当前运行会话 session、配置 revision 与运行问题；关闭的库也可查，不启动构建或开库。sourceId 由宿主分配给自主工程或本机批准的来源。可带 requestId 查询应用或生命周期回执。pending 继续轮询；completed 是历史事实，不代表当前状态；failed/interrupted 核对 saved 与实际配置后，用新 requestId 明确重试，不自动重放。',
  prepare_development_build: '在已打开的获准 admin 库，构建/监听 sourceIds（最多32个）对应的已批准源码。复用本机已配置的开发工具工程，不接受路径或命令。返回状态；通过 get_development_status 等待 build.state=ready 和 availableHash，失败可 retry=true 重新启动构建。构建不会自行应用或重载。',
  apply_development_build: '把此库获准来源的构建快照应用到验收库并正常重载。selection=[{sourceId,hash}] 是本次授权范围内完整选择，省略其中已启用来源会退出该来源的开发覆盖；范围外的覆盖和正式绑定保持。先 get_development_status，原样使用 revision/session 与 ready 的 availableHash。先保存页面、检查版本与权限，再提交；失败保留数据。新动作使用新 requestId，重复原请求只返回回执，不再次重载。返回 pending 后用 get_development_status(requestId) 查询；saved=true 不保证装配成功，另查 runtime 和页面就绪。',
  control_library: '仅开发验收模式：对获准 admin 验收库执行 close（正常保存并关库）或 reload（正常保存并重启核心与页面）。session 从 get_development_status 获取；新动作带新 requestId，旧会话拒绝，原请求重放不再次关库/重载。保存失败保留现场，不支持强制关闭、杀进程或退出整个应用。返回 pending 后查询开发回执；completed 后再用 open_library 重开或查询运行状态。',
  capture_workbench_window: '仅开发验收模式且单独获准截图：截取指定验收库已显示的内容窗口（main 或 content:组ID），以原生 MCP JPEG 图像返回。session 来自 get_development_status；windowId 来自 get_workbench_session 的 windows.windows，windowRevision 使用 windows.revision。拒绝设置窗口、隐藏/最小化窗口、旧会话和撤权；不截桌面或其他应用。maxSide 256–1600 默认1280，有界输出。截图只记录当前画面，不表示加工完成或数据验收通过。'
}
export const developmentTools: Tool[] = (Object.keys(developmentSchemas) as DevelopmentAction[]).map(name => ({
  name, description: descriptions[name], inputSchema: jsonSchema(developmentSchemas[name]) as Tool['inputSchema'],
  annotations: { readOnlyHint: name === 'get_development_status' || name === 'capture_workbench_window', destructiveHint: false, openWorldHint: false }
}))
