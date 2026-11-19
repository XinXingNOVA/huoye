import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 终态回执仅供核对；只有仍可继续的固定计划阻止替换包。 */
export function packageTaskBlockers(directory: string, hash: string, namespaces: string[]): string[] {
  const records: { file: string; title: string }[] = []
  const collect = (folder: string, title: string) => {
    if (existsSync(folder)) for (const file of readdirSync(folder).filter(f => f.endsWith('.json'))) records.push({ file: join(folder, file), title })
  }
  collect(join(directory, 'preset-applications'), '方案应用')
  collect(join(directory, 'library-creations'), '建库')
  for (const id of namespaces) {
    collect(join(directory, id, 'management', 'configurations'), '插件调整')
    const folder = join(directory, id, 'management', 'installations')
    if (existsSync(folder)) for (const item of readdirSync(folder)) {
      const file = join(folder, item, 'job.json')
      if (existsSync(file)) records.push({ file, title: '安装' })
    }
  }
  const contains = (value: unknown): boolean => value === hash || !!value && typeof value === 'object' && Object.values(value).some(contains)
  return records.flatMap(({ file, title }) => {
    const job = JSON.parse(readFileSync(file, 'utf8'))
    if (job.state === 'completed' || job.state === 'cancelled') return []
    return contains(job) ? [`有未完成的${title}任务引用旧版，请先接续或取消`] : []
  })
}
