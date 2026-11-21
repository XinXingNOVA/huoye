// 私有本机通道：stdio 桥接不打开数据库，也不转发任意 CoreApi。
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { z } from 'zod'
import { parseInput } from '../../shared/automation'

export const connectionSchema = z.object({
  libraryId: z.string().min(1), endpoint: z.string().min(1), token: z.string().min(32),
  mode: z.enum(['off', 'read', 'organize']), tools: z.enum(['daily', 'projects', 'development']).optional()
})
export type Connection = z.infer<typeof connectionSchema>
const requestSchema = z.object({
  libraryId: z.string().max(200), token: z.string().max(200),
  name: z.string().min(1).max(200), args: z.record(z.string(), z.unknown())
}).strict()
export type LocalRequest = z.infer<typeof requestSchema>
const longFileTasks = new Set(['configure_workbench', 'configure_library_plugins', 'install_packages', 'request_package_installation', 'create_library', 'resume_library_creation', 'open_library', 'show_library', 'prepare_file_edit', 'commit_file_edit', 'restore_file_version', 'apply_space_lifecycle', 'adopt_space_files'])
const MAX_BYTES = 256 * 1024
const MAX_REPLY_BYTES = 4 * 1024 * 1024
export const errorOf = (e: unknown) => {
  // Electron IPC 可能多层转交 Error。只移除开头的传输包装，保留业务消息正文。
  const text = (e instanceof Error ? e.message : String(e)).replace(/^(?:Error: |Error invoking remote method '[^'\n]+': )+/, '')
  const match = /^\[([A-Z_]+)\] (.*)$/s.exec(text)
  return { code: match?.[1] ?? 'OPERATION_FAILED', message: match?.[2] ?? text }
}

export function connectionError(error: NodeJS.ErrnoException) {
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return '[CONNECTION_DENIED] 本机连接被系统权限或客户端沙盒拒绝；请检查客户端的本机通道权限，重启仓库不能解除此限制'
  }
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    return '[LIBRARY_OFFLINE] 无法连接应用，请保持活页Huoye运行；连接后可使用 open_library 打开仓库'
  }
  return `[CONNECTION_FAILED] 本机通道连接失败（${error.code ?? 'UNKNOWN'}），请重新尝试连接`
}

export async function listenLocal(endpoint: string, handle: (request: LocalRequest) => Promise<unknown>) {
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    if (sockets.size >= 32) { socket.destroy(); return }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(20000, () => socket.destroy())
    let buffer = Buffer.alloc(0), handled = false
    const reply = (value: unknown) => {
      const text = JSON.stringify(value)
      socket.end((Buffer.byteLength(text) <= MAX_REPLY_BYTES ? text : JSON.stringify({ error: { code: 'RESPONSE_TOO_LARGE', message: '结果过大，请缩小读取范围' } })) + '\n')
    }
    socket.on('data', (data: Buffer) => {
      if (handled) return
      if (buffer.length + data.length > MAX_BYTES) { handled = true; reply({ error: { code: 'INVALID_INPUT', message: '请求过大' } }); return }
      buffer = Buffer.concat([buffer, data])
      const end = buffer.indexOf(10)
      if (end < 0) return
      handled = true
      let request: LocalRequest
      try { request = parseInput(requestSchema, JSON.parse(buffer.subarray(0, end).toString('utf8'))) }
      catch (e) { reply({ error: errorOf(e) }); return }
      if (longFileTasks.has(request.name)) socket.setTimeout(150000)
      void handle(request).then(result => reply({ result }), e => reply({ error: errorOf(e) }))
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); resolve() }) })
  return { close: () => { for (const socket of sockets) socket.destroy(); server.close() } }
}

export function callLocal(connection: Connection, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(connection.endpoint)
    let buffer = Buffer.alloc(0)
    const fail = (message: string) => { socket.destroy(); reject(new Error(message)) }
    socket.setTimeout(longFileTasks.has(name) ? 140000 : 18000, () => fail('[TIMEOUT] 调用超时；写入结果可能已提交，请使用相同 requestId 重试'))
    socket.on('error', error => fail(connectionError(error)))
    socket.on('connect', () => socket.write(JSON.stringify({ libraryId: connection.libraryId, token: connection.token, name, args }) + '\n'))
    socket.on('data', (data: Buffer) => {
      if (buffer.length + data.length > MAX_REPLY_BYTES) return fail('[RESPONSE_TOO_LARGE] 结果超过本机通道上限')
      buffer = Buffer.concat([buffer, data])
      const end = buffer.indexOf(10)
      if (end < 0) return
      socket.destroy()
      try {
        const response = JSON.parse(buffer.subarray(0, end).toString('utf8'))
        if (response.error) reject(new Error(`[${response.error.code}] ${response.error.message}`))
        else resolve(response.result)
      } catch { reject(new Error('[INVALID_RESPONSE] 本机通道返回了无效结果')) }
    })
    socket.on('end', () => reject(new Error('[LIBRARY_OFFLINE] 应用连接已关闭')))
  })
}
