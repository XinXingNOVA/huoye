// Loaded only by the isolated Electron capture. The names mirror an externalized UI bundle.
const { createElement: h, useState, Fragment } = globalThis.__rmPluginSdk.react
const { Button, Dialog, DropdownMenu } = globalThis.__rmPluginSdk['@resource-manager/plugin-api/ui/kit']

function Layers() {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState(null)
  const [choice, setChoice] = useState('初始')
  return h(Fragment, null,
    h(Button, { id: 'kit-open', onClick: () => setOpen(true) }, choice),
    open && h(Dialog, { title: '嵌套菜单', onClose: () => setOpen(false) },
      h(Button, { id: 'kit-menu', onClick: e => setAnchor(e.currentTarget) }, '选择'),
      anchor && h(DropdownMenu, { label: '选项', anchor, groups: [{ items: [
        { id: 'first', label: '甲' }, { id: 'skip', label: '跳过', disabled: true }, { id: 'last', label: '乙', checked: false }
      ] }], onClose: () => setAnchor(null), onSelect: setChoice })))
}
export const plugin = { id: 'kit-probe', layouts: [{ id: 'kit-probe', title: '嵌套菜单验收', Component: Layers }] }
