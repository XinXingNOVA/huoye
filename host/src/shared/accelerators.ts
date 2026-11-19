/** 公共快捷键展示；不依赖 Electron，外部 UI 插件也可复用。 */
export function acceleratorLabel(accelerator: string, mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)): string {
  const keys: Record<string, string> = mac ? {
    CmdOrCtrl: '⌘', CommandOrControl: '⌘', Cmd: '⌘', Command: '⌘', Ctrl: '⌃', Control: '⌃',
    Shift: '⇧', Alt: '⌥', Option: '⌥', Backspace: '⌫', Delete: '⌦', Enter: '↩', Return: '↩', Space: '空格'
  } : {
    CmdOrCtrl: 'Ctrl', CommandOrControl: 'Ctrl', Command: 'Super', Cmd: 'Super', Control: 'Ctrl',
    Option: 'Alt', Return: 'Enter', Space: '空格'
  }
  return accelerator.split('+').map(k => keys[k] ?? k).join(mac ? '' : '+')
}
