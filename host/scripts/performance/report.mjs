export const stats = values => {
  const a = values.filter(Number.isFinite).toSorted((a, b) => a - b)
  if (!a.length) return null
  return { n: a.length, min: a[0], median: a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2,
    p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) }
}
// 合成器的长帧与图块缺失分别计数。单轮保留，汇总按帧数加权。
export function summarizeGlass({ runs, ...setup }) {
  function metrics(samples) {
    const frames = samples.flatMap(r => r.frameMs)
    const counted = samples.filter(r => r.expected != null)
    const sum = key => counted.length ? counted.reduce((n, r) => n + r[key], 0) : null
    return { countedRounds: counted.length, expected: sum('expected'), dropped: sum('dropped'), checkerboarded: sum('checkerboarded'),
      presentationMs: stats(frames), over25ms: frames.filter(ms => ms > 25).length,
      over50ms: frames.filter(ms => ms > 50).length, drawMs: stats(samples.flatMap(r => r.drawMs)) }
  }
  const groups = []
  for (const width of new Set(runs.map(r => r.width))) for (const mode of ['off', 'shell', 'cards']) {
    const samples = runs.filter(r => r.width === width && r.mode === mode)
    groups.push({ width, mode, rounds: samples.length, ...metrics(samples) })
  }
  return { ...setup, groups, runs: runs.map(r => ({ round: r.round, width: r.width, mode: r.mode,
    mounted: r.mounted, end: r.end, ...metrics([r]) })) }
}

