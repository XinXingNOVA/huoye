import { generatePlugins, pluginExecutables } from './scripts/plugins/generate'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { version } from './package.json'
import { readReleaseBundle } from './scripts/release/bundled-suites'
import { dirname, basename } from 'node:path'

generatePlugins()

export default defineConfig(() => ({
  main: {
    define: { __HUOYE_APP_VERSION__: JSON.stringify(version) },
    plugins: [{
      name: 'distribute-plugin-packages',
      async generateBundle() {
        if (process.env.RM_PLUGIN_BUNDLE && basename(process.env.RM_PLUGIN_BUNDLE) !== 'catalog.json') throw new Error('RM_PLUGIN_BUNDLE 必须指向 catalog.json')
        const directory = process.env.RM_PLUGIN_BUNDLE ? dirname(resolve(process.env.RM_PLUGIN_BUNDLE)) : undefined
        const { packages, suites } = readReleaseBundle(resolve('packaging/starters'), directory)
        const catalog = [...packages].map(([id, { bytes, hash }]) => {
          const file = `${id}.hyplugin`
          this.emitFile({ type: 'asset', fileName: `plugins/${file}`, source: bytes })
          return { file, hash }
        })
        this.emitFile({ type: 'asset', fileName: 'plugins/suites.json', source: JSON.stringify(suites) })
        this.emitFile({ type: 'asset', fileName: 'plugins/catalog.json', source: JSON.stringify(catalog) })
      }
    }],
    build: {
      rollupOptions: {
        input: {
          // 主进程：窗口、协议、系统集成
          index: resolve('src/main/index.ts'),
          // 核心进程：宿主核心，运行在 utilityProcess
          core: resolve('src/core/process.ts'),
          ...Object.fromEntries(pluginExecutables().map(e => [e.name, resolve(e.source)]))
        }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
}))
