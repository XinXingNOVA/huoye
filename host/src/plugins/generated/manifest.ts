// 自动生成：npm run plugins:generate。请修改各插件的 plugin.json / distribution.json，勿手工编辑。
import type { PluginInfo } from '../../shared/plugin-plan'

export const PLUGINS: PluginInfo[] = [
  {
    "id": "file",
    "title": "文件",
    "required": true,
    "description": "收录、保管和取回原文件，按内容去重。",
    "order": 10,
    "entries": {
      "blocks": "./blocks.ts",
      "core": "./core.ts",
      "ui": "./ui.tsx"
    },
    "catalog": {
      "category": "files",
      "keywords": [],
      "usage": "拖入文件，或从空白处菜单收录；在素材详情中取回原文件。"
    }
  },
  {
    "id": "preview",
    "title": "预览",
    "description": "为素材提供代表图与缩略图支撑。",
    "order": 20,
    "entries": {
      "blocks": "./blocks.ts",
      "core": "./core.ts",
      "ui": "./ui.tsx"
    },
    "catalog": {
      "category": "tools",
      "role": "support",
      "keywords": [
        "缩略图",
        "封面"
      ],
      "usage": "处理媒体代表图，生成素材卡片缩略图。"
    }
  },
  {
    "id": "image",
    "title": "图片",
    "description": "查看图片，读取尺寸并生成代表图。",
    "requires": [
      "file",
      "preview"
    ],
    "order": 30,
    "entries": {
      "blocks": "./blocks.ts",
      "core": "./core.ts",
      "ui": "./ui.tsx"
    },
    "catalog": {
      "category": "files",
      "keywords": [
        "照片",
        "图片"
      ],
      "usage": "双击图片打开查看器，在素材详情中查看尺寸。"
    }
  },
  {
    "id": "video",
    "title": "视频",
    "description": "播放视频、生成封面与预览帧，支持倍速和续播。",
    "capabilities": {
      "version": 2,
      "consumes": [
        "media.inspect@1"
      ]
    },
    "requires": [
      "file",
      "preview"
    ],
    "order": 40,
    "optional": [
      "annotate"
    ],
    "entries": {
      "blocks": "./blocks.ts",
      "core": "./core.ts",
      "ui": "./ui.tsx"
    },
    "catalog": {
      "category": "files",
      "keywords": [
        "影片",
        "视频"
      ],
      "usage": "双击视频打开播放器，支持续播和倍速。"
    }
  },
  {
    "id": "audio",
    "title": "音频",
    "description": "试听音频、读取曲目信息与封面，支持倍速和续听。",
    "capabilities": {
      "version": 2,
      "consumes": [
        "media.inspect@1"
      ]
    },
    "requires": [
      "file"
    ],
    "optional": [
      "preview"
    ],
    "order": 45,
    "entries": {
      "blocks": "./blocks.ts",
      "core": "./core.ts",
      "ui": "./ui.tsx"
    },
    "catalog": {
      "category": "files",
      "keywords": [
        "歌曲",
        "音频",
        "封面"
      ],
      "usage": "双击音频试听；音乐插件可提供歌单与持续播放。"
    }
  },
  {
    "id": "pdf",
    "title": "PDF",
    "description": "阅读 PDF、搜索正文，记录阅读位置。",
    "requires": [
      "file",
      "preview"
    ],
    "order": 50,
    "optional": [
      "annotate"
    ],
    "entries": {
      "blocks": "./blocks.ts",
      "core": "./core.ts",
      "ui": "./ui.tsx"
    },
    "catalog": {
      "category": "files",
      "keywords": [
        "阅读",
        "文档",
        "PDF"
      ],
      "usage": "双击 PDF 打开阅读器，支持跳页、续读与正文搜索。"
    }
  },
  {
    "id": "text",
    "title": "文字",
    "description": "新建和收录文字，阅读与编辑 Markdown、文本文件。",
    "order": 70,
    "optional": [
      "file",
      "annotate",
      "tags",
      "source"
    ],
    "entries": {
      "blocks": "./blocks.ts",
      "core": "./core.ts",
      "ui": "./ui.tsx"
    },
    "catalog": {
      "category": "files",
      "keywords": [
        "文字",
        "Markdown",
        "正文"
      ],
      "usage": "粘贴文字、导入文本文件，或从空白处菜单新建文字。"
    }
  },
  {
    "id": "view",
    "title": "视图",
    "description": "保存筛选条件与布局，快速回到常用视图。",
    "required": true,
    "order": 160,
    "entries": {
      "blocks": "./blocks.ts",
      "core": "./core.ts"
    },
    "catalog": {
      "category": "views",
      "keywords": [
        "视图",
        "筛选"
      ],
      "usage": "在左侧打开已保存的视图，保存当前筛选和布局。"
    }
  },
  {
    "id": "mcp",
    "title": "AI 接入 · MCP",
    "description": "通过 MCP 让本机 AI 搜索、读取和整理素材；连接权限另在本机设置，默认关闭。",
    "order": 170,
    "entries": {
      "service": "./application-service.ts",
      "ui": "./ui.tsx"
    },
    "executables": {
      "mcp": "./stdio.ts"
    },
    "scope": "application",
    "catalog": {
      "category": "tools",
      "keywords": [
        "AI",
        "MCP",
        "连接"
      ],
      "usage": "在应用设置的 AI 接入中配置连接与仓库授权。"
    }
  }
]