export function summarize(runs) {
  const groups = new Map()
  for (const r of runs) {
    if (r.phase === 'startup') {
      for (const key of ['launchToDomReadyMs', 'launchToFirstGridMs']) {
        const rows = groups.get(key) ?? []; rows.push({ ms: r[key] }); groups.set(key, rows)
      }
    }
    for (const sample of r.samples) { const rows = groups.get(sample.name) ?? []; rows.push(sample); groups.set(sample.name, rows) }
  }
  return Object.fromEntries([...groups].map(([name, rows]) => [name, {
    duration: stats(rows.map(r => r.ms)), rendererLag: stats(rows.flatMap(r => r.rendererTimerLagMs ?? [])),
    mainLoopMax: stats(rows.map(r => r.mainLoopMaxMs)), coreProbe: stats(rows.flatMap(r => r.coreProbeMs ?? [])),
    rendererLagOver50ms: rows.flatMap(r => r.rendererTimerLagMs ?? []).filter(v => v > 50).length
  }]))
}
// 保存可复核的操作耗时样本；计时探针逐次采样保留在原始运行 JSON 中。
export function timingSamples(runs) {
  const groups = {}
  const add = (name, ms) => { (groups[name] ??= []).push(ms) }
  for (const run of runs) {
    if (run.phase === 'startup') for (const name of ['launchToDomReadyMs', 'launchToFirstGridMs']) add(name, run[name])
    for (const sample of run.samples) add(sample.name, sample.ms)
  }
  return groups
}
export const labels = {
  launchToDomReadyMs: '进程启动 → 页面加载完成', launchToFirstGridMs: '进程启动 → 首屏缩略图就绪',
  idle_1000ms: '空闲观察（固定 1 秒）', query_all_rpc: '全部素材查询 RPC', search_note_rpc: '笔记全文搜索 RPC',
  get_100_rpc: '读取 100 项数据块 RPC', scan_spaces_unchanged: '所有空间无变化检查', references_preview_10: '10 项引用范围快照',
  space_page_50: '空间首页 50 项', space_notification_refresh: '一次空间变更通知与刷新',
  search_note_ui_including_debounce: '界面搜索 → 结果显示（含 250ms 防抖）', original_read_10: '读取 10 个原件（含 RPC）',
  import_10_ack: '导入 10 张新图 → 收录回执', import_10_ready: '导入 10 张新图 → 完整加工',
  library_trash_10: '仅回收 10 项仓库素材', combined_preview_10: '组合删除 10 项预览', combined_delete_10: '组合删除 10 项执行及通知'
}
const number = n => n == null ? '—' : n.toFixed(1)
export function markdown(report) {
  const cases = report.cases, title = c => `${c.count.toLocaleString('en-US')} 项 / ${c.spaces} 空间`
  const names = [...new Set(cases.flatMap(c => Object.keys(c.metrics)))]
  let out = `# 应用性能基线\n\n${report.createdAt} · ${report.environment.platform}/${report.environment.arch} · ${report.environment.cpu}\n\n源码基点：\`${report.source.commit}\`，工作区${report.source.dirty ? '包含未提交改动' : '干净'}；构建内容摘要：\`${report.source.buildHash}\`。构建耗时单独记录：${number(report.buildMs)} ms，不混入启动。\n\n`
  out += '夹具为真实 v4 文件空间、唯一 PNG 原件和真实加工缓存；容量数据批量合成，测量中的新增导入经过 Electron utilityProcess。每 10 项有一份可搜索笔记，所有项目有标签。三个空间场景包含一个随库独享空间和两个独立共享空间，各关联一个仓库。\n\n'
  out += '**时间口径**：以下为中位数，单位 ms；原始样本和 P95 见 JSON。启动是新进程、已生成缓存且系统文件缓存未清空，不是真正冷盘启动，也不是 `npm run dev` 构建时间。首屏定义为数量正确、可见卡片缩略图加载完毕并经过两次动画帧；轮询分辨率 20ms。少量样本的 P95 接近最大值，不视为稳定分位数。\n\n'
  out += `| 场景 | ${cases.map(title).join(' | ')} |\n| --- | ${cases.map(() => '---:').join(' | ')} |\n`
  for (const name of names) out += `| ${labels[name] ?? name} | ${cases.map(c => number(c.metrics[name]?.duration?.median)).join(' | ')} |\n`
  out += '\n## 操作期间响应性\n\n渲染器用 20ms 计时器，表中为相对预期触发时刻的**最大延迟**，不是 FPS、点击延迟或所有帧都流畅的证明。主进程事件循环采样和核心空请求往返时间也存入 JSON。探针本身有固定开销；所有场景使用相同配置。\n\n'
  out += `| 场景 | ${cases.map(title).join(' | ')} |\n| --- | ${cases.map(() => '---:').join(' | ')} |\n`
  for (const name of names.filter(n => !n.startsWith('launch'))) out += `| ${labels[name] ?? name} | ${cases.map(c => number(c.metrics[name]?.rendererLag?.max)).join(' | ')} |\n`
  out += '\n窗口计时器正常不代表数据请求立即返回。以下为各阶段核心空请求往返时间的最大值（ms），可观察核心繁忙时的等待；短操作可能在下一次探针发出前结束，不能用它证明每次操作都无阻塞。\n\n'
  out += `| 场景 | ${cases.map(title).join(' | ')} |\n| --- | ${cases.map(() => '---:').join(' | ')} |\n`
  for (const name of ['idle_1000ms', 'space_notification_refresh', 'combined_delete_10']) out += `| ${labels[name]} | ${cases.map(c => number(c.metrics[name]?.coreProbe?.max)).join(' | ')} |\n`
  out += '\n## 内存阶段快照\n\n下表为操作进程中核心 utilityProcess 的工作集（MiB），不含另三次启动进程。没有强制 GC，也没有测长期空闲回落，单轮增长不足以判定泄漏。\n\n'
  out += `| 阶段 | ${cases.map(title).join(' | ')} |\n| --- | ${cases.map(() => '---:').join(' | ')} |\n`
  for (const [stage, label] of [['first-grid', '首屏'], ['after-reads', '读取与刷新后'], ['after-writes', '导入与删除后']]) {
    out += `| ${label} | ${cases.map(c => { const p = c.memory.find(m => m.phase === 'operations' && m.stage === stage)?.processes.find(p => p.name.includes('核心')); return number(p ? p.workingSetKB / 1024 : null) }).join(' | ')} |\n`
  }
  out += '\n## 使用边界\n\n- 尚无改造前的同口径数据，这份报告不能说明变快或变慢了多少。\n- 使用小型合成 PNG 验证容量与流程；新增导入是 1600×1000 纯色 PNG，不代表高分辨率照片、PDF、视频或网络磁盘的吞吐。\n- 读阶段在写阶段之前；每例新增 30 项，再组合删除原夹具 30 项。每个操作的输入规模固定，基准每轮从新临时仓库开始。\n- 真实系统废纸篓测量目前仅在 macOS 启用；结束后只按登记身份取回本次测试包，不遍历其他文件。\n- 内存数据是阶段快照与各进程工作集，不能直接相加视为独占物理内存。\n- 不设置绝对耗时作为 CI 成败条件；校验结果、数量、文件可用性或加工失败才阻止基线生成。\n'
  return out
}
