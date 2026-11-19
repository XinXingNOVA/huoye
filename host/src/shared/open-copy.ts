/** 首批只把常见文档与媒体交给系统查看，不把程序、脚本和快捷方式当作查看器启动。 */
const viewable = new Set(('txt md markdown csv tsv json xml log lrc srt vtt ' +
  'pdf epub mobi azw azw3 djvu doc docx odt rtf xls xlsx ods ppt pptx odp ' +
  'jpg jpeg png gif webp avif bmp tif tiff heic heif svg ico psd ' +
  'mp3 m4a aac wav flac ogg opus aiff alac mp4 m4v mov mkv webm avi wmv flv').split(' '))

export function fileExtension(name: unknown): string | undefined {
  if (typeof name !== 'string') return
  return /\.([a-z0-9]{1,16})$/i.exec(name)?.[1].toLowerCase()
}
export function canOpenCopy(name: unknown): boolean {
  const ext = fileExtension(name)
  return !!ext && viewable.has(ext)
}
