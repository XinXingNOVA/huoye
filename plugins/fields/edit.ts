// 字段插件的界面调用入口：侧栏、检查器、表格贡献共用核心命令。
// 界面只提交意图；读取最新模板、校验、写入、撤销在同一个核心事务里完成。

import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { FieldType } from './blocks'

const command = <T>(host: UiHost, name: string, args: Record<string, unknown>, preview = false) =>
  (preview ? host.core.preview('fields', name, args) : host.core.run('fields', name, args)) as Promise<T>

export async function createTemplate(host: UiHost, title: string): Promise<string> {
  return (await command<{ kind: string }>(host, 'createTemplate', { title })).kind
}

export const renameTemplate = (host: UiHost, template: string, title: string) =>
  command<void>(host, 'renameTemplate', { template, title })

export async function addField(host: UiHost, template: string, title: string, type: FieldType): Promise<string> {
  return (await command<{ field: string }>(host, 'addField', { template, title, type })).field
}

export const renameField = (host: UiHost, template: string, field: string, title: string) =>
  command<void>(host, 'renameField', { template, field, title })

export const addOption = (host: UiHost, template: string, field: string, option: string) =>
  command<void>(host, 'addOption', { template, field, option })

// ---------- 结构演变（第三步）：在核心里一个事务完成，可以撤销；先预演拿到影响范围 ----------

export interface TypeChange {
  /** 有值的项数。 */
  total: number
  /** 转换不了、会被清空的项数。 */
  cleared: number
  options?: string[]
}

export const changeType = (host: UiHost, template: string, field: string, type: FieldType, preview = false) =>
  command<TypeChange>(host, 'changeType', { template, field, type }, preview)

export const deleteField = (host: UiHost, template: string, field: string, preview = false) =>
  command<{ cleared: number }>(host, 'deleteField', { template, field }, preview)

export const renameOption = (host: UiHost, template: string, field: string, from: string, to: string) =>
  command<{ total: number }>(host, 'renameOption', { template, field, from, to })

export const deleteOption = (host: UiHost, template: string, field: string, option: string) =>
  command<{ cleared: number }>(host, 'deleteOption', { template, field, option })

export const promoteTag = (host: UiHost, tag: string) =>
  command<{ template: string; kind: string; count: number }>(host, 'promoteTag', { tag })
