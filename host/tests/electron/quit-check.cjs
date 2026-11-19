// npm run build 后执行 node tests/electron/quit-check.cjs。
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

if (process.versions.electron) {
  if (!process.env.RM_USER_DATA) throw new Error('请用 Node 启动此测试以创建独立配置')
  const { app, BrowserWindow, ipcMain, Menu } = require('electron')
  require('../../out/main/index.js')
  let prepared = false, windowsAfterActivation
  ipcMain.once('page:prepared', (_event, result) => { prepared = !result.error })
  ipcMain.once('page:ready', () => setImmediate(() => {
    if (process.platform === 'darwin') Menu.sendActionToFirstResponder('terminate:')
    else app.quit()
  }))
  app.once('will-quit', () => {
    // 开始页已关闭，此时再次点 Dock 不能恢复一个服务已停止的窗口。
    app.emit('activate', {}, false)
    windowsAfterActivation = BrowserWindow.getAllWindows().length
  })
  app.once('quit', () => writeFileSync(join(process.env.RM_USER_DATA, 'result.json'), JSON.stringify({ prepared, windowsAfterActivation })))
} else {
  const profile = mkdtempSync(join(tmpdir(), 'huoye-quit-'))
  const env = { ...process.env, RM_USER_DATA: profile }
  for (const key of ['CAPTURE_DIR', 'CAPTURE_FLOW', 'LIBRARY_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key]
  try {
    execFileSync(require('electron'), [__filename], { env, timeout: 20000, killSignal: 'SIGKILL', stdio: 'inherit' })
    assert.deepEqual(JSON.parse(readFileSync(join(profile, 'result.json'), 'utf8')), { prepared: true, windowsAfterActivation: 0 })
    console.log('开始页保存后一次退出，收尾中激活 Dock 没有重新开窗')
  } finally { rmSync(profile, { recursive: true, force: true }) }
}
