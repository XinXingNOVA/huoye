/** 声明 uiFeatures: ["file-working-copy-service-v1"]。本机当前仓库的工作副本服务。 */
export type { FileEditingService, FileEditingTask, EditingCheck, EditingEndCheck, EditDestination } from '../../shared/file-editing'
export type { LocalEditor, EditorOptions, OpenEditingOptions } from '../../shared/local-editors'

/** 声明 file-working-copy-ui-v1；宿主编辑入口交给已启用的界面贡献，不直接创建任务。 */
export interface FileEditingUiRequest { id: string; intent?: 'edit' | 'choose-editor' | 'replace' }
