import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { useEffect, useRef, useState } from 'react'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { EditDestination, FileEditingTask, EditingEndCheck } from '@resource-manager/plugin-api/ui/file-editing'
import type { FileEditCapabilities } from '@resource-manager/plugin-api/files'
import { editingLabel, useFileEditing } from './state'
import { EditorChooser } from './EditorChooser'
import './file-editing.css'

const uiText = packageMessages('file-editing')


type FileStorageInfo = Awaited<ReturnType<UiHost['core']['fileStorageInfo']>>

const message = (e: unknown) => e instanceof Error ? e.message : String(e)
export function showEditing(host: UiHost, task: FileEditingTask, error = '') {
  host.showDialog(close => <EditingDialog initial={task} host={host} close={close} initialError={error} />)
}
/** 普通编辑入口直接创建／复用工作副本。查看仍走 host.open，不改变素材的已接纳引用。 */
export async function startFileEditing(host: UiHost, id: string, replacement = false, chooseEditor = false) {
  let task: FileEditingTask | undefined
  try {
    task = replacement ? await host.fileEditing.chooseReplacement(id) ?? undefined : await host.fileEditing.start({ id })
    if (!task) return
    if (replacement || task.phase === 'cleanup' || task.phase === 'unadopted') { showEditing(host, task); return }
    await openWorkingCopy(host, task, chooseEditor)
  } catch (e) { if (task) showEditing(host, task, message(e)); else host.notify(message(e)) }
}
async function openWorkingCopy(host: UiHost, task: FileEditingTask, choose = false): Promise<boolean> {
  const options = await host.fileEditing.editorOptions(task.id)
  if (choose || !options.preferred && !options.systemAllowed) {
    host.showDialog(close => <EditorChooser host={host} task={task} initial={options} close={close} />)
    return false
  }
  await host.fileEditing.open(task.id)
  host.notify(uiText("已打开工作副本；外部保存并关闭后，在“编辑中”完成编辑"))
  return true
}
export async function finishFileEditing(host: UiHost, task: FileEditingTask) {
  try {
    if (task.ended || task.error || task.phase === 'unadopted') { showEditing(host, task); return }
    if (task.phase !== 'cleanup' && task.phase !== 'pending' && task.phase !== 'saving') {
      const info = await host.core.fileStorageInfo(task.itemId)
      if (info.mode === 'shared') { showEditing(host, task); return }
    }
    const retained = await host.fileEditing.finish({ taskId: task.id })
    if (retained) showEditing(host, retained)
    else host.notify(uiText("编辑已完成，工作副本已清理"))
  } catch (e) { showEditing(host, task, message(e)) }
}

export function FileEditingControls({ id, host, onlyActive = false }: { id: string; host: UiHost; onlyActive?: boolean }) {
  useUiLocale()
  const { tasks, ready } = useFileEditing()
  const task = tasks.find(t => t.itemId === id && !t.ended) ?? tasks.find(t => t.itemId === id)
  const [busy, setBusy] = useState(false), running = useRef(false)
  const run = async (fn: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true)
    try { await fn() } finally { running.current = false; setBusy(false) }
  }
  if (onlyActive && !task) return null
  return <div className="file-editing-controls" aria-label={uiText("文件编辑状态")}>
    {task && <span className="muted">{editingLabel(task)}</span>}
    {(!task || !task.ended && task.phase !== 'cleanup') && <button className="small" disabled={busy || !ready} onClick={() => void run(() => startFileEditing(host, id))}>{task ? uiText("继续编辑") : uiText("编辑文件")}</button>}
    {task && <><button className="small primary" title={uiText("请先在外部应用保存并关闭文件；完成后清理工作副本")} disabled={busy} onClick={() => void run(() => finishFileEditing(host, task))}>{task.phase === 'cleanup' ? uiText("重试清理") : task.ended ? uiText("处理工作副本…") : uiText("完成编辑")}</button>
      <button className="small" disabled={busy} aria-label={uiText("编辑选项")} onClick={() => showEditing(host, task)}>⋯</button></>}
    {!task && <button className="small" disabled={busy || !ready} onClick={() => void run(() => startFileEditing(host, id, false, true))}>{uiText("选择编辑器…")}</button>}
    {!task && <button className="small" disabled={busy || !ready} onClick={() => void run(() => startFileEditing(host, id, true))}>{uiText("选择替换文件…")}</button>}
    {busy && <span className="muted" role="status">{uiText("正在处理…")}</span>}
  </div>
}

