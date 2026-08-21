// FTP 驱动配置类型

export interface FtpAddition {
  /** FTP 服务器地址 */
  host?: string
  /** FTP 端口，默认 21 */
  port?: number
  /** 用户名，默认 anonymous */
  username?: string
  /** 密码，默认 guest */
  password?: string
  /** 根目录，默认 / */
  root_folder_path?: string
  /** 是否使用 FTPS（TLS），默认 false */
  tls?: boolean
  /** 是否跳过 TLS 证书校验 */
  tls_insecure_skip_verify?: boolean
}
