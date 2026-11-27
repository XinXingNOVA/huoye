// 运行外部程序：取消时杀掉子进程；失败时带上 stderr 的最后几行。

import { StringDecoder } from 'node:string_decoder'
import { spawn } from 'node:child_process'

export interface RunOptions {
  signal: AbortSignal
  /** 宿主托管的 POSIX CLI 独立进程组，取消时连同其后代一起终止。 */
  processGroup?: boolean
  /** 收集 stdout 的最大字节数，超过即终止进程。 */
  maxOutputBytes?: number
  /** 逐行收到 stdout（用于 ffmpeg -progress）。 */
  onLine?: (line: string) => void
  /** stderr 可同时携带进度，错误尾部仍会保留。 */
  onStderrLine?: (line: string) => void
}

export function run(program: string, args: string[], { signal, onLine, onStderrLine, maxOutputBytes, processGroup }: RunOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('已取消'))
    const detached = !!processGroup && process.platform !== 'win32'
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached })
    const out: Buffer[] = []
    let bytes = 0
    let oversized = false
    let err = ''
    let partial = ''
    let stderrPartial = ''

    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8')
    const onAbort = () => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* 程序可能已经退出 */ }
      }
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      if (oversized) return
      bytes += chunk.length
      if (maxOutputBytes !== undefined && bytes > maxOutputBytes) {
        oversized = true
        onAbort()
        return
      }
      if (!onLine) return void out.push(chunk)
      partial += stdout.write(chunk)
      const lines = partial.split('\n')
      partial = lines.pop()!
      for (const line of lines) onLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = stderr.write(chunk)
      err = (err + text).slice(-4000)
      if (onStderrLine) {
        const lines = (stderrPartial + text).split('\n')
        stderrPartial = lines.pop()!.slice(-4000)
        for (const line of lines) onStderrLine(line)
      }
    })
    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code, exitSignal) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(new Error('已取消'))
      if (oversized) return reject(new Error('[CAPABILITY_OUTPUT_LIMIT] 程序输出超过上限'))
      partial += stdout.end()
      stderrPartial += stderr.end()
      if (partial) onLine?.(partial)
      if (stderrPartial) onStderrLine?.(stderrPartial)
      if (code === 0) return resolve(Buffer.concat(out))
      const tail = err.trim().split('\n').slice(-3).join(' / ')
      const reason = exitSignal ? '收到信号 ' + exitSignal : '退出码 ' + code
      reject(new Error(`${program.split(/[\\/]/).pop()} ${reason}${tail ? `：${tail}` : ''}`))
    })
  })
}
