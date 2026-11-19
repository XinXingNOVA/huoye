import { z } from 'zod'
export const libraryNameSchema = z.string().trim().min(1).max(100).refine(s => !/[<>:"/\\|?*\x00-\x1f]/.test(s) && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s), '仓库名称不能是路径或系统保留名称')
