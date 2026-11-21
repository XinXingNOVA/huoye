import Database from 'better-sqlite3'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { bindingPath, type SpaceBinding } from '../storage/space-bindings'
import { FileSpace } from '../storage/file-space'
import { SpaceDisk } from '../storage/space-disk'
import type { DirectorySpaces } from '../storage/directory-spaces'
import type { SpaceBindingInfo } from '../shared/file-spaces'
import type { SourceCheckInput, SourceCheckStatus } from '../shared/source-automation'
import { reserveSpaceCheck } from './space-check-lock'

type Member = { id: string; root: string }
type Job = { status: SourceCheckStatus; controller: AbortController }
export class SourceChecks {
  private jobs = new Map<string, Job>()
  constructor(private directories: () => DirectorySpaces, private track?: (work: Promise<void>) => void,
    private notify?: (spaceId: string, directory: boolean) => void | Promise<void>) {}

  run(member: Member, ownerKey: string, input: SourceCheckInput, managed: SpaceBindingInfo | undefined, guard: () => void) {
    const { action, requestId, spaceId } = input, key = JSON.stringify([ownerKey, requestId])
    const old = this.jobs.get(key)
    if (old) {
      if (old.status.spaceId !== spaceId) throw new Error('[REQUEST_ID_CONFLICT] 核对任务属于其他空间')
      if (action === 'cancel' && old.status.state === 'running') old.controller.abort()
      return { ...old.status }
    }
    if (action !== 'start') throw new Error('[CHECK_NOT_FOUND] 当前服务会话没有这份核对回执，请用新请求开始核对')
    if (this.jobs.size >= 128) {
      const completed = [...this.jobs].find(([,j]) => j.status.state !== 'running')
      if (!completed) throw new Error('[SPACE_CHECK_BUSY] 核对任务已满，请稍后再试')
      this.jobs.delete(completed[0])
    }
    const release = reserveSpaceCheck(spaceId), controller = new AbortController()
    const status: SourceCheckStatus = { requestId, spaceId, state: 'running', checked: 0, failed: 0 }
    this.jobs.set(key, { status, controller })
    const monitor = () => { try { guard() } catch { controller.abort() } }
    const timer = setInterval(monitor, 100)
    const work = async () => {
      try {
        if (managed) {
          const space = new FileSpace(managed.root, spaceId)
          let library: Database.Database | undefined
          try {
            library = new Database(join(member.root, 'library.db'), { readonly: true, fileMustExist: true })
            const binding = library.prepare("SELECT * FROM file_spaces WHERE id=? AND state='active'")
            const token = (binding.get(spaceId) as SpaceBinding | undefined)?.token
            const checkMember = () => {
              guard()
              const current = binding.get(spaceId) as SpaceBinding | undefined
              if (!current || current.token !== token || bindingPath(member.root, current) !== managed.root)
                throw new Error('[SPACE_NOT_LINKED] 空间关联已变化')
              space.assertMember(member.id, current.token, current.embedded ? undefined : realpathSync(member.root))
            }
            checkMember()
            let nextCheck = 0
            const check = await new SpaceDisk(space).check({ spaceId, requestId }, controller.signal, p => {
              if (Date.now() >= nextCheck || p.checked === p.total) {
                checkMember(); nextCheck = Date.now() + 100
              }
              status.checked = p.checked; status.total = p.total
            })
            status.fileIssues = check.fileIssues ?? 0
            status.state = check.cancelled ? 'cancelled' : status.fileIssues ? 'partial' : 'completed'
          } finally { library?.close(); space.close() }
        } else {
          const result = await this.directories().refreshTree(member, spaceId, controller.signal, false, (checked, failed) => {
            monitor(); status.checked = checked; status.failed = failed
          })
          status.fileIssues = result.fileIssues.total
          status.state = result.cancelled ? 'cancelled' : result.failed || status.fileIssues ? 'partial' : 'completed'
        }
      } catch {
        status.state = controller.signal.aborted ? 'cancelled' : 'failed'
        status.message = '核对未完成，请检查空间位置、读取权限和关联状态'
      } finally {
        clearInterval(timer); release()
        try { await this.notify?.(spaceId, !managed) } catch (e) { console.warn('[source-check] 未能刷新窗口', e) }
      }
    }
    const running = work()
    this.track?.(running)
    return { ...status }
  }
}
