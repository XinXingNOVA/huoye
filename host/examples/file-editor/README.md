# 文件版本编辑示例

最小外部 UI 插件，使用 `host.core` 的公共文件编辑协议，不导入宿主私有模块，没有核心或服务入口。

```sh
npm run plugin:pack -- examples/file-editor artifacts/plugins/file-editor.rmplugin
```

在临时仓库安装并启用，重载后打开“设置 → 当前仓库”底部的“公共文件编辑示例”。先导入 Markdown / TXT，并关联一个新版独享空间用于保存副本；要原件发布，文件本身须位于新版空间且已授予仓库更新权限。

选择文件 → 读取原件与能力 → 编辑文字 → 准备独立副本／原件新版 → 核对影响并确认。示例只显示前 50 项文件中的 TXT / Markdown，不负责完整文件选择器、分页或编辑器工作区恢复。确认参数在组件状态中，失败保留以便同参重试，关闭设置后不恢复编辑草稿 UI；框架保留未清理的草稿字节。

接口、MCP 权限和限制见[公共文件编辑](../../docs/plugins/公共文件编辑.md)。不要把 UI 异步流程放进同步 `commands` 数据块事务。自动验证使用 `node tests/electron/file-edits-check.mjs`。
