import type { FC } from 'react'
/** 纯类型协议：消费方不得导入提供方的运行入口。 */
export interface ExampleContext {
  name: string
  count: number
  failure: 'none' | 'sync' | 'async' | 'render'
  isAvailable(): boolean
  add(amount: number): void
}
export interface ExampleAction {
  title: string
  run(context: ExampleContext): void | Promise<void>
  Panel?: FC<{ context: ExampleContext }>
}
