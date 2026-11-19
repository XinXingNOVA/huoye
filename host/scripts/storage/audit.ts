import { auditLibrary } from './audit-library.ts'

const args = process.argv.slice(2), json = args.includes('--json'), roots = args.filter(v => v !== '--json')
if (!roots.length || roots.some(v => v.startsWith('-'))) {
  console.error('用法：npm run storage:audit -- [--json] <仓库路径> [更多仓库路径]\n请先关闭待检查仓库。只读取登记与数据库，不扫描原件字节或修改数据。')
  process.exitCode = 2
} else {
  const reports = roots.map(root => auditLibrary(root))
  if (json) console.log(JSON.stringify(reports, null, 2))
  else for (const r of reports) {
    console.log(`${r.root}：${{ clear: '未发现旧运行依赖或未结束任务', review: '需要核对', incomplete: '检查不完整' }[r.status]}`)
    console.log(`旧原始引用 ${r.counts.legacyReferences}，疑似引用 ${r.counts.undeclaredCandidates}，派生引用 ${r.counts.derivedReferences}，历史引用 ${r.counts.historyReferences}，未结束任务 ${r.counts.tasks}`)
    for (const issue of r.issues) console.log(`  ${issue.code} · ${issue.location}：${issue.message}${issue.count === undefined ? '' : `（${issue.count}）`}`)
    for (const sample of r.samples) console.log(`  ${sample.source} · ${sample.entity}/${sample.kind}.${sample.field}${sample.trashed ? '（回收站）' : ''}：${sample.reference}`)
    console.log(`样本最多 ${r.sampleLimit} 条；历史引用仅作信息，不自动清除。备份／封存原件不扫描，此结果不保证文件字节可用。`)
  }
  process.exitCode = reports.some(r => r.status === 'incomplete') ? 2 : reports.some(r => r.status === 'review') ? 1 : 0
}
