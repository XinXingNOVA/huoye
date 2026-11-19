import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { setBinding } from '../../src/core/external-plugins'
import { PLUGINS } from '../../src/plugins/manifest'
const dir = resolve(process.argv[2]), userData = join(dir, 'user-data'), root = join(dir, 'AI阅读.library')
mkdirSync(dir, { recursive: true })
const manager = new PackageManager(userData, PLUGINS.map(p => p.id)), ref = manager.install(readFileSync(process.argv[3]))
const annotate = manager.install(readFileSync(resolve('out/main/plugins/annotate.hyplugin')))
const lib = openLibrary(root)
try {
  for (const plugin of [ref, annotate]) { manager.grant(root, plugin.hash); setBinding(lib, { ...plugin, enabled: true }, PLUGINS) }
} finally { lib.close() }
writeFileSync(join(dir, '阅读验证.txt'), '阅读时提出问题，可以把选中文字作为上下文交给模型。这个示例只在临时仓库内使用。\n\n第二段是未被选中的内容，不应在请求中自动发送。\n\n纯文本保留 $x^2$。')
writeFileSync(join(dir, '数学笔记.md'), '# 数学笔记\n\n' + String.raw`\[\mathbb Z[\sqrt2]=\{x+y\sqrt2:x,y\in\mathbb Z\}.\]` + '\n\n[[阅读验证.txt|阅读原文]]\n\n公式之后仍然可以选择文字并标记摘录。')
writeFileSync(join(dir, 'prepared.json'), JSON.stringify({ root, userData, ref }))
