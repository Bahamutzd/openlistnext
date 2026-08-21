// Strm 驱动配置类型

export interface StrmAddition {
  /** 路径映射，每行一个：源路径=目标路径（如 /strm=/mnt/media） */
  paths?: string
  /** strm 文件内容的前缀 URL（可选，strm 内容不含完整 URL 时拼接） */
  siteUrl?: string
  /** 要过滤的文件后缀（默认 strm） */
  filterFileTypes?: string
  /** 需要跟随下载的文件后缀（默认 ass） */
  downloadFileTypes?: string
  /** 是否编码 strm 内容中的路径 */
  encodePath?: boolean
  /** strm 文件内容是否不含 URL 前缀 */
  withoutUrl?: boolean
}
