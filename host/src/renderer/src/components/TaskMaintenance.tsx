import { useEffect, useState, type FormEvent } from 'react'
import { taskLimitMax, type LibraryTaskResult, type TaskCapacity, type TaskCleanupPlan, type TaskCleanupTarget, type TaskLimits, type TaskMarkerUsage, type TaskSummary } from '../../../shared/library-task'
import type { UiHost } from '../plugin'
import { SectionHeader, SettingGroup, SettingRow } from './ui-primitives'

const limitLabels: Record<keyof TaskLimits, string> = {
  tasks: '仓库任务数', drafts: '仓库未送审草稿数', attempts: '每项任务的导入尝试数', writes: '每项任务的业务写入数'
}
const stateLabels = { active: '进行中', completed: '已完成', abandoned: '已放弃' }
const pageSize = 20
const markerNoticeMiB = 64
const mib = 1024 ** 2

function formatMarkerBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const unit = bytes < mib ? 1024 : mib
  // 向下保留一位，提醒线以下不会提前显示 64 MiB。
  return `${Math.floor(bytes / unit * 10) / 10} ${unit === mib ? 'MiB' : 'KiB'}`
}

function LimitsForm({ capacity, save, busy }: { capacity: TaskCapacity; save: (limits: TaskLimits) => void; busy: boolean }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const limits = { ...capacity.limits }
    for (const key of Object.keys(limits) as (keyof TaskLimits)[]) limits[key] = Number(data.get(key))
    save(limits)
  }
  return <details className="task-limits"><summary>调整记录上限</summary>
    <form onSubmit={submit}>
      {(Object.keys(limitLabels) as (keyof TaskLimits)[]).map(key => <label key={key}>{limitLabels[key]}
        <input type="number" name={key} min={1} max={taskLimitMax[key]} step={1} required defaultValue={capacity.limits[key]} />
      </label>)}
      <p>调低上限会保留已有记录。达到上限后仍可送审、结束和清理任务。</p>
      <button disabled={busy} className="small">保存上限</button>
    </form>
  </details>
}

const sections = { inputs: '输入', attempts: '导入尝试', writes: '业务写入' }
const recordStates: Record<string, string> = { unattempted: '未尝试', running: '正在导入', interrupted: '已中断',
  failed: '失败', stored: '仅保存', created: '已收录', existing: '已存在', restored: '已恢复',
  draft: '未送审', pending: '待验收', confirmed: '已确认', withdrawn: '已撤回', discarded: '已丢弃', unavailable: '差异已清理' }

function TaskRecords({ taskId, host, discard }: { taskId: string; host: UiHost; discard: (request: string) => void }) {
  const [section, setSection] = useState<keyof typeof sections>('inputs')
  const [request, setRequest] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<Extract<LibraryTaskResult, { task: TaskSummary }>>()
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    const query = request ? { action: 'diff' as const, taskId, requestId: request, offset, limit: pageSize }
      : { action: 'get' as const, taskId, section, offset, limit: pageSize }
    setPage(undefined); setError('')
    host.core.libraryTask(query).then(result => {
      if (current && 'task' in result) setPage(result)
    }).catch(e => { if (current) setError(String(e)) })
    return () => { current = false }
  }, [host, taskId, section, offset, request])
  const show = (next: keyof typeof sections, id = '') => { setSection(next); setRequest(id); setOffset(0) }
  return <div className="task-records">
    <div className="database-maintenance-actions">{(Object.keys(sections) as (keyof typeof sections)[]).map(s =>
      <button className="small" key={s} aria-pressed={!request && section === s} onClick={() => show(s)}>{sections[s]}</button>)}</div>
    {page && <>
      <ul>{(page.inputs ?? page.attempts)?.map((row, index) => <li key={index}>
        {row.path} · {recordStates[row.state] ?? row.state}{row.requestId && ' · ' + row.requestId}{row.error && <p>{row.error}</p>}
      </li>)}
      {page.writes?.map(w => <li key={w.requestId}>{w.operation} · {w.requestId} · {recordStates[w.reviewState]}
        {w.reviewState === 'draft' && <button className="small" onClick={() => show('writes', w.requestId)}>查看差异</button>}
      </li>)}
      {page.draft?.items.map(item => <li key={item.id}>{item.id}
        {item.changes.map((c, i) => <p key={i}>{c.title} {c.member} · {JSON.stringify(c.before)} → {JSON.stringify(c.after)}{c.preserved && '（后来已修改）'}</p>)}
      </li>)}</ul>
      {(page.inputs ?? page.attempts ?? page.writes ?? page.draft?.items)?.length === 0 && <p>暂无记录。</p>}
      {page.draft && <button className="small" onClick={() => discard(request)}>预览丢弃这份草稿</button>}
      {(offset > 0 || page.nextOffset !== null) && <div className="database-maintenance-actions">
        <button className="small" disabled={!offset} onClick={() => setOffset(Math.max(0,offset-pageSize))}>上一页记录</button>
        <button className="small" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset ?? offset)}>下一页记录</button>
      </div>}
    </>}
    {error && <p role="alert" className="package-error">{error}</p>}
  </div>
}

