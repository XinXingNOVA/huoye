# 文字与数学公式

文字是随应用维护的内部可选模块。新建的文字素材，以及 `.md`／`.markdown` 文件，使用同一套 Markdown 排版：阅读标签页、素材卡片、空格预览和嵌入摘要都能显示数学公式。聊天回答「保存为文字」后也可直接阅读公式，不依赖 AI 对话插件是否启用。

## 写法与边界

- 行内：`$x^2$` 或 `\(x^2\)`。
- 独立公式：`$$…$$` 或 `\[…\]`，也支持 `math` 代码围栏。
- 普通代码围栏、行内代码和纯文本 `.txt` 继续按源码显示；裸 LaTeX 不自动猜测。

例如：

```text
$$
\mathbb Z[\sqrt2]=\{x+y\sqrt2:x,y\in\mathbb Z\}.
$$
```

集合大括号写成 `\{`、`\}`。正文中的长公式可在自身区域横向滚动，卡片与嵌入摘要保留原有截断行为；错误、未闭合或超长公式回退源码。字体随应用打包，不访问 CDN。

仅改变呈现，不改仓库数据、原文件、数据块定义或 MCP。编辑器仍编辑 Markdown／LaTeX 源码，保存、撤销与导出沿用原流程。应用更新并重启后生效，不需要重新导入已有文字或更换 AI 对话包。

搜索仍查原始文字，界面高亮跳过公式内部，避免破坏数学排版；搜索 LaTeX 命令可以找到素材，但公式内部不逐字符标亮。摘录索引排除 KaTeX 隐藏的 MathML 副本和布局占位字，普通文字及公式后的摘录仍可定位。公式选区提供可见字符，不负责还原分数、矩阵等完整 LaTeX 结构；需要精确源码请从编辑器复制。历史摘录若直接包含旧版显示的 LaTeX 源码，数据仍保留，但排版后的文字变化可能让原位置失配。

## 实现和验证

Markdown／TXT 原文件通过“保存文件”或 ⌘/Ctrl+S 发布新版本；历史从文件空间恢复，编辑框内保留文字撤销。未保存文本与重试参数作为本机草稿保留。纯文字数据块使用自动保存。当前只支持 v4 文件空间，见[文件空间](../../../docs/architecture/文件空间.md)；原生回归入口为 `tests/electron/file-edits-check.mjs`。

解析规则在 `markdown-render.ts`，公式装配在 `math.ts`，样式在 `math.css`；复用 KaTeX 与 `@mdit/plugin-tex`。依赖随内置模块放在根 `package.json`，不引用外部 AI 插件目录或增加宿主公共 API。KaTeX 禁用可信 HTML、外部图片和链接扩展，单公式长度、宏展开和尺寸有上限，宏不跨公式共享。

```sh
npx tsc --noEmit -p tsconfig.web.json
npm test -- tests/plugins/text.test.ts tests/plugins/text-markdown.test.ts tests/plugins/ai-chat-markdown.test.ts tests/integration/content-selection.test.ts
npm run build
node tests/electron/ai-chat-check.mjs
```

Electron 流程使用独立临时库和 `RM_USER_DATA`、本机模拟模型。实际导入新 Markdown／TXT 文件，检查聊天另存后的公式、编辑源码与撤销、搜索高亮和选区索引、公式后的摘录、短公式卡片、空格预览和双链。该流程还需要单独取得 `ai-chat` 插件工程，并按其 README 安装依赖。

## 多视图编辑

文字标签右键可在另一组新建视图。数据块正文与详情栏共享草稿、编辑撤销和保存冲突；页面各自保存光标与滚动。未保存正文不开放摘录锚点。原文件保留显式版本保存，一次仅一处编辑。公共契约见[共享编辑会话](../../../docs/plugins/共享编辑会话.md)。

编辑撤销会合并连续输入和连续删除，停顿、词句分隔、换行、移动光标和切换输入框划分操作；粘贴、选区替换、插入链接独立成步，输入法一次确认整体撤销。自动保存不打断撤销段，也不增加界面工具条。
