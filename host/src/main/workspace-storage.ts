import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

const workspaceFile = (libraryId: string) => join(app.getPath('userData'), 'workspaces', `${libraryId.replace(/[^0-9a-zA-Z-]/g, '')}.json`)
export async function loadWorkspace(libraryId: string): Promise<any> {
  try { return JSON.parse(await readFile(workspaceFile(libraryId), 'utf8')) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
const saving = new Map<string, Promise<void>>()
/** 防抖、关闭前保存和方案接续共用同一条写队列。 */
export function saveWorkspace(libraryId: string, data: unknown) {
  const file = workspaceFile(libraryId)
  const next = (saving.get(file) ?? Promise.resolve()).then(async () => {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(data))
    await rename(file + '.tmp', file)
  })
  const settled = next.catch(() => {})
  saving.set(file, settled)
  void settled.then(() => { if (saving.get(file) === settled) saving.delete(file) })
  return next
}
