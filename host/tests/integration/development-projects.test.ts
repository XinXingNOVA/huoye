import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DevelopmentProjects } from '../../src/main/development-projects'

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rm-project-'))); dirs.push(dir)
  const root = join(dir, 'library'), registry = join(dir, 'registry')
  mkdirSync(root)
  const target = { root, libraryId: 'one' }
  const input = { libraryId: 'one', requestId: 'first-project', title: '图片', pluginId: 'image-caption' }
  return { dir, target, registry, input, projects: new DevelopmentProjects(registry) }
}
it('工程目录不跟随外部链接，同一路径登记为另一库时不继承来源', () => {
  const { dir, target, input, projects } = fixture()
  const outside = join(dir, 'outside'), base = join(target.root, '.rm-plugin-projects'); mkdirSync(outside)
  symlinkSync(outside, base, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => projects.create(target, input)).toThrow('SOURCE_CHANGED')
  expect(readdirSync(outside)).toEqual([])
  rmSync(base)
  projects.create(target, input)
  expect(projects.sources({ ...target, libraryId: 'replacement' })).toEqual([])
})
it('落盘后中断可以接续原工程，完成后重试保留代码，已移除的源码不会被模板覆盖', () => {
  const { target, input, registry, projects } = fixture()
  const source = projects.create(target, input), core = join(source, 'core.ts')
  const [record] = JSON.parse(readFileSync(join(registry, readdirSync(registry)[0]), 'utf8'))
  renameSync(source, join(dirname(source), record.staging))
  const restarted = new DevelopmentProjects(registry)
  expect(restarted.create(target, input)).toBe(source)
  writeFileSync(core, 'user edits')
  expect(restarted.create(target, input)).toBe(source)
  expect(readFileSync(core, 'utf8')).toBe('user edits')
  renameSync(source, source + '-moved')
  expect(() => restarted.create(target, input)).toThrow('SOURCE_CHANGED')
})
