import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = mkdtempSync(join(tmpdir(), 'rm-suite-pack-'))
try {
  const outfile = join(dir, 'pack.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('./suite-entry.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  execFileSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' })
} finally { rmSync(dir, { recursive: true, force: true }) }
