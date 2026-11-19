import { useEffect, useRef } from 'react'
import type { KeyHandler } from './contracts'

/** 保持按键订阅稳定；处理器使用当前渲染的状态，卸载自动解除。 */
export function useKeys(register: (h: KeyHandler | null) => void, handler: KeyHandler): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    register((e) => ref.current(e))
    return () => register(null)
  }, [register])
}

export { useUiEffect, useUiFrame, type UiDisplayEffect } from './internal/display-effect'
