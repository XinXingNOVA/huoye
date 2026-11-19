// 自动生成：npm run plugins:generate。请修改各插件的 plugin.json / distribution.json，勿手工编辑。
import type { PluginDistribution } from '../../shared/plugin-distribution'

export const DISTRIBUTION: PluginDistribution[] = [
  {
    "id": "file",
    "title": "文件",
    "origin": "builtin",
    "catalog": {
      "category": "files",
      "keywords": [],
      "usage": "拖入文件，或从空白处菜单收录；在素材详情中取回原文件。"
    },
    "group": "base",
    "defaultEnabled": true
  },
  {
    "id": "preview",
    "title": "预览",
    "origin": "builtin",
    "catalog": {
      "category": "tools",
      "role": "support",
      "keywords": [
        "缩略图",
        "封面"
      ],
      "usage": "处理媒体代表图，生成素材卡片缩略图。"
    },
    "group": "support",
    "defaultEnabled": true
  },
  {
    "id": "image",
    "title": "图片",
    "origin": "builtin",
    "catalog": {
      "category": "files",
      "keywords": [
        "照片",
        "图片"
      ],
      "usage": "双击图片打开查看器，在素材详情中查看尺寸。"
    },
    "group": "common",
    "defaultEnabled": true
  },
  {
    "id": "video",
    "title": "视频",
    "origin": "builtin",
    "catalog": {
      "category": "files",
      "keywords": [
        "影片",
        "视频"
      ],
      "usage": "双击视频打开播放器，支持续播和倍速。"
    },
    "group": "common",
    "defaultEnabled": true
  },
  {
    "id": "audio",
    "title": "音频",
    "origin": "builtin",
    "catalog": {
      "category": "files",
      "keywords": [
        "歌曲",
        "音频",
        "封面"
      ],
      "usage": "双击音频试听；音乐插件可提供歌单与持续播放。"
    },
    "group": "common",
    "defaultEnabled": true
  },
  {
    "id": "pdf",
    "title": "PDF",
    "origin": "builtin",
    "catalog": {
      "category": "files",
      "keywords": [
        "阅读",
        "文档",
        "PDF"
      ],
      "usage": "双击 PDF 打开阅读器，支持跳页、续读与正文搜索。"
    },
    "group": "common",
    "defaultEnabled": true
  },
  {
    "id": "text",
    "title": "文字",
    "origin": "builtin",
    "catalog": {
      "category": "files",
      "keywords": [
        "文字",
        "Markdown",
        "正文"
      ],
      "usage": "粘贴文字、导入文本文件，或从空白处菜单新建文字。"
    },
    "group": "common",
    "defaultEnabled": true
  },
  {
    "id": "view",
    "title": "视图",
    "origin": "builtin",
    "catalog": {
      "category": "views",
      "keywords": [
        "视图",
        "筛选"
      ],
      "usage": "在左侧打开已保存的视图，保存当前筛选和布局。"
    },
    "group": "base",
    "defaultEnabled": true
  },
  {
    "id": "mcp",
    "title": "AI 接入 · MCP",
    "origin": "builtin",
    "catalog": {
      "category": "tools",
      "keywords": [
        "AI",
        "MCP",
        "连接"
      ],
      "usage": "在应用设置的 AI 接入中配置连接与仓库授权。"
    },
    "scope": "application",
    "group": "optional",
    "defaultEnabled": false
  },
  {
    "id": "annotate",
    "title": "批注",
    "origin": "bundled",
    "catalog": {
      "category": "information",
      "keywords": [
        "摘录",
        "批注",
        "标记",
        "圈选"
      ],
      "usage": "在图片、视频中选择局部，或在文字、PDF、EPUB 等阅读器中选字，创建批注或摘录。"
    },
    "group": "recommended",
    "defaultEnabled": true,
    "legacyBuiltin": true,
    "legacyKinds": [
      "anchor",
      "place"
    ]
  },
  {
    "id": "collection",
    "title": "组",
    "origin": "bundled",
    "catalog": {
      "category": "views",
      "keywords": [
        "组",
        "文件夹",
        "目录树",
        "归类",
        "集合"
      ],
      "usage": "在左侧「导航」中的文件夹目录展开多级目录并直接拖拽归档；进入组浏览子文件夹与成员，支持排序、设封面和包含子文件夹穿透查看。"
    },
    "group": "optional",
    "defaultEnabled": false
  },
  {
    "id": "fields",
    "title": "自定义字段",
    "origin": "bundled",
    "catalog": {
      "category": "information",
      "keywords": [
        "模板",
        "字段",
        "表格"
      ],
      "usage": "在左侧管理模板，在素材详情中添加字段；配合表格插件可按字段浏览。"
    },
    "group": "recommended",
    "defaultEnabled": true,
    "legacyBuiltin": true,
    "legacyKinds": [
      "template"
    ],
    "legacyDefinitionPrefixes": [
      "tpl:"
    ]
  },
  {
    "id": "file-editing",
    "title": "文件编辑",
    "origin": "bundled",
    "catalog": {
      "category": "files",
      "keywords": [
        "工作副本",
        "编辑器",
        "版本",
        "恢复"
      ],
      "usage": "右键编辑文件，外部保存后在“编辑中”完成；停用和卸载只隐藏界面，工作副本仍由宿主保留。"
    },
    "group": "common",
    "defaultEnabled": true
  },
  {
    "id": "image-filter",
    "title": "画幅与尺寸",
    "origin": "bundled",
    "catalog": {
      "category": "tools",
      "keywords": [
        "画幅与尺寸",
        "视觉素材"
      ],
      "usage": "按图片画幅和像素尺寸筛选，保留与其他查询条件的组合。"
    },
    "group": "optional",
    "defaultEnabled": false
  },
  {
    "id": "note",
    "title": "笔记",
    "origin": "bundled",
    "catalog": {
      "category": "information",
      "keywords": [
        "笔记",
        "想法"
      ],
      "usage": "在素材详情中编写笔记，也可给批注与摘录补充说明。"
    },
    "group": "common",
    "defaultEnabled": true,
    "legacyBuiltin": true
  },
  {
    "id": "palette",
    "title": "色彩与色板",
    "origin": "bundled",
    "catalog": {
      "category": "information",
      "keywords": [
        "色板",
        "颜色"
      ],
      "usage": "在素材详情中查看主色与占比。"
    },
    "group": "optional",
    "defaultEnabled": false
  },
  {
    "id": "rating",
    "title": "评分",
    "origin": "bundled",
    "catalog": {
      "category": "information",
      "keywords": [
        "评分",
        "视觉素材"
      ],
      "usage": "用 1～5 星筛选与整理素材，支持批量评分和 AI 操作。"
    },
    "group": "optional",
    "defaultEnabled": false
  },
  {
    "id": "source",
    "title": "来源",
    "origin": "bundled",
    "catalog": {
      "category": "information",
      "keywords": [
        "来源",
        "网址"
      ],
      "usage": "在素材详情查看来源，在左侧按网站筛选。"
    },
    "group": "common",
    "defaultEnabled": true,
    "legacyBuiltin": true
  },
  {
    "id": "table",
    "title": "表格",
    "origin": "bundled",
    "catalog": {
      "category": "views",
      "keywords": [
        "表格",
        "列表"
      ],
      "usage": "从视图的显示菜单切换表格，可展示并编辑素材字段。"
    },
    "group": "recommended",
    "defaultEnabled": true,
    "legacyBuiltin": true
  },
  {
    "id": "tag-groups",
    "title": "标签分组",
    "origin": "bundled",
    "catalog": {
      "category": "information",
      "keywords": [
        "标签",
        "分组"
      ],
      "usage": "在筛选工具中浏览；开启整理后管理全库关系。"
    },
    "group": "common",
    "defaultEnabled": true
  },
  {
    "id": "tags",
    "title": "标签基础",
    "origin": "bundled",
    "catalog": {
      "category": "information",
      "keywords": [
        "标签",
        "分组"
      ],
      "usage": "为标签分组和层级标签提供共享打标数据，也可单独在详情中打标。"
    },
    "group": "common",
    "defaultEnabled": true,
    "legacyBuiltin": true,
    "legacyKinds": [
      "tagGroups"
    ]
  }
]
