// 仅为跨插件边界回归；不进入发行清单或日常仓库。
export const plugin = { id: 'table-probe', extensions: [{
  id: 'table-probe.tools', point: 'table.tools', version: 1, order: -100,
  value: {
    match: (kind: { title: string }) => kind.title === '故障验证',
    header: { width: 200, Component() { throw new Error('探针表头失败') } },
    columnMenu: { title: () => '探针菜单', Component() { throw new Error('探针菜单失败') } },
    async addOption() { throw new Error('探针选项失败') }
  }
}] }
