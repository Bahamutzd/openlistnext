// SFTP 驱动配置类型

export interface SftpAddition {
  /** SFTP 服务器地址 */
  host?: string
  /** SSH 端口，默认 22 */
  port?: number
  /** 用户名 */
  username?: string
  /** 密码 */
  password?: string
  /** 私钥内容（可选，优先于密码） */
  private_key?: string
  /** 私钥密码（可选） */
  private_key_passphrase?: string
  /** 根目录，默认 / */
  root_folder_path?: string
  /** 是否跳过主机密钥校验 */
  ignore_hostkey?: boolean
}
