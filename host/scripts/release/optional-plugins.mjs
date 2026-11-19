import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import { decodePackage } from '../../src/plugin-packages/archive.ts'

const project = fileURLToPath(new URL('../..', import.meta.url))
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

export function releaseOptionalPlugins(root, output, looseName) {
  const version = readJson(join(root, 'package.json')).version
  const name = `Huoye-${version}-plugins`
  const source = join(root, 'packaging/optional-plugins')
  const policies = join(root, 'packaging/plugins')
  const bundled = new Set(readdirSync(policies).filter(id => existsSync(join(policies, id, 'plugin.json'))))
  const expected = readJson(join(root, 'packaging/source-profile.json')).plugins.filter(id => !bundled.has(id)).sort()
  const files = readdirSync(source).filter(file => /\.(hyplugin|rmplugin)$/i.test(file)).sort()
  if (files.map(file => file.replace(/\.(hyplugin|rmplugin)$/i, '')).sort().join() !== expected.join()) throw new Error('可选安装包与发行清单不一致')

  const entries = new Map(['LICENSE', 'THIRD-PARTY-NOTICES.md', 'OPTIONAL-PLUGIN-LICENSES.txt'].map(file => [file, readFileSync(join(root, 'packaging/source-public', file))]))
  const guide = [`# 活页Huoye ${version} 可选插件`, '',
    '1. 解压合集，在活页的「设置 → 套件与插件包」点击「安装套件或插件包…」。',
    '2. 选择想用的 .hyplugin 文件，可以多选。核对预览后点击安装。',
    '3. 打开目标仓库，在「设置 → 功能与方案 → 启停功能」勾选插件和所需依赖，点击「应用并重新加载」。', '',
    '自有插件代码采用 Apache-2.0；第三方代码保留原许可，详见同目录许可文件。', '',
    '| 插件 | 版本 | 文件 | 使用入口 | 必需依赖 |', '| --- | --- | --- | --- | --- |']
  for (const file of files) {
    const bytes = readFileSync(join(source, file))
    const { manifest } = decodePackage(bytes)
    const outputFile = manifest.id + '.hyplugin'
    if (file.replace(/\.(hyplugin|rmplugin)$/i, '') !== manifest.id) throw new Error(`可选安装包文件名与插件 ID 不符：${file}`)
    entries.set(outputFile, bytes)
    const usage = (manifest.catalog?.usage || manifest.description).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')
    guide.push(`| ${manifest.title} | ${manifest.version} | \`${outputFile}\` | ${usage} | ${manifest.requires?.join('、') || '无'} |`)
  }
  guide.push('', '层级标签需要启用标签基础（tags）。音乐播放器使用文件和音频，EPUB 阅读器使用文件和预览。需要按「待处理／进行中／已完成」分列时，可以同时启用状态与看板。', '')
  entries.set('插件说明.md', Buffer.from(guide.join('\n')))
  // 包内容已经压缩。固定条目顺序和 ZIP 时间，同一组发行文件可以逐字节复核。
  const zip = zipSync(Object.fromEntries([...entries].map(([file, bytes]) => [`${name}/${file}`, bytes])), { level: 0, mtime: new Date(2000, 0, 1) })
  mkdirSync(output, { recursive: true })
  const directory = join(output, looseName ?? name), archive = join(output, name + '.zip')
  const stage = mkdtempSync(join(output, '.optional-'))
  try {
    const loose = join(stage, 'plugins')
    mkdirSync(loose)
    for (const [file, bytes] of entries) writeFileSync(join(loose, file), bytes)
    writeFileSync(join(stage, 'plugins.zip'), zip)
    // 发布目录可能已有同一版的下载件。允许重复生成，保留已有的不同内容供维护者核对。
    if (existsSync(archive) && !readFileSync(archive).equals(zip)) throw new Error(`已有不同的插件合集，请核对或指定新输出目录：${archive}`)
    if (existsSync(directory)) {
      if (readdirSync(directory).length !== entries.size || [...entries].some(([f, b]) => !existsSync(join(directory, f)) || !readFileSync(join(directory, f)).equals(b))) {
        throw new Error(`已有不同的插件目录，请核对或指定新输出目录：${directory}`)
      }
    } else renameSync(loose, directory)
    if (!existsSync(archive)) renameSync(join(stage, 'plugins.zip'), archive)
  } finally { rmSync(stage, { recursive: true, force: true }) }
  return { count: files.length, directory, archive }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error('用法：npm run release:plugins -- [输出目录]')
  const result = releaseOptionalPlugins(project, resolve(process.argv[2] ?? join(project, 'artifacts/releases')))
  console.log(`已生成 ${result.count} 个独立安装包：${result.directory}\n可选插件合集：${result.archive}`)
}
