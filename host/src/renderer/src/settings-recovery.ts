import type { SettingsTarget } from '../../plugin-api/ui/settings'

const keyFor = (libraryId: string) => `rm:reopen-settings:${libraryId}`
/** 只记本窗口重载后的一次性打开意图，不保存表单数据或改动工作区。 */
export function rememberSettingsForReload(libraryId: string, target: SettingsTarget) {
  try { sessionStorage.setItem(keyFor(libraryId), JSON.stringify(target)) } catch { /* 本机存储不可用不阻止重载 */ }
}
export function takeSettingsAfterReload(libraryId: string): SettingsTarget | undefined {
  try {
    const key = keyFor(libraryId), saved = sessionStorage.getItem(key)
    if (saved) { sessionStorage.removeItem(key); return JSON.parse(saved) }
  } catch { /* 旧窗口的损坏意图不阻止打开仓库 */ }
}
