# 10 分钟写出你的第一个活页插件

在活页里，**功能本身就是插件**——从标签、表格、参考板，到电子书阅读器、字体馆与离线算力引擎，全部运行在同一套公开的插件契约之上。你不需要修改宿主一行代码，就能在独立外部目录里为活页增添一种新数据块、新浏览布局、新算力引擎或一套声明式主题。

---

## 一、先看懂：一个插件能扩展哪几层？

活页插件是放在独立目录里的 TypeScript 工程，根目录包含一份 `plugin.json`。按需要实现其中一层或组合多层：

| 扩展层 | 入口文件 | 负责什么 | 典型例子 |
| :--- | :--- | :--- | :--- |
| **仓库核心层** | `blocks.ts` + `core.ts` | 数据块结构与全文索引、后台异步加工、业务命令与只读查询、MCP 操作声明、数据生命周期清理 | `tags`、`fields`、`image-audit`、`office-lens` |
| **工作台界面层** | `ui.tsx` | 浏览视图（表格/画廊/看板/书架）、文件打开器、智能上下文工具、详情区与置顶小窗 | `table`、`pureboard`、`loupe-viewer`、`epub` |
| **本机服务层** | `service.ts` | 按仓库运行的后台本机服务、流式通信、外部程序调用与受管本机配置 | `format-forge`、`clip-cutter`、`pdf-forge` |
| **算力提供层（v0.3）** | `provider.ts` | 按 `capabilities` v2 契约提供离线特征、OCR、抠图或语音转写，可对接 `.hyruntime` 共享运行包 | `embed-classic`、`embed-clip`、`speech-whisper` |

> 如果只需要定制配色、壁纸、阅读版心与图标，无需写 TypeScript 代码——直接编写纯声明式的 `.hytheme` 主题包即可，规范见 [`.hytheme` 主题包规范](../../host/examples/themes/README.md)。

---

## 二、推荐路径：克隆主仓，在外部独立目录开发

推荐始终以**独立外部工程 + 主仓本地工具链**的方式开发（稳定、透明、版本独立，且最适合配合编码 AI 迭代）：

### 1. 准备宿主工具链（只需做一次）

```bash
git clone https://github.com/XinXingNOVA/huoye.git
cd huoye/host
npm ci
npm run build
```

主仓库 `host/examples/` 里已经备好了一组最小可运行示例工程：
- `local-plugin`：最小外部插件骨架（无独立 npm 脚本，直接走宿主公共打包器）
- `query-plugin` / `transaction-plugin`：业务只读查询与事务协作
- `collection-surface`：复用公共集合列表与动态范围
- `tool-views` / `workbench-presets`：工作台工具容器与布局预设
- `file-editor` / `local-service`：受控文件编辑与本机后台服务

也可以参考官方扩展仓库 **[huoye-extensions](https://github.com/XinXingNOVA/huoye-extensions)** 的真实插件结构。

### 2. 复制骨架、本地检查与打包

以下命令接上一步，从 `huoye/host` 执行：

```bash
cp -R examples/local-plugin ../../my-huoye-plugin
node scripts/plugins/project.ts configure ../../my-huoye-plugin
node scripts/plugins/project.ts check ../../my-huoye-plugin
node scripts/plugins/project.ts pack ../../my-huoye-plugin
```

- `check` 会执行完整的 TypeScript 类型检查与公共边界校验；
- `pack` 会在 `my-huoye-plugin/artifacts/<id>.hyplugin` 生成可直接安装的插件包；
- 持续开发监听可运行：`node scripts/plugins/project.ts dev ../../my-huoye-plugin`。

### 3. 配合你的编码 AI 一起写

在本地克隆好的 `huoye` 仓库里打开 **Claude Code、Codex 或 Cursor**，让它先读根目录的 [`llms.txt`](../../llms.txt)——`llms.txt` 是给编码 AI 的文档地图与红线清单，AI 读完后就能顺着索引查阅 `host/docs/plugins/` 里的具体接口文档，在你的外部插件目录编写代码，并直接运行 `check` 和 `pack` 自检。

> 注意：`llms.txt` 本身是导航索引，不包含完整 API 源码；让 AI 在本地仓库中直接读文档并跑工具链，成功率远高于只贴网页链接。

### 4. 在独立测试仓库中实机验收

打开一个测试仓库（建议开发时用独立 `RM_USER_DATA`，不碰个人主力库）：
- **安装成品包测试**：进入 **「设置 → 套件与插件包」** 拖入刚打好的 `.hyplugin` 安装，并在当前仓库勾选启用；
- **本地源码热加载**：进入 **「设置 → 功能与方案 → 本地源码开发」** 添加插件源码目录，勾选并应用重载即可实时查看效果。

---

## 三、写界面插件时的几条关键红线

在 `plugin.json` 中声明 `uiFeatures: ["ui-kit-v1"]` 即可从 `@resource-manager/plugin-api/ui/kit` 复用共享控件与图标（详见 [UI Kit 速查](../../host/docs/plugins/UI-Kit.md)）：

- **只走公共契约**：仅从 `@resource-manager/plugin-api/...` 与 `@huoye/provider-sdk` 导入，禁止跨目录引用宿主私有源码。
- **跨独立小窗安全**：活页支持把内容页撕成独立内容小窗（同源 Portal）。涉及 DOM 监听、`ResizeObserver`、动画帧或浮层时，务必使用 `useUiEffect`、`useUiFrame`、`UiPortal` 或元素的 `ownerDocument`，不要假定全局 `document` / `window`。
- **样式不绑宿主位置**：不要写依赖 `.sidebar` 等外层容器类名的选择器，保证工具移到左右侧栏、主分屏或小窗时样式一致。
- **补齐 AI 与数据生命周期声明**：对外写操作声明 `operation-effects-v1`（`data` / `structure`）；有持久数据时声明 `data-lifecycle-v1`，支持在「设置 → 数据与维护」中预览与清理；支持英文界面时声明 `ui-locale-v1` 与 `locales.en`。

---

## 四、进阶接口查阅

写实际业务插件时，推荐按以下顺序查阅宿主权威文档：
1. [AI 文档索引（llms.txt）](../../llms.txt) 与 [公共 API 总览](../../host/docs/plugins/公共API总览.md)
2. [独立插件开发规范](../../host/docs/plugins/插件开发指南.md) 与 [公共 UI API](../../host/docs/plugins/公共UI%20API.md)
3. [工作区布局与工具视图](../../host/docs/plugins/工作区布局.md) · [外部本机服务与算力](../../host/docs/plugins/外部本机服务.md) · [插件数据生命周期](../../host/docs/plugins/插件数据生命周期.md)

<sub>注：活页也保留了实验性的 MCP 内部建工程接口（`create_development_project` 等，见 `服务插件 API.md`），日常开发仍优先推荐上面更稳定的外部独立目录闭环。</sub>
