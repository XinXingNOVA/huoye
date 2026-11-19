// 自动生成：npm run plugins:generate。请修改各插件的 plugin.json / distribution.json，勿手工编辑。
export const executables: { id: string; name: string; source: string }[] = [
  {
    "id": "mcp",
    "name": "mcp",
    "source": "src/plugins/mcp/stdio.ts"
  }
]

// 只用于类型检查所有独立入口，不会加载其运行时代码。
export type ExecutableModules = {
  "mcp": typeof import("../mcp/stdio.ts")
}
