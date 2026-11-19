import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { LocalServicePlugin } from '@resource-manager/plugin-api/local-service'
const settings = z.object({ prefix: z.string().max(100) }).strict()
const input = z.object({ text: z.string().min(1).max(4000), delay: z.number().int().min(1).max(1000).default(70), endpoint: z.string().url().optional() }).strict()
export const plugin: LocalServicePlugin = {
  id: 'demo-service',
  start(ctx) {
    // 所有实例状态在 start 内；同一模块可能同时用于多个仓库。
    let running = 0
    return {
      invoke(method, value) {
        if (method === 'configure') ctx.settings.set('application', 'prefix', settings.parse(value).prefix)
        else if (method === 'setKey') ctx.secrets.set('application', 'key', z.string().max(1000).parse(value))
        else if (method === 'removeKey') ctx.secrets.remove('application', 'key')
        else if (method !== 'settings') throw new Error('未知方法')
        return { prefix: ctx.settings.get('application', 'prefix') ?? '回显：', hasKey: ctx.secrets.has('application', 'key'), protectedStorage: ctx.secrets.available(), running, runs: ctx.settings.get('library', 'runs') ?? 0 }
      },
      async stream(method, value, { emit, signal }) {
        if (method !== 'echo') throw new Error('未知持续调用')
        const args = input.parse(value)
        running++
        ctx.settings.set('library', 'runs', Number(ctx.settings.get('library', 'runs') ?? 0) + 1)
        try {
          await emit({ credentialReady: ctx.secrets.has('application', 'key') && !!ctx.secrets.get('application', 'key') })
          await emit({ delta: String(ctx.settings.get('application', 'prefix') ?? '回显：') })
          if (args.endpoint) {
            // 仅供本机回归服务器，展示流式网络读与取消，不发送凭据。
            const url = new URL(args.endpoint)
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('示例网络端点只允许本机回归服务器')
            const response = await fetch(url, { method: 'POST', body: args.text, signal, redirect: 'error' })
            if (!response.ok || !response.body) throw new Error('示例请求失败')
            const reader = response.body.getReader(), decoder = new TextDecoder()
            try {
              while (true) { const part = await reader.read(); if (part.done) break; await emit({ delta: decoder.decode(part.value, { stream: true }) }) }
              const rest = decoder.decode(); if (rest) await emit({ delta: rest })
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
          } else {
            for (const char of args.text) { await delay(args.delay, undefined, { signal }); await emit({ delta: char }) }
          }
        } finally { running-- }
      }
    }
  }
}
