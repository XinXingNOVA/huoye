import { updateLibraryPackage } from './package-update'
import type { PackageUpdateRequest } from '../shared/plugin-updates'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initializeCreatedLibrary } from './library-initialization'
import type { LibraryInitialization } from '../shared/library-creation'
// 核心进程入口（utilityProcess）。只有这个进程写数据库。
// 主进程发来 init 打开素材库；每个窗口连接时发来一个 MessagePort，经它收发 RPC。

import type { MessagePortMain } from 'electron'
import { corePlugins } from '../plugins/core'
import type { CoreEvents, RpcRequest, RpcResponse } from '../shared/rpc'
import { Host } from './host'
import { openLibrary } from './library'
import { loadExternalCore } from './external-plugins'
import { PLUGINS } from '../plugins/manifest'
import { DISTRIBUTION } from '../plugins/generated/distribution'
import type { InstalledPackage, PackageRef } from '../shared/external-plugins'

let host: Host | undefined
const ports = new Set<MessagePortMain>()

// ---------- 事件合并：数据块写入很频繁，按 50ms 合并后再发 ----------

let changedIds = new Set<string>()
let listChanged = false
let kindsChanged = false
let historyChanged = false
let progress: CoreEvents['progress'] | undefined
let jobs = new Map<string, CoreEvents['job']>()
let flushTimer: NodeJS.Timeout | undefined

function broadcast(msg: unknown): void {
  for (const p of ports) p.postMessage(msg)
}

function scheduleFlush(): void {
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined
    // 数据块定义先到：界面按新的定义去显示变化了的身份
    if (kindsChanged) broadcast({ event: 'kinds', payload: {} })
    if (changedIds.size) broadcast({ event: 'changed', payload: { ids: [...changedIds] } })
    if (listChanged) broadcast({ event: 'listChanged', payload: {} })
    if (historyChanged) broadcast({ event: 'historyChanged', payload: {} })
    if (progress) broadcast({ event: 'progress', payload: progress })
    for (const job of jobs.values()) broadcast({ event: 'job', payload: job })
    changedIds = new Set()
    listChanged = false
    kindsChanged = false
    historyChanged = false
    progress = undefined
    jobs = new Map()
  }, 50)
}

function emit<K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]): void {
  if (event === 'fileSpaceChanged') { broadcast({ event, payload }); return }
  if (event === 'spaceChanged') { process.parentPort.postMessage({ type: 'space-changed', ...(payload as CoreEvents['spaceChanged']) }); return }
  if (event === 'changed') for (const id of (payload as CoreEvents['changed']).ids) changedIds.add(id)
  else if (event === 'listChanged') listChanged = true
  else if (event === 'kinds') kindsChanged = true
  else if (event === 'historyChanged') historyChanged = true
  else if (event === 'job') {
    const job = payload as CoreEvents['job']
    jobs.set(`${job.id}|${job.system}`, job)
  } else progress = payload as CoreEvents['progress']
  scheduleFlush()
}

// ---------- RPC ----------

function serve(port: MessagePortMain): void {
  ports.add(port)
  port.on('message', async (e) => {
    const req = e.data as RpcRequest
    let res: RpcResponse
    try {
      if (!host) throw new Error('素材库尚未打开')
      const fn = host.api[req.method] as (...args: unknown[]) => unknown
      if (typeof fn !== 'function') throw new Error(`未知方法 ${req.method}`)
      res = { id: req.id, result: await fn(...req.args) }
    } catch (err) {
      res = { id: req.id, error: err instanceof Error ? err.message : String(err) }
    }
    port.postMessage(res)
  })
  port.on('close', () => ports.delete(port))
  port.start()
}

process.parentPort.on('message', async (e) => {
  const msg = e.data as
    | { type: 'init'; root: string; expectedId?: string; initial?: LibraryInitialization; programDirs?: string[]; packages?: InstalledPackage[]; bundled?: PackageRef[] }
    | PackageUpdateRequest
    | { type: 'connect' }
    | { type: 'shutdown' }
  if (msg.type === 'package-update') {
    let opened: ReturnType<typeof openLibrary> | undefined
    try {
      if (!host) {
        if (!existsSync(join(msg.root, 'library.db'))) throw new Error('仓库不可访问，未创建替代仓库')
        opened = openLibrary(msg.root, msg.libraryId)
      }
      await updateLibraryPackage(host?.lib ?? opened!, msg)
      e.ports[0].postMessage({ ok: true })
    } catch (error) { e.ports[0].postMessage({ error: String(error) }) }
    finally { opened?.close(); e.ports[0].close(); if (!host) setTimeout(() => process.exit(0), 50) }
  } else if (msg.type === 'init') {
    let lib: ReturnType<typeof openLibrary> | undefined
    try {
      if (!msg.initial && existsSync(join(msg.root, '.creation.json')) && !existsSync(join(msg.root, 'library.db'))) throw new Error('建库尚未完成，请从开始页接续')
      lib = openLibrary(msg.root, msg.expectedId, msg.initial?.libraryId)
      initializeCreatedLibrary(lib, msg.initial, PLUGINS, msg.bundled ?? [], DISTRIBUTION)
      const { manifest, plugins } = await loadExternalCore(lib, PLUGINS, corePlugins, msg.packages ?? [], DISTRIBUTION)
      host = new Host(msg.root, plugins, emit, { library: lib, manifest, programDirs: msg.programDirs })
      process.parentPort.postMessage({ type: 'ready', libraryId: host.lib.id })
      // 一次有界检查；不常驻监听，也不为关闭仓库启动后台进程。
      void Promise.resolve(host.api.scanSpaceImports()).catch(error => console.error('[imports] 启动检查失败', error))
    } catch (err) {
      if (lib?.db.open) lib.close()
      console.error('[core] 打开素材库失败', err)
      process.parentPort.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  } else if (msg.type === 'connect') {
    for (const p of e.ports) serve(p)
  } else if (msg.type === 'shutdown') {
    // 窗口关闭前发出的写入可能还在路上：稍等一下再关库
    setTimeout(() => {
      host?.close()
      host = undefined
      process.exit(0)
    }, 150)
  }
})

process.on('exit', () => host?.close())
