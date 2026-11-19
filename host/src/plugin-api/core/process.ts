// 运行外部程序：取消时杀掉子进程；失败时带上 stderr 的最后几行。

import { spawn } from 'node:child_process'

export interface RunOptions {
  signal: AbortSignal
  /** 逐行收到 stdout（用于 ffmpeg -progress）。 */
  onLine?: (line: string) => void
}

export function run(program: string, args: string[], { signal, onLine }: RunOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('已取消'))
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    let partial = ''

    const onAbort = () => child.kill('SIGKILL')
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      if (!onLine) return void out.push(chunk)
      partial += chunk.toString()
      const lines = partial.split('\n')
      partial = lines.pop()!
      for (const line of lines) onLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString()).slice(-4000)
    })
    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(new Error('已取消'))
      if (code === 0) return resolve(Buffer.concat(out))
      const tail = err.trim().split('\n').slice(-3).join(' / ')
      reject(new Error(`${program.split('/').pop()} 退出码 ${code}${tail ? `：${tail}` : ''}`))
    })
  })
}
