/** 网址 → 网站。不是网页地址时返回 undefined。 */
export function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return u.hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

