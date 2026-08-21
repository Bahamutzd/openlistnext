// Strm 驱动配置类型（字段与原版 OpenList drivers/strm/meta.go 对齐，
// 保证从原版导出的备份可直接恢复使用）

export interface StrmAddition {
  /** 路径映射，每行一个。两种格式（原版 getPair）：
   *  - `key:value`（冒号，key 不含 "/"）→ key 作为虚拟根名，value 为目标存储挂载路径
   *  - 裸路径 `/xxx/yyy` → 最后一段作为 key，整个路径作为 value */
  paths?: string
  /** strm 文件内容的前缀 URL（可选，默认用本站 /api 地址） */
  siteUrl?: string
  /** strm 内容路径前缀（默认 /d，原版 PathPrefix） */
  pathPrefix?: string
  /** 需要跟随下载的文件后缀（默认 ass,srt,vtt,sub,strm，字幕等小文件原样返回） */
  downloadFileTypes?: string
  /** 支持转成 .strm 的媒体后缀（默认 mp4,mkv,flv,avi,wmv,ts,rmvb,webm,mp3,flac,aac,wav,ogg,m4a,wma,alac） */
  filterFileTypes?: string
  /** 过滤掉小于该大小的文件（单位 MB，0 关闭） */
  minFileSize?: number
  /** 是否编码 strm 内容中的路径（默认 true） */
  encodePath?: boolean
  /** strm 文件内容是否不含 URL 前缀（默认 false，含完整 URL） */
  withoutUrl?: boolean
  /** 是否在 strm 链接后附加 sign（默认 false） */
  withSign?: boolean
  /** 是否把 strm 保存到本地（原版 SaveStrmToLocal，本项目暂不支持） */
  saveStrmToLocal?: boolean
  /** 保存到本地路径（原版 SaveStrmLocalPath） */
  saveStrmLocalPath?: string
  /** 保存模式 insert/update/sync（原版 SaveLocalMode） */
  saveLocalMode?: string
  /** 配置版本（原版 Version=5 表示已升级，本项目忽略） */
  version?: number
}

/** 路径映射：key（虚拟根名）→ 目标存储挂载路径列表 */
export interface StrmPathEntry {
  key: string
  dst: string
}

/** 解析后的路径：匹配到的 key + 剩余子路径 */
export interface StrmResolved {
  key: string
  sub: string
}
