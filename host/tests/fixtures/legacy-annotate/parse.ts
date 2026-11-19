/** 一句话拆成笔记和标签：#光影、＃光影 这样的词是标签，其余是笔记。 */
export function parseAnnotation(input: string): { note: string; tags: string[] } {
  const tags = [...input.matchAll(/[#＃]([^\s#＃,，]+)/g)].map((m) => m[1])
  const note = input
    .replace(/[#＃][^\s#＃,，]+/g, '')
    .replace(/\s+/g, ' ')
    // 标签拿走后，首尾留下的分隔符也去掉
    .replace(/^[\s，,、；;]+|[\s，,、；;]+$/g, '')
  return { note, tags: [...new Set(tags)] }
}
