/** 从已提交快照提取源码；不安装依赖，不运行来源工程脚本，不发布。Node 24 + Git。 */
import { execFileSync } from 'node:child_process'
import { pluginInventory, inventoryMarkdown } from './plugin-inventory.mjs'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const policyPath = 'packaging/source-profile.json', overlayPath = 'packaging/source-public/'
const json = value => JSON.stringify(value, null, 2) + '\n'
const hash = value => createHash('sha256').update(value).digest('hex')
const toolPaths = ['scripts/release/source.mjs', 'scripts/release/plugin-inventory.mjs']
const toolHash = read => hash(Buffer.concat(toolPaths.map(path => read(path))))
const git = (root, args, options = {}) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, ...options })
const gitText = (root, args) => git(root, args).toString().trim()
const object = (root, commit, path) => git(root, ['show', `${commit}:${path}`])
const parse = bytes => JSON.parse(bytes.toString())

function safePath(path) {
  if (!path || path.normalize('NFC') !== path || path.split('/').some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f<>:"|?*]|[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`不可移植路径：${path}`)
}
function snapshot(root, commit) {
  const entries = git(root, ['ls-tree', '-rz', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean).map(line => {
    const [header, path] = line.split('\t'), [mode, type, oid] = header.split(' ')
    safePath(path)
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`源码不能包含符号链接／子模块：${path}`)
    return { path, mode, oid }
  })
  const bytes = git(root, ['cat-file', '--batch'], { input: entries.map(e => e.oid).join('\n') + '\n' })
  let offset = 0
  return new Map(entries.map(e => {
    const end = bytes.indexOf(10, offset), [oid, type, size] = bytes.subarray(offset, end).toString().split(' ')
    if (oid !== e.oid || type !== 'blob' || !/^\d+$/.test(size)) throw new Error('Git 对象读取失败')
    const data = bytes.subarray(end + 1, end + 1 + Number(size)); offset = end + 2 + Number(size)
    return [e.path, { data, mode: e.mode }]
  }))
}
function pin(path, ref, id) {
  const root = gitText(path, ['rev-parse', '--show-toplevel'])
  // realpath 由 Git 返回；允许工作树位于 /tmp 的系统别名下。
  if (gitText(path, ['rev-parse', '--show-prefix'])) throw new Error(`来源必须为工程根目录：${id}`)
  const commit = gitText(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  if (commit === gitText(root, ['rev-parse', 'HEAD']) && gitText(root, ['status', '--porcelain'])) throw new Error(`来源有未提交修改：${id}`)
  const manifest = parse(object(root, commit, id === 'host' ? 'package.json' : 'plugin.json'))
  if (id !== 'host' && manifest.id !== id) throw new Error(`来源插件 ID 不符：${id}`)
  return { id, root, commit, version: manifest.version, title: manifest.title ?? manifest.productName ?? id }
}
export function lockSources(sourcesFile, lockFile) {
  const sources = parse(readFileSync(sourcesFile)), base = dirname(resolve(sourcesFile))
  const host = pin(resolve(base, sources.host.path), sources.host.ref ?? 'HEAD', 'host')
  const policy = parse(object(host.root, host.commit, policyPath))
  if (policy.version !== 1 || !Array.isArray(policy.plugins) || new Set(policy.plugins).size !== policy.plugins.length || policy.plugins.some(id => !/^[a-z][a-z0-9-]*$/.test(id))) throw new Error('不支持的源码提取规则')
  if (Object.keys(sources.plugins).sort().join() !== [...policy.plugins].sort().join()) throw new Error('插件来源必须与本版 source-profile.json 清单一致')
  const plugins = [...policy.plugins].sort().map(id => pin(resolve(base, sources.plugins[id].path), sources.plugins[id].ref ?? 'HEAD', id))
  const lock = { format: 1, policyHash: hash(object(host.root, host.commit, policyPath)), toolHash: toolHash(path => object(host.root, host.commit, path)), host, plugins }
  mkdirSync(dirname(resolve(lockFile)), { recursive: true })
  writeFileSync(lockFile, json(lock), { flag: 'wx' })
  return lock
}
function excluded(path) {
  return path.split('/').some(p => ['.git', 'node_modules', '.local', '.DS_Store'].includes(p) || p.endsWith('.library')) ||
    /^(out|dist|artifacts|\.build-cache|release)\//.test(path) ||
    /(^|\/)(\.plugin-sources\.local\.json|\.release-sources\.local\.json|\.rm-dev\.json|\.rm-sdk\.json|\.npmrc)$|\.tsbuildinfo$/.test(path) || path.startsWith('resources/media/')
}
function sanitize(path, data) {
  if (path.endsWith('package-lock.json')) {
    const lock = parse(data)
    for (const pkg of Object.values(lock.packages ?? {})) if (pkg.resolved) {
      if (pkg.resolved.startsWith('file:')) {
        if (!/^file:vendor\/[a-zA-Z0-9_.-]+\.tgz$/.test(pkg.resolved)) throw new Error(`需人工审核依赖来源：${path}`)
        continue // validateFiles 再核对归档确实随同一工程提交，且完整性一致。
      }
      const url = new URL(pkg.resolved)
      if (!['registry.npmjs.org', 'registry.npmmirror.com'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.protocol !== 'https:') throw new Error(`需人工审核依赖来源：${path}`)
      url.hostname = 'registry.npmjs.org'; pkg.resolved = url.href
    }
    return Buffer.from(json(lock))
  }
  if (path.endsWith('.md')) {
    let text = data.toString().replaceAll('详细历史保留在原工程。', '').replaceAll('历史验证记录留在原工程。', '')
      .replace('旧格式明确拒绝，历史工具保留在 Git 标签 file-space-legacy-migration-2026-10-27。', '旧格式明确拒绝；本源码包不包含旧格式迁移工具。')
    if (path.startsWith('plugins/') && path.endsWith('/README.md')) {
      text = text.replace(/^迁移版本：[^\n]*\n\n/gm, '').replace(/^(?:2026-\d{2}-\d{2} 在|已在 macOS 验证：|已通过类型及公共边界检查)[^\n]*\n/gm, '')
      text = text.replace(/^## 验证\s*$/gm, '## 验证方法').replace(/^((?:## )?)\d+\.\d+\.\d+ (?:增加|补充)/gm, '$1支持').replace(/（2026-\d{2}-\d{2}[^）]*）/g, '')
    }
    return Buffer.from(text)
  }
  return data
}
export function validateFiles(files) {
  const caseNames = new Set(), directories = new Set(['.'])
  for (const path of files.keys()) {
    safePath(path)
    const key = path.toLowerCase()
    if (caseNames.has(key)) throw new Error(`文件名大小写冲突：${path}`)
    caseNames.add(key)
    for (let d = posix.dirname(path); d !== '.'; d = posix.dirname(d)) directories.add(d)
  }
  for (const [path, { data }] of files) {
    if (path.endsWith('package-lock.json')) {
      for (const pkg of Object.values(parse(data).packages ?? {})) if (pkg.resolved?.startsWith('file:')) {
        if (!/^file:vendor\/[a-zA-Z0-9_.-]+\.tgz$/.test(pkg.resolved)) throw new Error(`本地依赖必须是工程内 vendor 归档：${path}`)
        const target = files.get(posix.join(posix.dirname(path), pkg.resolved.slice(5)))
        if (!target || target.mode !== '100644' || pkg.integrity !== 'sha512-' + createHash('sha512').update(target.data).digest('base64')) throw new Error(`本地依赖归档缺失或完整性不匹配：${path}`)
      }
    }
    if (/(^|\/)\.env(?:$|\.(?!example$|sample$))|\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log)$/.test(path)) throw new Error(`需要人工审核的文件：${path}`)
    if (data.includes(0)) continue
    const text = data.toString()
    // 只报告位置，不把可能的凭据写入日志。示例路径与合成测试 token 不按关键词误删。
    const lines = text.split('\n')
    for (const [i, line] of lines.entries()) if (/\/Users\/[\w\p{Script=Han}.-]+\/|\/home\/[\w.-]+\/|[A-Za-z]:\\Users\\|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{40,}/u.test(line)) throw new Error(`疑似个人路径或凭据，需人工审核：${path}:${i + 1}`)
    if (!path.endsWith('.md') || path.startsWith(`host/${overlayPath}`)) continue
    const prose = text.replace(/```[\s\S]*?```/g, '')
    const links = [...prose.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g), ...prose.matchAll(/(?:src|srcset)=["']([^"']+)["']/g)]
    for (const match of links) {
      let target = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0].split('#')[0]
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      try { target = decodeURIComponent(target) } catch { throw new Error(`无效文档链接：${path}`) }
      const dest = posix.normalize(posix.join(posix.dirname(path), target))
      if (!files.has(dest) && !directories.has(dest.replace(/\/$/, ''))) throw new Error(`失效文档链接：${path} → ${target}`)
    }
  }
}
function archive(source, output, time) {
  const store = mkdtempSync(join(tmpdir(), 'rm-source-git-'))
  try {
    const config = join(store, 'empty-config'); writeFileSync(config, '')
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_AUTHOR_NAME: 'Source export', GIT_AUTHOR_EMAIL: 'export@example.invalid', GIT_COMMITTER_NAME: 'Source export', GIT_COMMITTER_EMAIL: 'export@example.invalid', GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` })
    const run = args => git(source, ['--git-dir', join(store, 'git'), '--work-tree', source, '-c', 'core.autocrlf=false', ...args], { env })
    run(['init', '--quiet'])
    // 清单记录的是实际字节；来源的 Git 属性不能让 add/archive 转码、替换或漏文件。
    writeFileSync(join(store, 'git/info/attributes'), '* -filter -text -ident -working-tree-encoding -export-ignore -export-subst\n')
    run(['add', '--all', '--force'])
    const tree = run(['write-tree']).toString().trim()
    const commit = run(['commit-tree', tree, '-m', 'Source snapshot']).toString().trim()
    run(['archive', '--format=zip', '--prefix=huoye/', '--output', output, commit])
  } finally { rmSync(store, { recursive: true, force: true }) }
}
export function exportSources(lockFile, destination) {
  const lock = parse(readFileSync(lockFile)), output = resolve(destination)
  if (lock.format !== 1 || !/^[a-f0-9]{40}$/.test(lock.host.commit) || lock.plugins.some(p => !/^[a-f0-9]{40}$/.test(p.commit))) throw new Error('无效源码锁')
  if (toolHash(path => readFileSync(new URL('../../' + path, import.meta.url))) !== lock.toolHash) throw new Error('请使用锁定宿主提交中的提取工具')
  if (existsSync(output)) throw new Error('输出目录已存在；每版使用新目录')
  const host = snapshot(lock.host.root, lock.host.commit)
  if (hash(host.get(policyPath).data) !== lock.policyHash || toolHash(path => host.get(path).data) !== lock.toolHash) throw new Error('锁与提取规则不一致')
  const policy = parse(host.get(policyPath).data), files = new Map()
  if (lock.plugins.map(p => p.id).sort().join() !== [...policy.plugins].sort().join()) throw new Error('锁与插件清单不一致')
  function add(prefix, snapshot, excludes = []) {
    for (const [path, item] of snapshot) if (!excluded(path) && !excludes.includes(path)) files.set(`${prefix}/${path}`, { ...item, data: sanitize(`${prefix}/${path}`, item.data) })
  }
  add('host', host, policy.hostExclude)
  for (const plugin of lock.plugins) {
    const content = snapshot(plugin.root, plugin.commit), manifest = parse(content.get('plugin.json').data)
    if (manifest.id !== plugin.id || manifest.version !== plugin.version) throw new Error(`插件锁不符：${plugin.id}`)
    add(`plugins/${plugin.id}`, content)
  }
  for (const [path, item] of host) if (path.startsWith(overlayPath)) files.set(path.slice(overlayPath.length), item)
  const put = (path, value) => files.set(path, { mode: '100644', data: Buffer.from(typeof value === 'string' ? value : json(value)) })
  if (policy.license !== 'Apache-2.0' || !files.has('LICENSE') || parse(files.get('host/package.json').data).license !== policy.license) throw new Error('源码发行缺少已确认的 Apache-2.0 授权')
  for (const plugin of lock.plugins) {
    const path = `plugins/${plugin.id}/LICENSE`
    if (!files.has(path)) files.set(path, files.get('LICENSE'))
  }
  const mappings = Object.fromEntries(lock.plugins.map(p => [p.id, `../plugins/${p.id}`]))
  put('host/.plugin-sources.example.json', mappings)
  for (const plugin of lock.plugins) put(`plugins/${plugin.id}/.rm-dev.example.json`, { toolchain: '../../host' })
  const inventory = pluginInventory(path => parse(files.get(path).data), [...files.keys()])
  put('plugins.json', inventory)
  put('插件功能清单.md', inventoryMarkdown(inventory))
  validateFiles(files)
  const publicPin = ({ id, version, commit, title }) => ({ id, version, commit, title })
  const provenance = { format: 1, status: 'source-snapshot', license: policy.license, host: publicPin(lock.host), plugins: lock.plugins.map(publicPin), policyHash: lock.policyHash, toolHash: lock.toolHash, transformations: ['public-document-overlays', 'official-plugin-licenses', 'exclude-private-and-generated-files', 'plugin-readme-current-usage', 'npm-registry-normalization', 'relative-config-examples', 'plugin-inventory'], files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, { mode, data }]) => ({ path, mode, bytes: data.length, sha256: hash(data) })) }
  put('source-manifest.json', provenance)
  mkdirSync(dirname(output), { recursive: true })
  const stage = mkdtempSync(join(dirname(output), '.source-draft-'))
  try {
    const source = join(stage, 'source'); mkdirSync(source)
    for (const [path, { data, mode }] of files) {
      const file = join(source, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); chmodSync(file, mode === '100755' ? 0o755 : 0o644)
    }
    archive(source, join(stage, 'source.zip'), gitText(lock.host.root, ['show', '-s', '--format=%ct', lock.host.commit]))
    writeFileSync(join(stage, 'source-manifest.json'), json(provenance))
    writeFileSync(join(stage, 'SHA256SUMS.txt'), ['source.zip', 'source-manifest.json'].map(name => `${hash(readFileSync(join(stage, name)))}  ${name}\n`).join(''))
    renameSync(stage, output)
    return { files: files.size, plugins: lock.plugins.length, output }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, input, output, ...rest] = process.argv.slice(2)
  try {
    if (rest.length || !input || !output || !['lock', 'export'].includes(command)) throw new Error('用法：source.mjs lock <来源配置.json> <新锁文件.json> | export <锁文件.json> <新输出目录>')
    const result = command === 'lock' ? lockSources(resolve(input), resolve(output)) : exportSources(resolve(input), resolve(output))
    console.log(command === 'lock' ? `已锁定宿主与 ${result.plugins.length} 个插件；锁文件含本机路径，仅留本机。` : `已提取 ${result.files} 个文件、${result.plugins} 个插件：${result.output}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
