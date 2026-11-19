import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const mode = process.argv[2] ?? 'dev'
if (!['dev', 'preview'].includes(mode)) throw new Error('只支持 dev 或 preview')
const child = spawn(process.execPath, [resolve(root, 'node_modules/electron-vite/bin/electron-vite.js'), mode, ...process.argv.slice(3)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, RM_USER_DATA: process.env.RM_USER_DATA || resolve(root, '.local/user-data') }
})
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
