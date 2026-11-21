# 活页外部主题包

在「设置 → 外观与主题」点击「安装主题包…」，选择 [蓝晒](cyanotype.hytheme) 或 [银杏·秋光](ginkgo.hytheme)。蓝晒以纸面与普鲁士蓝呈现两种印相效果，银杏·秋光以金叶与夜色呈现同一主题的昼夜变化。安装后点击「已安装主题」里的卡片即可使用。主窗口、设置窗口和独立内容小窗同步切换。点击「还原内置外观」可以找回使用外部主题前的内置预设、强调色、表面色、密度和圆角。移除当前使用的主题也会还原。

单文件 `.hytheme` 使用 UTF-8 JSON，清单上限为 32 KiB。应用将已装主题和外观偏好保存在本机的 `userData/themes/`。升级时自动迁移旧版已安装主题、应用默认外观及各库覆盖。安装后原文件可移走。重复安装同一 `id` 会更新该主题；点击卡片可重新应用包里推荐的密度和圆角。开始页和「全局应用 → 外观与主题」管理应用默认外观。库默认跟随它；在仓库的「设置 → 当前仓库 → 本库外观」点「单独设置」，会复制当前外观，之后主题、配色、密度和圆角只影响本机上的此库及其小窗。点「恢复跟随应用」会清除本库覆盖，并立即使用最新的应用默认外观。已安装的主题包在本机共享，可在全局外观设置移除。

套件可以用 `recommendedTheme` 为新仓库选择昼夜主题。四款内置主题的 ID 分别为 `huoye-standard`（活页 · 标准）、`silver-gelatin`（银盐画册）、`celadon-reading`（青瓷书房）和 `reference-desk`（紧凑资料台）。外部主题包定义明暗分支时，`base` 使用下表中的七种固定配色。

| 字段 | 约定 |
| --- | --- |
| `formatVersion` | `1` 为色彩与外观，`2` 支持下表中的 `parts`，`3` 可声明 `decoration`，`4` 增加公共图标和阅读纸张设置，`5` 增加主题卡片预览图与装饰构图，`6` 支持一个包包含浅色与深色两版 |
| `id`、`name` | 唯一 ID 以小写字母开头，最多 64 个小写字母、数字或连字符。显示名最多 60 个字符 |
| `description` | 可选，最多 200 个字符 |
| `base` | 继承经典主题的明暗模式、色值和外观。可选 `obsidian`、`graphite`、`pine`、`warm-paper`、`daylight`、`celadon-study`、`compact-desk` |
| `colors` | 可选，按需覆盖 `shell`、`panel`、`panel2`、`bg`、`elevated`、`line`、`text`、`muted`、`accent`、`danger`、`placeholder`、`paper`、`ink`。值为 `#RRGGBB` |
| `appearance` | 可选。密度 `density` 为 `comfortable / compact`，圆角 `radius` 为 `sharp / rounded / soft`，侧栏留白 `panelInset` 为 0–16 的整数（px），正文字体 `readingFont` 为 `system / serif / mono` |

## 按内容部位设计

可以为封面加画框，将题签叠印在卡片底部，或单独调整详情分区的留白和文字阅读器的版心。

`formatVersion: 2` 的包可增加一个 `parts` 对象。下列部位和字段均可省略。尺寸单位为 CSS 像素，除行距外均为整数。

| 部位 | 可用字段 |
| --- | --- |
| `card-cover` | 边框宽度 `frameWidth` 0–6、边框色 `frameColor`、圆角 `radius` 0–24 |
| `card-caption` | 位置 `placement` 取 `below` 或 `overlay`；对齐 `align` 取 `start / center / end`；字重 `weight` 取 400、500、600 或 700 |
| `inspector-section` | 分区底色 `background`、左右内边距 `inset` 0–16、圆角 `radius` 0–16 |
| `reader-page` | 版心最大宽度 `maxWidth` 420–1200、左右内边距 `inset` 8–72、正文字号 `textSize` 13–24、行距倍数 `lineHeight` 1.3–2.4 |

部位配色引用当前调色板，可选 `shell / panel / panel2 / elevated / line / accent / danger / placeholder / paper / ink / bg / text / muted`。例如 `"frameColor": "paper"` 会跟随用户对纸色的微调。搜索结果有命中摘录时，标题移回封面下方，让摘录完整可见。标准卡片的选择框、失败提示和拖放仍由宿主绘制。

