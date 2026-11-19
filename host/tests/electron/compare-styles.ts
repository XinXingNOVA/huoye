import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** 可选的重构对照：提供上一版构建 CSS，复用 capture 的真实页面，不维护截图金样。 */
export async function compareStyles(win: BrowserWindow, dir: string, name: string) {
  const baseline = process.env.RM_STYLE_BASELINE
  if (!baseline) return
  const css = readFileSync(baseline, 'utf8')
  const result = await win.webContents.executeJavaScript(String.raw`(async () => {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')].filter(e => /assets\/index-.*\.css/.test(e.href));
    if (links.length !== 1) throw new Error('未找到唯一宿主样式表');
    const link = links[0], root = document.documentElement;
    const saved = { style: root.getAttribute('style'), density: root.getAttribute('data-density') };
    const old = document.createElement('style'), still = document.createElement('style');
    old.textContent = ${JSON.stringify(css)}.replace(/url\(([^)]+)\)/g, (_, value) => 'url("' + new URL(value.replace(/^["']|["']$/g, ''), link.href).href + '")');
    still.textContent = '*,:before,:after{transition:none!important;animation:none!important;caret-color:transparent!important}';
    link.after(old); old.disabled = true; document.head.append(still);
    const settle = async () => { for (let i=0;i<8;i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
    const results = [];
    try {
      for (const variant of ['current', 'light-compact']) {
        if (variant === 'light-compact') {
          root.dataset.density = 'compact'; root.style.colorScheme = 'light';
          for (const [key,value] of Object.entries({'--shell':'#eef0f4','--bg':'#fafbfc','--panel':'#f4f5f7','--panel-2':'#e7e9ee','--elevated':'#fff','--line':'#d5d8df','--text':'#20232a','--muted':'#626976'})) root.style.setProperty(key,value);
        }
        await settle();
        const nodes = [...document.body.querySelectorAll('*')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
        const read = () => nodes.map(e => ['', '::before', '::after'].map(p => { const s=getComputedStyle(e,p||null); return Object.fromEntries([...s].map(k=>[k,s.getPropertyValue(k)])); }));
        const current = read(); link.disabled = true; old.disabled = false; await settle();
        const before = read(), differences = [];
        before.forEach((pseudos,i) => pseudos.forEach((styles,j) => Object.keys(styles).forEach(key => {
          const a=styles[key], b=current[i][j][key];
          if (a !== b && differences.length < 60) differences.push({node:nodes[i].tagName+'.'+nodes[i].getAttribute('class'),pseudo:j,property:key,before:a,after:b});
        })));
        results.push({variant,elements:nodes.length,differences});
        old.disabled = true; link.disabled = false;
      }
    } finally {
      old.remove(); still.remove(); link.disabled = false;
      for (const [key,value] of [['style',saved.style],['data-density',saved.density]]) if(value===null) root.removeAttribute(key); else root.setAttribute(key,value);
      await settle();
    }
    return results;
  })()`)
  writeFileSync(join(dir, name + '.styles.json'), JSON.stringify(result, null, 2))
  assert(result.every((r: { differences: unknown[] }) => !r.differences.length), `样式对照有变化：${name}；详见 ${dir}`)
}
