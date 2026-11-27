// Windows x64 精简版与标准版共用应用身份、数据目录及插件清单。
const standard = require('./electron-builder.config.cjs')
const { checkPackage } = require('./scripts/release/package-hooks.cjs')
module.exports = {
  ...standard,
  directories: { ...standard.directories, output: 'artifacts/releases/lite' },
  beforePack: context => checkPackage(context, false),
  win: {
    ...standard.win,
    extraResources: [],
    artifactName: 'Huoye-${version}-lite-win-${arch}.${ext}'
  },
  nsis: { ...standard.nsis, artifactName: 'Huoye-${version}-lite-win-${arch}-setup.${ext}' }
}
