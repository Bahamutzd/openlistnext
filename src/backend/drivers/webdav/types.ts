// WebDAV 存储驱动配置类型
// 字段对齐原版 OpenList 的 WebDav 驱动（drivers.json 中已有对应翻译）。

export interface WebDavAddition {
  /** 远端 WebDAV 服务地址，如 https://example.com/dav */
  address?: string
  /** Basic 认证用户名 */
  username?: string
  /** Basic 认证密码 */
  password?: string
  /** 远端根目录，默认 / */
  root_folder_path?: string
  /** 供应商：other | sharepoint（SharePoint 需要额外处理 Cookie） */
  vendor?: "other" | "sharepoint"
  /** 是否跳过 TLS 证书校验（仅 Node 容器生效，Workers 上无效） */
  tls_insecure_skip_verify?: boolean
}
