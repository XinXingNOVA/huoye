import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewReceiveBatch } from '../../../shared/transfer'
import type { ViewImportCandidate } from '../../../shared/view-import'
import type { ContentDropOwner } from '../content-drop'
import type { ViewImportReviewRequest } from '../components/ViewImportReview'
import type { AdmissionReport } from '../admission-report'

export interface ReceiveBatch {
  id: string
  viewId: string
  surface: Extract<ContentDropOwner, { kind: 'view' }>
}
type WithoutIdentity<T> = T extends unknown ? Omit<T, 'id' | 'viewId'> : never
export function emitBatch(batch: ReceiveBatch, event: WithoutIdentity<ViewReceiveBatch>) {
  try { batch.surface.batch({ ...event, id: batch.id, viewId: batch.viewId }) }
  catch (error) { console.error('ReceiveSurface.onBatch', error) }
}

export function useIntakeFeedback() {
  const [reports, setReports] = useState<AdmissionReport[]>([])
  const reportLifetimes = useRef(new Map<string, AbortController>())
  const [detail, setDetail] = useState<string>()
  const [reviews, setReviews] = useState<ViewImportReviewRequest[]>([])
  const waiting = useRef(new Map<string, ViewImportReviewRequest>())
  const [requested, setRequested] = useState<string>()
  useEffect(() => () => {
    for (const r of waiting.current.values()) r.resolve(null)
    for (const report of reportLifetimes.current.values()) report.abort()
    reportLifetimes.current.clear()
  }, [])

  const showReview = useCallback((id: string) => {
    if (waiting.current.has(id)) { setRequested(id); void window.bridge.auxiliary.focus('main').catch(console.error) }
  }, [])
  const reviewImport = useCallback((title: string, candidates: ViewImportCandidate[], batch?: ReceiveBatch) =>
    new Promise<number[] | null>(resolve => {
      const id = batch?.id ?? crypto.randomUUID(), signal = batch?.surface.signal
      if (signal?.aborted) { resolve(null); return }
      const cancel = () => finish(null)
      function finish(selected: number[] | null) {
        if (!waiting.current.delete(id)) return
        signal?.removeEventListener('abort', cancel)
        setReviews([...waiting.current.values()])
        setRequested(current => current === id ? undefined : current)
        resolve(selected)
      }
      const row = { id, title, candidates, deferred: !!batch, resolve: finish }
      waiting.current.set(id, row)
      setReviews([...waiting.current.values()])
      signal?.addEventListener('abort', cancel, { once: true })
      if (batch) emitBatch(batch, { phase: 'review', open: () => showReview(id) })
    }), [showReview])

  const finishReview = (id: string, selected: number[] | null) => waiting.current.get(id)?.resolve(selected)
  const addReport = useCallback((report: AdmissionReport) => {
    const lifetime = new AbortController()
    reportLifetimes.current.set(report.id, lifetime)
    setReports(current => [...current, report])
    return { dismissed: lifetime.signal, open() {
      if (lifetime.signal.aborted) return
      setDetail(report.id)
      void window.bridge.auxiliary.focus('main').catch(console.error)
    } }
  }, [])
  const dismissReport = (id: string) => {
    reportLifetimes.current.get(id)?.abort()
    reportLifetimes.current.delete(id)
    setDetail(current => current === id ? undefined : current)
    setReports(current => current.filter(report => report.id !== id))
  }
  const review = reviews.find(r => r.id === requested) ?? reviews.find(r => !r.deferred)
  return { reports, detail, review, pendingReviews: reviews.filter(r => r.deferred), showReview, reviewImport, finishReview,
    addReport, dismissReport, closeDetail: () => setDetail(undefined) }
}
