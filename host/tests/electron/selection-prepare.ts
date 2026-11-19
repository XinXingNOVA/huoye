import './epub-prepare'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
// 自建两页 PDF；真实导入发生在 Electron utilityProcess。
const objects = ['<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
for (let n = 1;n <= 2;n++) {
  const stream = `BT /F1 18 Tf 40 700 Td (Selection page ${n} shared channel example.) Tj 0 -32 Td (Second line for annotations and notes.) Tj ET`
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
}
objects.push(
  '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 2 >>',
  '<< /Title (Part one) /Parent 8 0 R /First 10 0 R /Last 10 0 R /Count 1 /Dest [4 0 R /Fit] >>',
  '<< /Title (Second page) /Parent 9 0 R /Dest [6 0 R /XYZ null 780 null] >>'
)
let pdf = '%PDF-1.4\n'; const offsets = [0]
objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
writeFileSync(join(resolve(process.argv[2]), '共享选区.pdf'), pdf)
