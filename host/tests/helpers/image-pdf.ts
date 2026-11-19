/** 自建带 JPEG 首页的 PDF；不依赖用户文件、字体或外部程序。 */
export function imagePdf(jpeg: Buffer, width: number, height: number, pages = 1): Buffer {
  const stream = (bytes: Buffer, dictionary = '') => Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')
  ])
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [3 0 R ${Array.from({ length: pages - 1 }, (_, i) => `${i + 6} 0 R`).join(' ')}] /Count ${pages} >>`),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im 4 0 R >> >> /Contents 5 0 R >>'),
    stream(jpeg, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`),
    stream(Buffer.from('q 600 0 0 800 0 0 cm /Im Do Q'))
  ]
  for (let i = 1; i < pages; i++) objects.push(objects[2])
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets: number[] = []
  let length = chunks[0].length
  objects.forEach((object, i) => {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    chunks.push(chunk); length += chunk.length
  })
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(chunks)
}
