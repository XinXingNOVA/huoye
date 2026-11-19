// 首版使用真实文件目录，保证 utilityProcess、动态 PDF 资源与 MCP 的 Node 入口一致。
module.exports = {
  appId: 'app.huoye.desktop',
  directories: { output: 'artifacts/releases', buildResources: 'packaging' },
  files: ['out/main/**/*', 'out/preload/**/*', 'out/renderer/**/*', 'package.json'],
  extraResources: [{ from: 'out/legal', to: 'licenses' }],
  asar: false,
  // 本项目的 SQLite 13 / sharp / canvas 均使用 N-API 预编译模块。
  // 必须在目标系统 npm ci，不能复制 Mac 的 node_modules；打包后再真实启动验收。
  npmRebuild: false,
  beforePack: './scripts/release/package-hooks.cjs',
  win: {
    executableName: 'Huoye',
    icon: 'packaging/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    extraResources: [{ from: 'resources/media/win32-x64', to: 'media/win32-x64' }],
    artifactName: 'Huoye-${version}-win-${arch}.${ext}'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    deleteAppDataOnUninstall: false,
    artifactName: 'Huoye-${version}-win-${arch}-setup.${ext}'
  },
  mac: {
    identity: '-',
    icon: 'packaging/icon.icns',
    target: ['dmg', 'zip'],
    artifactName: 'Huoye-${version}-mac-${arch}.${ext}'
  },
  publish: null
}
