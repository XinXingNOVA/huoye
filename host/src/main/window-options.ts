import type { BrowserWindowConstructorOptions } from 'electron'

/** Mac 保留内嵌红绿灯；Windows 使用系统标题栏及最小化／最大化／关闭按钮。 */
export function windowChrome(platform = process.platform): BrowserWindowConstructorOptions {
  return platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : { titleBarStyle: 'default' }
}
