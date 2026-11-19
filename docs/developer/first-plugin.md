# 10 分钟写出你的第一个活页插件

在活页里，**功能本身就是插件**——从标签、评分、色板、表格，到 EPUB 阅读器和音乐播放器，全部运行在同一套公开的插件契约之上。你可以用极少的代码给活页增加一种新数据块、一种新浏览布局，或是一个完整的垂直工作台。

---

## 一、先看懂：一个插件能扩展哪三层？

活页插件是放在独立目录里的 TypeScript 工程，根目录包含一份声明文件 `plugin.json`。按你的需要，它可以只实现其中一层，也可以同时打通三层：

| 扩展层 | 入口文件 | 负责什么 | 典型例子 |
| --- | --- | --- | --- |
| **仓库核心层** | `blocks.ts` + `core.ts` | 定义数据块结构与索引、后台异步加工、业务命令与只读查询、对外 MCP 操作声明、数据生命周期清理 | `tags`、`rating`、`palette`、`fields` |
| **工作台界面层** | `ui.tsx` | 贡献浏览布局（表格/画廊/看板）、侧栏工具与智能筛选、详情分区、文件打开器、自定义 UI 扩展点、设置与命令 | `table`、`gallery`、`kanban`、`epub` |
| **本机服务层** | `service.ts` | 按仓库运行的后台本机服务、流式通信、受管本机配置与密钥 | `ai-chat` 或外部同步/模型接入服务 |

> **关键原则**：数据属于仓库，停用/卸载插件保留数据；UI 与 MCP 共用同一套核心命令；插件只从公共 `@resource-manager/plugin-api/...` 导入契约，不触碰宿主私有源码。

---

## 二、准备开发环境与跑通最小示例

最快的起步方式，是直接对照仓库里已经准备好的最小示例工程（位于 `host/examples/`）：

- `local-plugin`：最小外部插件示例（无独立 npm 脚本，使用宿主公共打包器）
- `query-plugin` / `transaction-plugin`：业务查询与事务协作
- `collection-surface`：复用公共集合列表与动态范围
- `tool-views` / `workbench-presets`：工作台工具容器与布局预设
- `file-editor` / `local-service`：受控文件编辑与本机后台服务

### 本地构建与加载流程
1. **准备宿主工具链**（只需做一次）：
   ```bash
   cd huoye/host
   npm ci
   npm run build
   ```
2. **复制最小示例到宿主外，并使用公共工具链构建**（以下命令接上一步，从 `huoye/host` 执行）：
   ```bash
   cp -R examples/local-plugin ../../my-huoye-plugin
   node scripts/plugins/project.ts configure ../../my-huoye-plugin
   node scripts/plugins/project.ts check ../../my-huoye-plugin
   node scripts/plugins/project.ts pack ../../my-huoye-plugin
   ```
   包生成在 `my-huoye-plugin/artifacts/<id>.hyplugin`。监听构建可运行 `node scripts/plugins/project.ts dev ../../my-huoye-plugin`。该最小示例没有 `package.json`，不用在其中运行 `npm ci`；自己的工程如果带锁文件和 npm 脚本，再按该工程说明安装和构建。
3. **在活页测试库中加载**：
   打开一个测试仓库 → **「设置 → 功能与方案 → 本地源码开发」** → 添加你的插件源码目录 → 勾选并点击 **「应用并重新加载」**，即可在真实窗口里立刻看到效果。

---

## 三、更酷的玩法：让你的 Coding Agent 自主开发并验收插件

活页针对 AI 编程时代，专门把插件开发的「创建工程 → 写代码 → 构建 → 热加载 → 读回验证」做成了一套公开的 MCP 闭环：

1. 在 **「应用设置 → AI 接入 · MCP → 允许 AI 新建仓库」** 选择 **「新仓库由 AI 托管」**，并勾选 **「允许 AI 自主开发插件」**（发行版需在此指定一次已安装依赖的宿主源码工程作为工具链）。
2. 在你的编码 Agent（如 Claude Code / Codex / Cursor）中，直接用自然语言描述你想做的新形态，例如：
   > “帮我在活页建一个测试仓库，创建一个名为 `reading-progress` 的独立插件工程，给 PDF 和文字素材增加『阅读状态与页码记录』数据块、详情栏编辑区和对应的筛选分面，构建加载后导入样本验证读写和重启保留。”
3. Agent 会自动调用 `create_development_project` 创建隔离工程，用它自己的代码编辑能力写完 `plugin.json` / `core.ts` / `ui.tsx`，再通过 `prepare_development_build` 与 `apply_development_build` 在真实活页里构建、加载、调用业务接口并读回验收。
4. Agent 创建的工程带有 npm 脚本，调试满意后运行 `npm run pack` 就能打成 `.hyplugin` 安装包直接分享给其他人，或者组合多个插件打成 `.hysuite` 套件。

---

## 四、写界面插件时的几个实用提醒（人机通用）

目前活页的底层插件契约已经比较完整，但**公共 UI 组件套件还在持续丰富中**，写复杂自定义界面时容易踩到几个隐蔽细节，建议提前留意（如果你让 Coding Agent 帮你写插件，也可以直接把这几条和仓库根目录的 [llms.txt](../../llms.txt) 喂给它）：

- **优先复用宿主公共承载**：列表、筛选、详情区和设置页尽量接入已有的 `collection-surface-v1`、`browsing-layout-v1`、`scoped-facets-v1`、`block-sections-v1`，不必从零重画整套列表或弹窗。
- **跨独立小窗安全**：活页支持把内容页或工具拖成独立内容小窗（同源 Portal）。涉及 DOM 监听、`ResizeObserver`、动画帧或浮层时，请使用公共的 `useUiEffect`、`useUiFrame`、`UiPortal` 或元素的 `ownerDocument`，不要默认写死全局 `document` / `window`。
- **样式不绑定宿主位置**：不要写依赖 `.sidebar` 等外层容器类名的选择器，这样你的工具移到另一侧、中央分屏或独立小窗里时样式不会走样。
- **补齐 AI 与数据生命周期声明**：对外暴露写操作时声明 `operation-effects-v1`（`data` / `structure`），让外部 MCP Agent 也能安全调用；有持久数据时声明 `data-lifecycle-v1`，支持在「设置 → 数据与维护」中预览与清理。

---

## 五、进阶接口查阅

写实际业务插件时，推荐按这个顺序查阅更细的宿主契约文档：
1. [公共 API 总览](../../host/docs/plugins/公共API总览.md)：按应用宿主、工作台、仓库核心、文件空间速查所有公开能力；
2. [独立插件开发规范](../../host/docs/plugins/插件开发指南.md)：按场景选接口、依赖声明、开发加载与套件打包细则；
3. [工作区布局与工具视图](../../host/docs/plugins/工作区布局.md) · [插件数据生命周期](../../host/docs/plugins/插件数据生命周期.md) · [插件自定义 UI 扩展点](../../host/docs/plugins/插件自定义UI扩展点.md)。
