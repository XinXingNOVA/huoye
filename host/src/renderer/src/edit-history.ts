import type { EditChange } from '../../plugin-api/ui/editing'
const IDLE = 1000
const MAX_GROUP = 5000
interface Group { source: string; kind: string; composition?: string; caret: number; at: number; started: number }

/** 只合并可确认的相邻输入。保存是否发生不决定编辑边界。 */
export class EditHistory {
  private past: string[] = []
  private future: string[] = []
  private group?: Group
  get canUndo() { return !!this.past.length }
  get canRedo() { return !!this.future.length }
  break() { this.group = undefined }
  clear() { this.past = []; this.future = []; this.break() }
  record(before: string, after: string, input?: EditChange) {
    const next = this.intent(before, after, input), previous = this.group, now = Date.now()
    const merge = next && previous && next.source === previous.source && next.kind === previous.kind && (
      next.composition ? next.composition === previous.composition :
      !previous.composition && input!.before.start === previous.caret && now - previous.at <= IDLE && now - previous.started <= MAX_GROUP
    )
    if (!merge) {
      this.past.push(before)
      while (this.past.length > 1 && (this.past.length > 100 || this.past.reduce((n, s) => n + s.length, 0) > 2_000_000)) this.past.shift()
    }
    this.future = []
    this.group = next ? { ...next, at: now, started: merge ? previous!.started : now } : undefined
    // 空白／标点结束一段输入（含分隔符）；下一词、下一句开始新的撤销单元。
    if (next?.kind === 'insertText' && /[\s.,;:!?，。！？；：、]/u.test(after.slice(input!.before.start, input!.after.start))) this.break()
    // 输入法取消并回到原文时，不留下空撤销步。
    if (this.past.at(-1) === after) { this.past.pop(); this.break() }
  }
  undo(current: string) { this.break(); const text = this.past.pop(); if (text !== undefined) this.future.push(current); return text }
  redo(current: string) { this.break(); const text = this.future.pop(); if (text !== undefined) this.past.push(current); return text }
  private intent(before: string, after: string, input?: EditChange): Omit<Group, 'at' | 'started'> | undefined {
    if (!input) return
    const { source, inputType, before: a, after: b, composition } = input
    if (composition) return { source, kind: 'composition', composition, caret: b.end }
    if (a.start !== a.end || b.start !== b.end) return
    const delta = after.length - before.length, p = a.start
    const group = { source, kind: inputType, caret: b.start }
    if (inputType === 'insertText' && delta > 0 && b.start === p + delta &&
      after.slice(0, p) === before.slice(0, p) && after.slice(p + delta) === before.slice(p) && !/[\r\n]/.test(after.slice(p, p + delta))) return group
    if (inputType === 'deleteContentBackward' && delta < 0 && p + delta >= 0 && b.start === p + delta &&
      after === before.slice(0, p + delta) + before.slice(p)) return group
    if (inputType === 'deleteContentForward' && delta < 0 && b.start === p &&
      after === before.slice(0, p) + before.slice(p - delta)) return group
  }
}
