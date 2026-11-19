/** 比例区域按 EXIF 转正后的像素计算。输入必须为库内文件，输出仅可写入 cache。 */
export interface ImageCrop {
  source: string
  destination: string
  region: { x: number; y: number; w: number; h: number }
  maxSide: number
  quality: number
}
export interface ImageTools {
  /** image-sample-v1：EXIF 转正、sRGB 三通道紧凑字节；最长边 1～256，不放大，不写缓存。 */
  sample(options: { source: string; maxSide: number }, signal: AbortSignal): Promise<{ data: Uint8Array; width: number; height: number }>

  /** 输出 JPEG，限制最长边且不放大；失败或取消不替换已有缓存文件。 */
  crop(options: ImageCrop, signal: AbortSignal): Promise<{ width: number; height: number }>
}
