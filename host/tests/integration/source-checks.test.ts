import { expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SourceChecks } from '../../src/main/source-checks'
import { DirectorySpaces } from '../../src/storage/directory-spaces'
import { openHost, tempDir } from '../helpers/helpers'

it('只允许发起核对的仓库取消，同一空间释放后可以重新核对', async () => {
  const h = openHost(), home = tempDir(), tasks: Promise<void>[] = []
  try {
    const root = join(home, '来源')
    mkdirSync(root)
    const spaces = new DirectorySpaces(join(home, '登记簿')), member = h.host.lib
    const { id: spaceId } = spaces.attach(member, root)
    const checks = new SourceChecks(() => spaces, task => tasks.push(task))
    const requestId = randomUUID()
    const run = (action: 'start' | 'status' | 'cancel', owner = 'A', request = requestId) =>
      checks.run(member, owner, { action, spaceId, requestId: request }, undefined, () => {})
    expect(run('start').state).toBe('running')
    expect(run('start').state).toBe('running')
    expect(tasks).toHaveLength(1)
    expect(() => run('cancel', 'B')).toThrow('CHECK_NOT_FOUND')
    expect(() => run('start', 'B')).toThrow('SPACE_CHECK_BUSY')
    run('cancel')
    await Promise.all(tasks)
    expect(run('status').state).toBe('cancelled')
    const next = randomUUID()
    run('start', 'B', next)
    await Promise.all(tasks)
    expect(run('status', 'B', next)).toMatchObject({ state: 'completed', failed: 0 })
  } finally {
    await Promise.all(tasks); h.cleanup(); rmSync(home, { recursive: true, force: true })
  }
})
