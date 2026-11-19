# 组／文件夹（Collection）V1 · 1.5.1

1.5.1 补齐 `content-drop-v1` 与 `navigation-context-v1` 能力声明；导航拖入由宿主按内容实例统一处理，移到中央／独立窗口后仍使用同一套规则。已有组与成员数据不变。

把相关素材归到一个组，提供组卡、组内浏览和有效“未分组”视图。组本身也是普通素材，可以单独添加标签、笔记、来源和自定义模板；这些信息不继承给成员。它与标签插件的“标签分组”是两种独立组织方式。

## 安装与使用

```sh
npm run pack
```

在 **设置 → 应用 → 本地插件** 添加 `artifacts/collection.rmplugin`，在当前仓库勾选“组”，统一应用并重新加载。这是主动安装的外部包，不进入应用附带清单；没有 npm 运行依赖，使用公共 SDK 提供的 React、Zod 等能力。需要支持 `business-queries-v1`、`ingest-metadata-v1`、`ingest-read-v1`、`command-trash-v1`、`command-restore-v1`、`read-title-candidates-v1` 的宿主。1.1.0 增加恢复、批次范围查询、AI 名称候选和可选空组筛选；须先更新并重启应用，再安装／选择新版包。1.2.0 增加视图与查看器的顺序联动，需要宿主支持 UI 能力 `navigation-order-v1`。持久定义不变，沿用已有组和成员关系。

- 左侧“组”打开组目录，点击“新建组”。也可以在普通素材的操作菜单中使用“新建组并移入…”或“移动到组…”。
- 打开组后，用“添加素材”选择未分组素材，或从仓库内拖入素材卡。选中成员后可移动、移出或设为封面；按 Ctrl／⌘ 多选，Escape 清空选择，Enter 打开单项。
- 组目录与组内都有搜索和分页，每页 20 项；未搜索时可用卡片下方的前移、后移按钮在当前页内调整顺序，末尾按钮移到整个列表末尾。组内搜索沿用全文搜索，组目录只搜组名。分页视图中的全选只选当前页；导出选中项，未选择时导出当前页，并在导出名称中标明。
- 从组内打开图片等素材，查看器沿用组内筛选和排序，可跨页切换同类型素材；从“未分组”打开时使用当前页范围和顺序。双击卡片、打开素材按钮、Enter，以及详情里的打开均支持。
- 打开组默认在右侧展示组的信息；选中成员后展示成员信息。“组的信息”恢复组的选择，附加标签、笔记或模板沿用现有插件。
- 主网格仍混排组卡与素材卡，成员仍然可见。V1 不实现主网格自动折叠、组嵌套、树形目录、递归文件夹导入或跨组批量重排。
- 组内拖入只处理仓库内部素材引用；本地文件可先用宿主收录，再入组，或通过 MCP 导入附加内容直接入组。

组名允许重复，身份由 ID 区分。每次移动最多 100 项，一项素材只属于一个组；再次加入同一组保留顺序，移到其他组显式替换原归属。空组不会自动删除；组卡显示“空组 · 0 项成员”，目录可勾选“隐藏空组”，默认仍显示。筛选只影响列表，在该标签页本机保存，不删除数据。

## 数据、生命周期与封面

| 数据块 | 挂载位置 | 字段 |
| --- | --- | --- |
| `collection` | 组实体，`content: true` | `title`（索引、搜索）、`order`（索引）、可选 `cover`（link ref） |
| `collectionMember` | 成员素材 | `group`（单值 link ref、索引）、`order`（索引） |

两块都持久保存，不是管理记录，也不使用 attach 引用。组与成员都由明确业务入口创建关系，不出现在通用快速附加列表里。

删除组只把组送进回收站，成员身份和原关系保持。目标组被删除或彻底清除时，成员在本插件中视为未分组；恢复组后，仍指向它的成员自动归回，已移去其他组的成员不会被抢回。删除成员不需要维护另一份成员清单。彻底删除仍使用宿主现有显式入口，插件不提供 MCP 彻底删除操作。

手选封面必须是本组的活跃成员；没有手选封面，或所选成员被删除、移走时，回退到排序后的首个活跃成员，空组显示文件夹图标。复用成员已有的公共封面组件，不复制原图、不新建缩略图加工系统。首项没有图片时会显示其文本或格式封面，不扫描全组寻找第一张图片。“自动封面”清除手选引用。封面引用失效时保留原引用，恢复原成员且仍在组内后可重新采用。

停用或卸载撤下专用视图、命令与查询，数据、原文件和关系留在仓库，通用数据读取仍可用；重新安装启用后接续。普通导出组只导出组记录及附加信息，**不递归导出成员文件**；需要在组内选择成员另行导出。

## MCP 与其他调用方

先 `describe_library` 发现当前库的操作、查询与导入能力。应用 MCP 调用须带 `libraryId`；以下省略它。写入通过 `execute_operation`，每次独立修改使用新 `requestId`，重试同一请求保持同一 ID。操作全部走宿主事务、回执与会话内撤销，不新增 MCP 工具分支。

