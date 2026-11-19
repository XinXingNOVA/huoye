export { runApplicationManagementCapture } from '../../tests/electron/capture-application-management'
// 主进程的验证适配入口；流程集中在 tests/electron，仍随构建保留用于发布包验收。
// 仅在显式设置 CAPTURE_DIR 时由启动逻辑调用，不改变普通启动流程。
export { captureContextMenu, captureDir, runCapture, runVaultsCapture, type ContextItem } from '../../tests/electron/capture'
export { runDistributionCapture } from '../../tests/electron/capture-distribution'
export { runApplicationCapture } from '../../tests/electron/capture-application'
export { runApplicationCreationCapture, runCreationRestoreCapture } from '../../tests/electron/capture-application-creation'

export { runLibraryCreationCapture } from '../../tests/electron/capture-library-creation'
