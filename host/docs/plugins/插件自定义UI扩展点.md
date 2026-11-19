# 插件自定义 UI 扩展点

2026-11-10。插件可以定义自己的贡献契约，其他插件按该契约提交动作、组件或描述数据。宿主只装配目录和提供错误边界，业务提供方决定如何使用与呈现。内置业务也可走同一目录。

本能力只在当前仓库窗口内静态装配。启停／更新仍需统一应用并重载；不新增数据库、IPC、MCP 或后台服务协议。筛选、布局、选区等现有接口保持；表格与字段 1.2.0 已作为[真实业务接入](表格协作契约.md)，旧表格专用接口已经退役，使用方须采用新版契约。不要为了使用新目录重写已有公共语义。

## 公开入口

使用方在 `plugin.json` 的 `uiFeatures` 声明 `ui-extension-points-v1`。类型和渲染边界从 `@resource-manager/plugin-api/ui/extensions` 导入，声明在 `UiPlugin` 中，运行目录通过 `host.extensions` 取得。

| API | 作用 |
| --- | --- |
| `UiPlugin.extensionPoints` | 提供方声明 `id / version / validate` |
| `UiPlugin.extensions` | 贡献方声明 `id / point / version / order? / needs? / value` |
| `host.extensions.list<T>(point, version)` | 当前窗口有效贡献的稳定只读列表；每项含 `id / pluginId / point / version / value` |
| `host.extensions.invoke(entry, callback)` | 捕获同步／异步动作错误，记录来源并重新抛出，由业务界面显示结果 |
| `ExtensionBoundary` | 隔离一个贡献子组件的渲染错误，显示占位并登记来源 |
| `diagnostics() / subscribe()` | 读取／订阅本窗口诊断；订阅的是错误变化，不是动态注册 |
| `reportFailure(entry, error, phase)` | 自定义渲染／调用边界登记错误；常规场景用前述两个边界即可 |

## 提供方声明与消费

例如阅读器公开额外动作。契约类型放在自己的纯类型包，独立贡献工程通过声明依赖使用，不导入阅读器入口或内部组件：

```ts
export interface ReadingContext {
  readonly text: string
  isAvailable(): boolean
}
export interface ReadingAction {
  title: string
  run(context: ReadingContext): void | Promise<void>
}
```

阅读器的 UI 声明：

```ts
extensionPoints: [{
  id: 'reader.extraActions', version: 1,
  validate(value) {
    if (!value || typeof value !== 'object') return '需要动作对象'
    const action = value as Partial<ReadingAction>
    return typeof action.title === 'string' && typeof action.run === 'function'
      ? undefined : '需要 title 和 run'
  }
}]
```

`validate` 必须同步、纯、无副作用：`undefined` 是有效，文字是载荷问题，抛错是校验器故障。不执行贡献函数、不查询数据库或网络。错误异步返回会拒绝整个点，不作为校验成功。

在自己的页面中读取和安排入口：

```ts
const entries = host.extensions.list<ReadingAction>('reader.extraActions', 1)
// 点击时捕获本页上下文；不要在异步完成后读取“全局当前页面”。
await host.extensions.invoke(entry, action => action.run(context))
```

泛型须使用提供方公开的类型，不能替代运行时校验。目录不提前调用动作、挂载组件或过滤业务上下文；匹配、组合、单项胜出等规则都由提供方规定。同一贡献可服务多个页面，每个页面分别传上下文。

## 贡献方接入

在 `plugin.json` 声明 `optional: ["reader"]`；如果整个插件离开阅读器就不能工作，改用 `requires`。随后提交：

```ts
extensions: [{
  id: 'flashcard.fromSelection', point: 'reader.extraActions', version: 1,
  order: 10,
  value: {
    title: '制作卡片',
    run: async (context: ReadingContext) => {
      if (!context.isAvailable()) return
      // 使用自己的业务接口保存卡片。
    }
  } satisfies ReadingAction
}]
```

扩展点 ID 归提供方，贡献 ID 归贡献方，均以 `插件id.` 开头；`host.*` 留给宿主。跨插件目标必须列入 `requires` 或 `optional`。目标提供方的启用检查是隐含的，`needs` 可添加其他声明过的依赖。

版本是正整数、精确匹配；提供方可同时定义两个版本的点。包版本、宿主 `apiVersion`、贡献契约版本是不同概念。相同 `order` 按贡献 ID 稳定排序。提供方停用时协作项消失，可选贡献方的其他功能保留。

## 组件、实例与失败

组件可放进 `value`，其类型和位置由业务契约规定。提供方必须给每个贡献组件加边界，而不是把整个页面一起包起来：

```tsx
<ExtensionBoundary extensions={host.extensions} extension={entry}>
  <Panel context={context}/>
</ExtensionBoundary>
```

窄工具条可传 `fallback` 自定义失败占位，记录来源的行为保持；例如表格用紧凑按钮跳到诊断。React 错误边界不捕获事件和 Promise；动作仍需 `invoke` 并处理返回的失败。默认渲染失败占位保留到该边界重新挂载；不自动不断重试，也不因一个组件出错停用整个插件。没有通过边界调用的任意回调，不会自动获得隔离或来源归因。

贡献描述符在窗口内共享，**不要把页面、选区或草稿的可变状态写进 `value`**。列表和条目外壳冻结，嵌套载荷只约定为只读，不递归冻结第三方组件对象。关闭、内容切换、请求取消与异步写回由提供方明确校验；宿主不替业务生成事务或撤销。示例演示存活检查，真实写库仍要调用有输入校验的业务命令。

一个目录的条目不能交给另一个窗口／重载后的目录调用。静态描述符不是可保存数据；组件和函数不进入仓库、布局存档或 IPC。需要停靠的完整工具继续使用 `toolViews`，实例能力继续使用页面上下文契约。

## 诊断与恢复

在「设置 → 当前仓库 → 功能与插件」顶部查看“插件协作问题”；无问题时不显示。保留本窗口最近 100 个不同问题，按来源、目标、版本、阶段和消息去重；重载后重新装配，不写磁盘。

| 失败 | 行为 |
| --- | --- |
| 缺少可选提供方／`needs` 未启用 | 跳过贡献，无故障诊断 |
| 提供方已启用但点或版本不匹配 | 拒绝该项，记录贡献方与目标版本 |
| 载荷校验返回问题文字 | 拒绝该项，其他有效贡献保留 |
| 校验器抛错／返回无效类型 | 记录提供方，整个点不发布部分结果 |
| 贡献渲染／同步或异步动作失败 | 通过边界记录贡献方，局部处理；其他动作、页面保留 |
| 命名空间冒用、重复 ID、无效声明形状或漏报依赖 | 包预检失败，沿用已有整包加载失败／恢复机制 |

宿主不会递归代理载荷中的任意函数。这是可信插件的协作与故障定位机制，不是安全沙箱。

## 独立包示例与验证

[examples/extensions](../../examples/extensions/README.md) 包含提供方、贡献方两个工程和一个本地类型契约包。它们分别打包，无跨插件内部源码引用。提供方有 A／B 两个页面，贡献方提供计数按钮、延迟动作和附加组件；故意保留两项非法贡献及错误演示，用于检查诊断。

基础构建后运行 `node tests/electron/sidebar-layout-check.mjs --extensions`。启动器在临时目录离线安装本地类型依赖、打包、安装，并用临时仓库／独立用户目录验证跨包、页面隔离、错误来源和停用恢复。不安装到日常仓库。详细边界见[开发与验证](../development/开发与验证.md#插件自定义-ui-扩展点验证)。
