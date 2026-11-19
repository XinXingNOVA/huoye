/** 仓库中的相对路径使用 /；读取时也兼容早期 Windows 路径，不改写原记录。 */
export const portablePath = (path: string): string => path.replace(/\\/g, '/')

/** 新增／改名的文件在 Windows 与 macOS 都可保存。 */
export function portableFileName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/[. ]+$/, '')
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean
}
