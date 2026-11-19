import { createRequire } from 'node:module'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const host = process.env.RM_PLUGIN_TOOLCHAIN ?? JSON.parse(readFileSync('.rm-dev.json', 'utf8')).toolchain
const require = createRequire(resolve(host, 'package.json'))
const { build } = require('esbuild')
const paths = JSON.parse(readFileSync('.rm-sdk.json', 'utf8')).compilerOptions.paths
const alias = Object.fromEntries(Object.entries(paths).filter(([k]) => k.startsWith('@resource-manager/')).map(([k,v]) => [k,v[0]]))
alias.zod = require.resolve('zod')
mkdirSync('artifacts', { recursive:true })
await build({ entryPoints:['tests/spec.ts'], outfile:'artifacts/test.cjs', bundle:true, platform:'node', format:'cjs', alias })
await import(pathToFileURL(resolve('artifacts/test.cjs')).href)