| operation | args | 说明 |
| --- | --- | --- |
| `collection_create` | `{title, ids?, cover?, order?}` | 返回 `{id}`，可同时移动最多 100 项；初始 cover 必须在 ids 中 |
| `collection_rename` | `{id, title}` | 改组名，非空且最多 200 字符 |
| `collection_delete` | `{id}` | 组进回收站，成员保留 |
| `collection_restore` | `{id}` | 恢复组，仍指向它的成员归回，已移去别组的不抢回；已彻底删除报错 |
| `collection_move` | `{ids, group}` | group 为组 ID，或 null 移出；最多 100 项，不接受组或管理记录 |
| `collection_set_cover` | `{id, assetId}` | assetId 为有效成员 ID，null 恢复自动 |
| `collection_reorder` | `{id, beforeId, group}` | group:null 排组目录，否则排组内成员；beforeId:null 移到末尾 |

导入时可组合其他插件的声明：

```json
{
  "operation": "import_files",
  "requestId": "trip-import-001",
  "args": {
    "files": [{
      "path": "/绝对路径/照片.jpg",
      "metadata": {
        "collection.join": { "group": "collection_create 返回的 id", "order": 1 },
        "tags.set": { "values": ["旅行", "参考"] },
        "note.initial": { "text": "以后绘画时参考" }
      }
    }]
  }
}
```

`collection.join` 在提交事务内通过公共 `readEntity` 复查组存在且活跃，然后写当前素材关系；可覆盖已有素材原归属。同组且未指定新顺序时保留原值；新归属未指定 order 时使用当前时间。采集方如需固定位置应明确给 order，界面重排会重写当前列表的顺序值。目标无效时整次 metadata 提交失败，其他插件写入也回滚，不产生成功回执。建组与文件收录是两次独立操作，导入失败不会撤销之前建好的空组。

只读通过 `execute_query`：

| query | args | 结果 |
| --- | --- | --- |
| `collection.list` | `{text?, hideEmpty?}` | hideEmpty 默认 false；按组顺序分页返回 `{id,title}` |
| `collection.members` | `{group, text?, ids?}` | group 为组 ID，null 为有效未分组；分页返回 `{id,title}` |
| `collection.summary` | `{id}` | `{id,title,count,coverId,coverPath}`；封面与路径可以为 null |

前两者在请求顶层接受 `limit`／`cursor`，返回 `{items,total,nextCursor,titleCandidates}`。`titleCandidates` 是以当前页 ID 为键的名称候选映射，例如 `{"素材id":[{"kind":"file","field":"name","text":"01.webp","truncated":false}]}`；候选来自公共读取，不改变卡片标题。分页主体仍为轻量 `{id,title}`，候选仅随当前页输出，避免给整个组的分页清单附加长文本。候选每项最多 300 字符、最多 8 项；业务响应仍受 64 KiB 限制，候选较多时应减小顶层 limit。最后一项不分页；`coverPath` 是库内相对缓存路径，**不是文件读取授权或网页 URL**。原始 ref 条件可用于 `search_items`，但 `collectionMember.group` 为空不等同于业务上的“未分组”，后者还包含目标已删除或缺失的情况。组名查询与卡片标题优先于其笔记。成员的 title 仍保留旧规则；AI 可从候选中的 kind/field 辨认文件名与笔记，不将 title 当作文件名，也不将任意名称当作唯一身份。

要问“本次导入有哪些没归组”，保留 import_files 回执里的素材 ID，再调用 `collection.members`，args 为 `{group:null, ids:[...]}`。ids 最多 100 项；显式空数组返回空列表，未传才查询全库，未知／已回收／组本身的 ID 不作为成员返回。较大批次由调用方分批；导入失败而没有素材 ID 的项看回执 errors。

纯 MCP 恢复闭环：`collection_delete` → `search_items({query:{scope:"trash",has:["collection"]}})` → `collection_restore` → `collection.members`。新操作使用新 requestId；同一请求重试复用原值。已活跃组重复恢复不新增数据修改，恢复是写操作，read 模式拒绝。

V1 用公共有界查询组合实现，不新增宿主 SQL 或任意查询通道。单列表最多 4000 项，单次聚合最多 88 次搜索；“未分组”还要读取有效组和失效引用，所以可能更早触及预算。超限明确报 `COLLECTION_LIMIT`，不悄悄截断；可以缩小内容搜索，但若组目录本身过大，V1 未分组查询仍不能处理。排序最多 10000 项。它适合当前个人规模，超大仓库应再根据实测补公共聚合能力。

## 独立开发

运行 `npm ci` 安装本工程依赖；设置 `RM_PLUGIN_TOOLCHAIN` 为宿主工程，或在未提交的 `.rm-dev.json` 中指定 `toolchain`。`npm run configure` 生成本机编辑器 SDK 路径；`npm run check` 检查公共 API 边界和类型（也会刷新 SDK 路径），`npm run pack` 输出 `artifacts/collection.rmplugin`，`npm run dev` 监听源码。应用按仓库选择本目录，勾选后应用并重载。插件 ID／数据不因目录位置改变。

宿主集成验证由宿主可选测试套件负责；本工程不复制宿主私有测试框架。

## AI 操作权限

本版声明 `operation-effects-v1`，需要支持该特性的宿主。新建、改名、调整上下级、删除和恢复文件夹属于 `structure`，需要 `admin`；移动素材、选封面和排序属于 `data`，允许 `organize`／`admin`。安装后还须在目标仓库启用新版本；旧包不会因宿主升级自动获得声明。
