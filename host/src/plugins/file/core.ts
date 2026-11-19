import { FILE_MIME } from '../../shared/file-metadata'
import { ingestMetadataSchema } from '../../plugin-api/ingest'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CorePlugin } from '../../plugin-api/core/contracts'
import { blocks } from './blocks'
import { renamed } from './names'


function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

export const filePlugin: CorePlugin = {
  id: 'file',
  version: 1,
  blocks,
  operations: [{
    effect: 'data',
    name: 'import_files', title: '收录本地文件',
    input: z.object({
      paths: z.array(z.string().min(1).max(4096).refine(isAbsolute, '请使用本机绝对路径').refine(p => !p.includes('\0'), '路径不能包含空字符')).min(1).max(20).optional(),
      files: z.array(z.object({
        path: z.string().min(1).max(4096).refine(isAbsolute, '请使用本机绝对路径').refine(p => !p.includes('\0'), '路径不能包含空字符'),
        metadata: ingestMetadataSchema.optional()
      }).strict()).min(1).max(20).optional()
    }).strict().refine(args => !!args.paths !== !!args.files, 'paths 和 files 必须且只能提供一个'),
    ingest: args => args.files
      ? (args.files as {path: string; metadata?: Record<string, unknown>}[]).map(file => ({ type: 'file', ...file }))
      : (args.paths as string[]).map(path => ({ type: 'file', path })),
    description: '支持原 paths 数组，或 files:[{path,metadata}]（二选一）。metadata 格式先查 describe_library.ingestMetadata。附加参数预校验，业务处理失败回滚本次素材和附加写入。文件先保存到默认文件空间，再由仓库收录；若报告 FILE_STORED_NOT_ADOPTED，已保存文件保留，用原 requestId 和原参数重试即可接续。items[].metadata 报告 applied/unchanged/preserved。最多 20 个明确的本机绝对路径，原输入保留；不接受目录、通配符或网址。在默认目标空间内按内容去重，回收站中的相同素材会恢复。items 按输入 index 返回 id 和 created/existing/restored，errors 逐项报告失败，成功收录项与附加写入一起撤销，空间文件保留。不等待后台加工；随后用 read_item 的 processing/failures 检查，再用 read_content 读正文。超时用原请求重试；回执不代表素材当前状态，修正逐项错误后用新 requestId 重试失败项。'
  }],
  recognizers: [
    {
      id: 'file.local',
      priority: 100,
      match: (input) => input.type === 'file',
      async ingest(ctx, input) {
        if (input.type !== 'file') throw new Error('不是文件')
        const st = await stat(input.path)
        if (!st.isFile()) throw new Error('[NOT_A_FILE] 只能收录普通文件')
        const hash = await sha256(input.path)
        const unchanged = async () => {
          const now = await stat(input.path)
          if (st.size !== now.size || st.mtimeMs !== now.mtimeMs || st.ctimeMs !== now.ctimeMs || st.ino !== now.ino) {
            throw new Error('[FILE_CHANGED] 收录期间原文件已变化，请文件稳定后重试')
          }
        }
        await unchanged()
        // 去重：同样内容的文件已经在库里
        const existing = ctx.findByField('file', 'hash', hash)
        if (existing) return existing

        const name = basename(input.path)
        const ext = extname(name).slice(1).toLowerCase()
        const id = ctx.createEntity()
        const path = await ctx.importFile(id, input.path, name)
        await unchanged()
        ctx.put(id, 'file', {
          name,
          ext,
          mime: FILE_MIME[ext] ?? 'application/octet-stream',
          size: st.size,
          hash,
          path
        })
        return id
      }
    }
  ],
  // 导出：原文件原样复制（图片、视频、PDF、文档……），用原来的文件名
  exporters: [
    {
      priority: 100,
      match: (b) => !!b.file,
      place: (b) => ({ folder: '素材', name: String(b.file.data.name) }),
      bytes: b => Number(b.file.data.size ?? 0),
      async write(ctx, _id, b, dest) {
        await copyFile(ctx.abs(String(b.file.data.path)), dest, constants.COPYFILE_FICLONE)
      }
    }
  ],
  commands: {
    /**
     * 改名（设计文档 11.14）：args.names 是"身份 → 新名字（不含扩展名）"，扩展名不变。
     * 改本仓库的显示名称；文件身份、内容版本与原件路径保持，数据块改名可撤销。
     * 有一项不能用（空的、太长）就整个不改，说明是哪一项。
     */
    rename(ctx, args) {
      const done: { from: string; to: string }[] = []
      for (const [id, base] of Object.entries(args.names as Record<string, string>)) {
        const file = ctx.blocksOf(id).file
        if (!file) throw new Error('这个素材没有文件，不能改名')
        const from = String(file.data.name)
        let to: string
        try {
          to = renamed(from, String(base))
        } catch (e) {
          throw new Error(`「${from}」：${e instanceof Error ? e.message : String(e)}`)
        }
        if (to === from) continue
        ctx.put(id, 'file', { ...file.data, name: to })
        done.push({ from, to })
      }
      const label = done.length === 1 ? `重命名「${done[0].from}」为「${done[0].to}」` : `重命名 ${done.length} 项`
      return { label, result: { renamed: done.length } }
    }
  }
}

export { filePlugin as plugin }