function TaskActions({ task, host, changed }: { task: TaskSummary; host: UiHost; changed: (message: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [plan, setPlan] = useState<TaskCleanupPlan>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (e) { setPlan(undefined); setError(String(e)) }
    finally { setBusy(false) }
  }
  const close = (action: 'complete' | 'abandon') => run(async () => {
    await host.core.libraryTask({ action, taskId: task.taskId })
    changed(action === 'complete' ? '任务已完成。' : '任务已放弃，可继续查看记录或送审已有草稿。')
  })
  const preview = (mode: TaskCleanupTarget['mode'], requestId?: string) => run(async () => {
    setPlan(await host.core.previewTaskCleanup({ taskId: task.taskId, mode, requestId }))
  })
  const clean = () => run(async () => {
    if (!plan) return
    await host.core.cleanTask({ taskId: task.taskId, mode: plan.mode, requestId: plan.requestId }, plan.revision)
    changed(plan.mode === 'records' ? '任务明细已清理。' : '未送审草稿已丢弃，素材保留当前值。')
  })
  return <div className="task-actions" aria-busy={busy}>
    <div className="database-maintenance-actions">
      {task.state === 'active' && <>
        <button className="small" disabled={busy} onClick={() => void close('complete')}>完成任务</button>
        <button className="small" disabled={busy} onClick={() => void close('abandon')}>放弃后续处理</button>
      </>}
      <button className="small" disabled={busy} onClick={() => void preview('drafts')}>预览草稿清理</button>
      {task.state !== 'active' && <button className="small" disabled={busy} onClick={() => void preview('records')}>预览整项清理</button>}
    </div>
    <details onToggle={e => setExpanded(e.currentTarget.open)}><summary>查看任务明细</summary>
      {expanded && <>
        <p className="muted">{task.taskId} · {task.inputCount} 条输入 · {new Date(task.created).toLocaleString()} 创建</p>
        <TaskRecords taskId={task.taskId} host={host} discard={id => void preview('drafts', id)} />
      </>}
    </details>
    {plan && <div className="task-cleanup-preview">
      <strong>{task.title} · {plan.mode === 'records' ? '清理整项任务记录' : plan.requestId ? '丢弃草稿 ' + plan.requestId : '丢弃此任务的未送审草稿'}</strong>
      {plan.mode === 'records' && <p>将移除 {plan.inputs} 条来源路径、{plan.attempts} 条导入尝试（含 {plan.errors} 条错误）、{plan.preparations} 条导入准备记录及 {plan.writes} 条业务写入记录。</p>}
      <p>将丢弃 {plan.drafts} 份草稿，共 {plan.changes} 处差异。保留素材当前值及 {plan.reviews} 张已送审的验收单。</p>
      <div className="database-maintenance-actions">
        <button className="small" disabled={busy} onClick={() => setPlan(undefined)}>取消</button>
        <button className="small danger" disabled={busy || (plan.mode === 'drafts' && !plan.drafts)} onClick={() => void clean()}>
          {plan.mode === 'records' ? '确认清理任务记录' : '确认丢弃草稿'}
        </button>
      </div>
    </div>}
    {error && <p role="alert" className="package-error">{error}</p>}
  </div>
}

export function TaskMaintenance({ host, active }: { host: UiHost; active: boolean }) {
  const [capacity, setCapacity] = useState<TaskCapacity>()
  const [markers, setMarkers] = useState<TaskMarkerUsage>()
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [selected, setSelected] = useState('')
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const changed = (message: string) => { setNotice(message); setVersion(n => n + 1) }
  useEffect(() => {
    if (!active) return
    let current = true
    Promise.all([host.core.libraryTask({ action: 'list', offset, limit: pageSize }), host.core.taskMarkerUsage()]).then(([page, usage]) => {
      if (!current || !('tasks' in page)) return
      setMarkers(usage)
      setCapacity(page.capacity); setTasks(page.tasks); setNextOffset(page.nextOffset); setError('')
      if (!page.tasks.length && offset) setOffset(Math.max(0, offset - pageSize))
    }).catch(e => { if (current) setError(String(e)) })
    return () => { current = false }
  }, [host, active, version, offset])
  const save = async (limits: TaskLimits) => {
    setBusy(true)
    try { await host.core.taskCapacity(limits); changed('已保存本仓库上限。') }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const task = tasks.find(t => t.taskId === selected) ?? tasks[0]
  return <section className="database-maintenance task-maintenance" aria-label="AI 整理任务">
    <SectionHeader title="AI 整理任务" actions={<button className="small" onClick={() => changed('')}>刷新任务</button>} />
    {!capacity && !error && <p className="muted">正在读取任务记录…</p>}
    {capacity && <SettingGroup>
      <SettingRow title="任务与草稿" description={`任务 ${capacity.tasks} / ${capacity.limits.tasks} · 未送审草稿 ${capacity.drafts} / ${capacity.limits.drafts}`} />
      {markers && <SettingRow className="task-marker-usage" title="防重记录" description={<>
        任务标记 {markers.tasks.toLocaleString('zh-CN')} 条 · 请求标记 {markers.requests.toLocaleString('zh-CN')} 条 · 估算占用 {formatMarkerBytes(markers.estimatedBytes)}
        {markers.estimatedBytes >= markerNoticeMiB * mib && <span role="status" className="task-marker-notice">
          本库防重记录的估算占用已达到 {markerNoticeMiB} MiB 提醒线。旧请求仍受防重保护，新任务可照常使用。
        </span>}
      </>} />}
      <LimitsForm key={JSON.stringify(capacity.limits)} capacity={capacity} save={save} busy={busy} />
    </SettingGroup>}
    {task && <SettingGroup title="任务记录">
      <SettingRow title={<label htmlFor="maintenance-task">选择任务</label>}>
        <select id="maintenance-task" value={task.taskId} onChange={e => { setSelected(e.target.value); setNotice('') }}>
          {tasks.map(t => <option key={t.taskId} value={t.taskId}>{t.title} · {stateLabels[t.state]}</option>)}
        </select>
      </SettingRow>
      {(offset > 0 || nextOffset !== null) && <div className="database-maintenance-actions">
        <button className="small" disabled={!offset} onClick={() => setOffset(Math.max(0, offset-pageSize))}>上一页</button>
        <button className="small" disabled={nextOffset === null} onClick={() => nextOffset !== null && setOffset(nextOffset)}>下一页</button>
      </div>}
      <TaskActions key={task.taskId + ':' + version} task={task} host={host} changed={changed} />
    </SettingGroup>}
    {error && <p role="alert" className="package-error">{error}</p>}
    {notice && <p role="status" className="database-maintenance-notice">{notice}</p>}
  </section>
}
