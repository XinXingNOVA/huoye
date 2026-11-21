import { existsSync } from 'node:fs'
import { openLibrary } from '../../src/core/library'
import { Registry } from '../../src/core/registry'
import { Store } from '../../src/core/store'
import { textBlock } from '../../src/plugins/text/blocks'

// 跑在 Electron 启动前，仅为窗口测试准备文字素材，避免把导入吞吐混入布局验收。
const root = process.argv[2]
if (!root || existsSync(root)) throw Error('主题夹具需要一个新库目录')
const lib = openLibrary(root)
try {
  const registry = new Registry([{ id: 'text', version: 1, blocks: [textBlock] }])
  const store = new Store(lib, registry, () => {})
  for (let start = 0; start < 100_000; start += 500) {
    store.batch(() => {
      for (let i = start; i < start + 500; i++) {
        const id = store.createEntity(1_700_000_000_000 + i)
        store.put(id, 'text', { content: '资料记录 ' + (i + 1) })
      }
    })
  }
} finally { lib.close() }
