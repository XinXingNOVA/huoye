const { existsSync } = require('node:fs')
const { join } = require('node:path')
exports.default = async context => {
  const root = context.packager.projectDir
  for (const file of ['out/legal/manifest.json', 'out/legal/LICENSE', 'out/legal/THIRD-PARTY-NOTICES.md', 'out/main/index.js', 'out/main/core.js', 'out/main/mcp.js', 'out/main/plugins/catalog.json', 'out/main/plugins/suites.json', 'out/preload/index.js', 'out/renderer/index.html']) {
    if (!existsSync(join(root, file))) throw new Error(`打包缺少 ${file}，请先 npm run build`)
  }
  if (context.electronPlatformName === 'win32') {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上 npm ci 后打包，避免把 Mac 的原生依赖带进安装包')
    await (await import('./prepare-media.mjs')).verifyMedia()
  }
}