这四个部位使用同名的 `data-hy-part` 属性，卡片外框为 `resource-card`。公共 `ResourceCard` 自带卡片部位；插件详情内容所在的分区由宿主标记。内置文字、PDF 及 EPUB 1.3.0 阅读器共用阅读页契约。宿主从结构化参数生成 `hy-theme` 样式层，切换时整层替换。插件使用的通用变量见[公共主题变量](../../docs/plugins/UI-Kit.md)。


## 随建库套件交付

在套件源码 `suite.json` 的某个 `presets[]` 中写 `"recommendedTheme": "compact-desk"`，就会为采用该方案的新库选择「紧凑资料台」。每个方案可以独立推荐；省略时，新库跟随应用默认外观。

要携带自己的主题，在套件顶层写 `"themes": ["themes/ginkgo.hytheme"]`，对应方案中写 `"recommendedTheme": "external:ginkgo"`。路径相对套件源码文件，打包命令与普通套件相同。安装套件后可以在外观设置中找到主题，建库时按已预览版本的内容摘要选用。建库接续沿用原来的推荐。已建库保持各自的外观，用户可在「本库外观」切换或恢复跟随应用。手动移除随包主题后，重新安装同一套件可找回主题，再从外观设置中选用。

## 携带静态图片的主题包

扩展名同为 `.hytheme` 的 ZIP 包可以在根目录放入上述 `theme.json`，以及最多 16 张 `images/<名字>.png` 或 `.webp`。文件名使用小写字母、数字、连字符或下划线，首字符为字母或数字。单图上限 4 MiB，整个包的压缩前后大小各限 8 MiB。宿主按内容摘要在本机共享图片，通过只读图片地址提供给界面。移除最后一份引用该图片的主题后，宿主回收文件。

## 工作台壁纸与贴纸

可以直接安装[银杏·秋光](ginkgo.hytheme)，体验壁纸、透明表面和角落的银杏叶贴纸。应用默认主题用于所有跟随它的工作台。要为单个仓库调整，进入「设置 → 本库外观 → 单独设置 → 工作台装饰」。

在配置中选择本机 PNG、JPEG 或 WebP 图片后，可以移走来源文件。宿主限量解码首帧，旋正方向，生成适合工作台的 WebP 副本。壁纸最长边 2560 px，贴纸最长边 768 px，输入上限 20 MiB、4800 万像素。右键库内图片的「设为本库壁纸」使用素材身份及仓库文件引用。较大图片、动图和部分格式使用缩略图。移入回收站后工作台回到画布底色，恢复素材后可以再次显示。

`formatVersion: 3` 的包可提供以下声明。壁纸和贴纸引用包内的静态 PNG 或 WebP，每张最多 1600 万像素。五个数值都是可选整数。

```json
"decoration": {
  "wallpaper": "images/mist.webp",
  "sticker": "images/huoye.png",
  "wallpaperOpacity": 54,
  "wallpaperBlur": 0,
  "wallpaperBrightness": 100,
  "surfaceOpacity": 80,
  "surfaceBlur": 6
}
```

壁纸不透明度范围 0–100%，模糊 0–24 px，亮度 40–140%。表面不透明度范围 45–100%，毛玻璃模糊 0–16 px。设置中的「隐藏」可单独关掉壁纸或贴纸。「恢复主题装饰」清除本库的装饰微调并重新采用当前主题的设置，「恢复跟随应用」清除本库整套外观覆盖。独立内容小窗继承所属工作台的装饰。

## 主题卡片预览与装饰构图

在 v5 主题清单里，顶层 `preview` 引用包内静态 PNG 或 WebP。可放一张实际工作台截图，选取缩小时仍看得清的构图。设置卡片完整显示图片。省略预览图时，卡片继续用主题配色生成缩略图。已有 v1–v4 主题可以直接使用。

```json
{
  "formatVersion": 5,
  "id": "grid-paper",
  "name": "方格纸",
  "base": "celadon-study",
  "preview": "images/workbench.webp",
  "decoration": {
    "wallpaper": "images/grid.png",
    "wallpaperFit": "tile",
    "wallpaperAnchor": "top-left",
    "wallpaperTileSize": 64,
    "sticker": "images/seal.webp",
    "stickerAnchor": "bottom-left",
    "stickerScale": 80,
    "stickerOpacity": 55
  }
}
```

