import { displayDocument } from '../display-windows'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommandItem, CommandSession } from '../../../plugin-api/ui/commands'
import type { UiHost } from '../plugin'

/** 仅持有当前窗口展示的会话；上下文快照、命令校验和执行仍归命令服务。 */
export function useCommandPalette(host: UiHost, notify: UiHost['notify']) {
  const [display, setDisplay] = useState<Document>()
  const [commandSession, setCommandSession] = useState<CommandSession>()
  const commandSessionRef = useRef<CommandSession>(undefined)
  useEffect(() => () => commandSessionRef.current?.dispose(), [])
  const openCommandPalette = useCallback(() => {
    try {
      const session = host.commands.createSession()
      commandSessionRef.current?.dispose()
      commandSessionRef.current = session
      setDisplay(displayDocument()); setCommandSession(session)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    }
  }, [host, notify])

  const closeCommandPalette = useCallback(() => {
    const current = commandSessionRef.current
    commandSessionRef.current = undefined
    setCommandSession(undefined)
    current?.dispose()
  }, [])

  const executeCommand = useCallback((session: CommandSession, item: CommandItem) => {
    if (commandSessionRef.current === session) commandSessionRef.current = undefined
    setCommandSession(undefined)
    void (async () => {
      try {
        await session.execute(item.id)
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
      } finally {
        session.dispose()
      }
    })()
  }, [notify])

  return { display, session: commandSession, open: openCommandPalette, close: closeCommandPalette, execute: executeCommand }
}
