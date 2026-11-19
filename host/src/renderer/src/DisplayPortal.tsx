import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { UiDocumentContext } from '../../plugin-api/ui/internal/document'
import { displayDocument } from './display-windows'
/** 浮层只改变显示归属；调用上下文和业务仍由原服务拥有。 */
export function DisplayPortal({ doc = displayDocument(), children }: { doc?: Document; children: ReactNode }) {
  const target = doc.defaultView?.closed ? document : doc
  return createPortal(<UiDocumentContext.Provider value={target}>{children}</UiDocumentContext.Provider>, target.body)
}