| 构图参数 | 可用值与默认效果 |
| --- | --- |
| `wallpaperFit` | 默认 `cover` 等比铺满。选择 `tile` 将图片按原比例平铺 |
| `wallpaperAnchor` | 默认 `center`。可选 `top`、`bottom`、`left`、`right` 及四角。控制铺满时保留哪一侧，或平铺纹理从哪里对齐 |
| `wallpaperTileSize` | 每块纹理的宽度，16–1024 CSS 像素，默认 128。仅在平铺时生效 |
| `stickerAnchor` | `top-left`、`top-right`、`bottom-left`、`bottom-right`，默认右下 |
| `stickerScale` / `stickerOpacity` | 原贴纸尺寸的 40–200%，默认 100%。不透明度 0–100%，默认 78%。均取整数 |

工作台和浮层使用 `surfaceBlur`。素材卡片默认保留半透明底色，滚动时无需逐卡模糊。要让卡片也使用同一模糊半径，可在 v5 的 `decoration` 中指定 `"blurCards": true`。本库设置里的「素材卡片毛玻璃」开关优先于主题包。模糊强度为 0 时，两处均使用清晰表面。

在「本库外观 → 工作台装饰 → 调整壁纸、贴纸与表面」可以覆盖这些值。「恢复主题装饰」会恢复包内图片及构图，独立内容小窗同步更新。

## 昼夜一包

安装[蓝晒](cyanotype.hytheme)后，选择标有「昼夜」的卡片。默认随系统明暗切换。「明暗模式」也可以选「固定浅色」或「固定深色」。例如应用跟随系统，某个仓库在「本库外观」单独固定为浅色，它的独立阅读小窗也会保持浅色。

v6 在根级填写 `id`、`name`、可选的 `description` 和 `appearance`。密度、圆角、面板留缝和阅读字体在两版之间共享。把原有 v5 主题的 `base`、`colors`、`parts`、`decoration`、`icons`、`preview` 放入对应分支：

- `variants.light` 和 `variants.dark` 都必须提供，各自的 `base` 需与该分支的明暗一致。其他字段可省略。
- 两版可使用同一张图，也可分别指定壁纸、贴纸、预览图、图标和 PDF 纸面。每个分支独立解析。两个分支的静态资源都在安装时校验，共享整个包的 8 MiB 上限。
- 本机自选强调色、壁纸等覆盖在两版中都生效。撤销覆盖后，恢复当前分支的值。v1–v5 保持原来的单色模式。

## 公共图标与阅读页

从 v4 起，主题可声明公共图标和阅读纸张样式。应用主题后，可以同时打开一份 PDF 和一本 EPUB，观察相同主题在两种文档中的效果。

在 ZIP 内放入 UTF-8 SVG 文件，例如 `icons/search.svg`，在根目录的 `theme.json` 添加 `"icons": { "search": "icons/search.svg" }`。可用名称见 [UI Kit](../../docs/plugins/UI-Kit.md)，未覆盖的名称继续使用宿主图形。单图上限 16 KiB、64 个图形。支持 `viewBox`、`path`、`rect`、`circle`、`ellipse`、`line`、`polyline`、`polygon` 以及用 `g` 分组的描边、填色。颜色可用 `currentColor` 跟随控件，也可用十六进制色值。导出图形时请展开变换。宿主只存放验证过的几何和绘制属性。含脚本、事件、链接、样式表或其他元素的资源会使整包安装失败，已安装版本仍可使用。

`parts["reader-page"]` 支持下列呈现方式。

| 阅读器 | 随主题生效的设置 | 读者操作 |
| --- | --- | --- |
| 文字 | 版心、留白、字号、行距、纸色和墨色 | 工作台和独立小窗同步 |
| PDF | 适应宽度、适应整页时使用 `maxWidth` 和 `inset`。页外底色取 `surround`，跟随主题的纸张模式取 `pdfPaper`（`original`、`warm`、`dark`） | 「本库外观 → 插件外观」可设本库默认纸面。工具栏可为当前文档选择纸面或恢复跟随本库默认，手动缩放保持所选比例 |
| EPUB 1.3.0 | 正文使用版心、留白、字号、行距和阅读字体。纸色 `paperColor`、墨色 `inkColor`、页外底色 `surround` 均引用主题调色板 | 在「排版」调整的字号与行距优先，点「恢复主题排版」可重新跟随；背景可单独选暖纸 |

例如 `"reader-page": { "maxWidth": 640, "inset": 36, "textSize": 20, "lineHeight": 1.8, "paperColor": "paper", "inkColor": "ink", "surround": "panel2", "pdfPaper": "warm" }`。PDF 保留文档固有字形和分页。
