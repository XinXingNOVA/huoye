import { auxiliaryOwner, routeAuxiliaryCommand } from './auxiliary-windows'
import { reloadRenderer, reportLeaveFailure } from './page-lifecycle'
// 应用菜单。标签页相关的快捷键（⌘T、⌘W）绑在菜单上，交给页面处理；
// 默认菜单的 ⌘W 是关闭窗口，必须换掉。编辑菜单要保留，输入框里的复制粘贴依赖它。

import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { mainText as t } from './language'
import { showLauncher } from './launcher'
import type { VaultEntry } from './vaults'

/** 发给当前窗口页面的命令，由窗口外壳处理。 */
export type MenuCommand =
  | 'tab.new'
  | 'tab.close'
  | 'tab.next'
  | 'tab.prev'
  | 'selectAll'
  | 'import'
  | 'undo'
  | 'redo'
  | 'settings'
  | 'commands'
  | 'history'
  | 'new'
  | 'find'
  | 'export'
  | 'trash'
  | 'panel.sidebar'
  | 'panel.inspector'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow()
  if (win && !routeAuxiliaryCommand(win, command)) win.webContents.send('menu:command', command)
}

/** recent：最近的仓库（"打开最近"子菜单），open：打开其中一个。 */
export function installMenu(recent: VaultEntry[] = [], open: (path: string) => void = () => {}): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.open'), accelerator: 'CmdOrCtrl+Shift+O', click: () => showLauncher() },
        {
          label: t('menu.recent'),
          submenu: recent.length
            ? recent.map((v) => ({ label: v.name, sublabel: v.path, toolTip: v.path, click: () => open(v.path) }))
            : [{ label: t('menu.none'), enabled: false }]
        },
        { label: t('common.settingsMenu'), accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        { label: t('menu.new'), accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: t('menu.newTab'), accelerator: 'CmdOrCtrl+T', click: () => send('tab.new') },
        { label: t('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: () => send('tab.close') },
        { type: 'separator' },
        { label: t('menu.import'), accelerator: 'CmdOrCtrl+O', click: () => send('import') },
        { label: t('menu.export'), accelerator: 'Shift+CmdOrCtrl+E', click: () => send('export') }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        // 撤销交给页面：焦点在输入框时撤销文字，否则撤销素材库里的操作
        { label: t('menu.undo'), accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: t('menu.redo'), accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { label: t('menu.history'), click: () => send('history') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        // 全选交给页面：焦点在输入框时全选文字，否则全选素材
        { label: t('menu.all'), accelerator: 'CmdOrCtrl+A', click: () => send('selectAll') },
        { type: 'separator' },
        // 交给页面：焦点在输入框时删掉光标前的这一行，否则把当前标签页的焦点移到回收站（回收站里是彻底删除）
        { label: t('menu.trash'), accelerator: process.platform === 'darwin' ? 'CmdOrCtrl+Backspace' : 'Delete', click: () => send('trash') },
        { type: 'separator' },
        { label: t('menu.search'), accelerator: 'CmdOrCtrl+F', click: () => send('find') }
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.commands'), accelerator: 'CmdOrCtrl+P', click: () => send('commands') },
        { label: t('menu.sidebar'), accelerator: 'CmdOrCtrl+\\', click: () => send('panel.sidebar') },
        { label: t('menu.inspector'), accelerator: 'CmdOrCtrl+Shift+\\', click: () => send('panel.inspector') },
        { type: 'separator' },
        { label: t('menu.next'), accelerator: 'Ctrl+Tab', click: () => send('tab.next') },
        { label: t('menu.previous'), accelerator: 'Ctrl+Shift+Tab', click: () => send('tab.prev') },
        { type: 'separator' },
        { label: t('menu.reload'), accelerator: 'CmdOrCtrl+R', click: () => { const win = BrowserWindow.getFocusedWindow(); if (win) void reloadRenderer(auxiliaryOwner(win)).catch(error => reportLeaveFailure(win, error)) } },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  if (process.platform !== 'darwin') template.shift()
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