function EditingDialog({ initial, host, close, initialError }: { initial: FileEditingTask; host: UiHost; close(): void; initialError: string }) {
  useUiLocale()
  const { tasks, refresh } = useFileEditing()
  const task = tasks.find(t => t.id === initial.id) ?? initial
  const [caps, setCaps] = useState<FileEditCapabilities>(), [info, setInfo] = useState<FileStorageInfo>()
  const [target, setTarget] = useState<EditDestination>(initial.destination ?? { mode: 'publish' })
  const [busy, setBusy] = useState(false), [error, setError] = useState(initialError), [notice, setNotice] = useState('')
  const [discard, setDiscard] = useState<EditingEndCheck>()
  const running = useRef(false)
  useEffect(() => {
    let alive = true
    void Promise.all([host.core.fileEditCapabilities(task.itemId), host.core.fileStorageInfo(task.itemId)]).then(([c, i]) => { if (alive) { setCaps(c); setInfo(i) } }).catch(e => { if (alive) setError(message(e)) })
    return () => { alive = false }
  }, [host.core, task.itemId, task.updatedAt])
  const run = async (fn: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(message(e)) }
    finally { await refresh(); running.current = false; setBusy(false) }
  }
  const destination = task.destination ?? target, attempted = !!task.destination
  const finish = () => run(async () => {
    const retained = await host.fileEditing.finish({ taskId: task.id, destination })
    if (retained) setNotice(retained.lastResult?.library.error ?? uiText("保存尚未完成，请重试"))
    else { close(); host.notify(uiText("编辑已完成，工作副本已清理")) }
  })
  return <section className="file-editing-dialog" aria-label={uiText("完成文件编辑")}>
    <h2>{task.name}</h2><p className="muted">{editingLabel(task)}{task.baseOrdinal ? uiText(" · 编辑基线 V{baseOrdinal}", { baseOrdinal: String(task.baseOrdinal) }) : ''}</p>
    <p>{uiText("先在外部应用中保存并关闭文件，再完成编辑。完成后保留原有版本、更新本库内容，并清理本机工作副本。")}</p>
    {info?.mode === 'shared' && destination.mode === 'publish' && <p className="file-editing-notice">{uiText("将发布共享文件的新版本；其他仓库按各自规则接纳。")}</p>}
    {(error || task.error) && <p className="file-editing-error" role="alert">{error || task.error}</p>}
    {task.phase === 'unadopted' && <p className="file-editing-error">{task.lastResult?.library.error}{uiText("。空间保留已保存版本；请先核对素材，再决定是否清理工作副本。")}</p>}
    {notice && <p role="status">{notice}</p>}
    {!task.ended && task.phase !== 'cleanup' && task.phase !== 'unadopted' && <details open={!!error || !!task.error || undefined}>
      <summary>{uiText("保存方式与修改预览")}</summary>
      <label className="file-editing-destination">{uiText("保存到")}<select aria-label={uiText("文件编辑保存方式")} disabled={busy || attempted} value={destination.mode === 'copy' ? destination.spaceId : 'publish'} onChange={e => setTarget(e.target.value === 'publish' ? { mode: 'publish' } : { mode: 'copy', spaceId: e.target.value })}>
        <option value="publish">{uiText("更新当前文件")}</option>{caps?.copyTargets.map(t => <option key={t.spaceId} value={t.spaceId}>{uiText("独立副本 ·")}{' '}{t.name}</option>)}
      </select></label>
      {destination.mode === 'copy' && <p className="muted">{uiText("保存到独享空间，并切换当前素材的引用；原文件及其他仓库保持原状。")}</p>}
      {destination.mode === 'publish' && caps && !caps.publish.allowed && <p className="file-editing-error">{caps.publish.reason}</p>}
      <div className="file-editing-controls"><button className="small" disabled={busy} onClick={() => void run(async () => { const checked = await host.fileEditing.check({ taskId: task.id, destination }); if (checked.unchanged) setNotice(uiText("没有新修改，完成编辑只清理工作副本")) })}>{uiText("预览修改")}</button>
        {attempted && <button className="small" disabled={busy} onClick={() => void run(async () => { await host.fileEditing.discardPrepared(task.id) })}>{uiText("重新检查／更换保存方式")}</button>}</div>
      {task.prepared && <div className="file-editing-preview">
        {/^(png|jpe?g|webp|gif|avif)$/i.test(task.format) && <div className="file-editing-images"><figure><img src={host.url(task.baseReference)} alt={uiText("编辑基线")} /><figcaption>{uiText("编辑基线")}</figcaption></figure><figure><img src={host.url(task.prepared.reference)} alt={uiText("待保存修改")} /><figcaption>{uiText("待保存修改")}</figcaption></figure></div>}
        {task.prepared.sample !== undefined && <pre>{task.prepared.sample}{task.prepared.size > 4096 ? uiText("\n…（前 4 KB）") : ''}</pre>}
        <p className="muted">{uiText("标签、笔记等数据保留，派生内容重新生成；正文位置相关的批注需自行核对。")}</p>
      </div>}
    </details>}
    <div className="file-editing-controls"><button className="small" disabled={busy} onClick={() => void run(() => host.fileEditing.reveal(task.id))}>{uiText("显示工作副本")}</button>
      {task.phase === 'unadopted' && <button className="small" onClick={() => { close(); host.openData(task.itemId) }}>{uiText("查看素材")}</button>}
      {!task.ended && task.phase !== 'cleanup' && <button className="small" disabled={busy} onClick={() => void run(async () => { if (await openWorkingCopy(host, task)) close() })}>{uiText("继续编辑")}</button>}
      {!task.ended && task.phase !== 'cleanup' && <button className="small" disabled={busy} onClick={() => void run(async () => { await openWorkingCopy(host, task, true) })}>{uiText("选择编辑器…")}</button>}
      <button className="small danger" disabled={busy} onClick={() => void run(async () => setDiscard(await host.fileEditing.inspectEnd(task.id)))}>{task.ended || task.phase === 'unadopted' ? uiText("清理工作副本…") : uiText("放弃修改…")}</button></div>
    {discard && <div className="space-confirm" role="group" aria-label={uiText("放弃修改确认")}><p>{uiText("删除此工作副本和预览快照，未保存的修改将丢失。素材与已有空间版本保留。请先关闭外部编辑器。")}</p>
      {discard.problem && <p className="file-editing-error">{discard.problem}</p>}
      <div className="file-editing-controls"><button disabled={busy} onClick={() => setDiscard(undefined)}>{uiText("返回")}</button><button className="danger" disabled={busy} onClick={() => void run(async () => { await host.fileEditing.discard(task.id, discard.token); close(); host.notify(uiText("工作副本已清理")) })}>{uiText("确认放弃并清理")}</button></div></div>}
    <footer><button disabled={busy} onClick={close}>{uiText("暂不完成")}</button>{(!task.ended || task.phase === 'cleanup') && task.phase !== 'unadopted' && <button className="primary" disabled={busy} onClick={() => void finish()}>{busy ? uiText("正在处理…") : task.phase === 'cleanup' ? uiText("重试清理") : task.phase === 'pending' ? uiText("重试接纳并完成") : uiText("完成编辑")}</button>}</footer>
  </section>
}
