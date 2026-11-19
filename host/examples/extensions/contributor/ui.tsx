import type { UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import type { ExampleAction, ExampleContext } from '@resource-manager/example-extension-contract'

const point = 'demo-extension-provider.actions'
function Panel({ context }: { context: ExampleContext }) {
  if (context.failure === 'render') throw new Error('贡献方渲染失败示例')
  return <p data-contributed-panel>贡献方读取到页面 {context.name} · {context.count}</p>
}
const add: ExampleAction = { title: '计数 +1', Panel, run(context) {
  if (context.failure === 'sync') throw new Error('贡献方同步失败示例')
  if (context.failure === 'async') return Promise.reject(new Error('贡献方异步失败示例'))
  if (context.isAvailable()) context.add(1)
} }
const delayed: ExampleAction = { title: '延迟 +10', async run(context) {
  await new Promise(resolve => setTimeout(resolve, 500))
  if (context.isAvailable()) context.add(10)
} }
export const plugin: UiPlugin = {
  id: 'demo-extension-contributor',
  extensions: [
    { id: 'demo-extension-contributor.add', point, version: 1, order: 10, value: add },
    { id: 'demo-extension-contributor.delayed', point, version: 1, order: 20, value: delayed },
    // 两个故意拒绝的条目用于演示诊断，不影响有效贡献。
    { id: 'demo-extension-contributor.future', point, version: 2, value: add },
    { id: 'demo-extension-contributor.invalid', point, version: 1, value: { title: '缺少动作' } }
  ],
  commands: [{ id: 'demo-extension-contributor.alive', title: '检查贡献方仍启用', run: (_context, host) => host.notify('贡献方仍启用，提供方是可选依赖') }]
}
