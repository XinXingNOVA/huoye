// 跳过可重建的工程依赖和系统索引。普通点文件和源码目录仍然可见。
const ignoredFolders = new Set(['.git', '.svn', '.hg', 'node_modules', '.Spotlight-V100', '.Trashes'])
const ignoredFiles = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
export function ignoredDirectoryEntry(name: string, directory: boolean) {
  return directory ? ignoredFolders.has(name) : ignoredFiles.has(name.toLowerCase())
}
