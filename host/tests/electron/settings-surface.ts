import { BrowserWindow } from 'electron'
import { auxiliaryKind, auxiliaryOwner } from '../../src/main/auxiliary-windows'

export function findSettingsSurface(owner: BrowserWindow): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(w => w !== owner && !w.isDestroyed() && auxiliaryOwner(w) === owner && auxiliaryKind(w) === 'settings')
}
/** 明确选中设置显示窗口；业务桥和插件运行环境仍在所属主窗口。 */
export function settingsSurface(owner: BrowserWindow): BrowserWindow {
  const win = findSettingsSurface(owner)
  if (!win) throw new Error('设置窗口未打开')
  return win
}
export async function settingsScript(owner: BrowserWindow, code: string) {
  return settingsSurface(owner).webContents.executeJavaScript(code)
}

/** 后台建库返回后工作台可能首次挂载中，通过真实齿轮和侧栏进入。 */
export async function openLibraryMcpSettings(owner: BrowserWindow) {
  const waitFor = async (action: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 150; i++) {
      if (await action()) return
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('无法打开' + label)
  }
  await waitFor(() => owner.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[aria-label="打开设置"]')
    if (!button?.checkVisibility()) return false
    button.click()
    return true
  })()`), '工作台设置')
  await waitFor(async () => {
    const surface = findSettingsSurface(owner)
    return !!surface && surface.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('.application-settings-nav button')].find(b => b.textContent === 'AI 接入 · MCP')
      if (!button?.checkVisibility()) return false
      button.click()
      return true
    })()`)
  }, 'AI 接入设置')
  await waitFor(() => settingsScript(owner, "!!document.querySelector('.mcp-connection')?.checkVisibility()"), '连接配置')
  return settingsSurface(owner)
}
