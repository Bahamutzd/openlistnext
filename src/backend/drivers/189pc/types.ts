// 189CloudPC 驱动配置类型（复用 189 驱动 + access_token）

export interface Cloud189PcAddition {
  /** 手机号 / 账号（access_token 缺失时用账号密码登录） */
  username?: string
  /** 密码 */
  password?: string
  /** access_token（accessToken 登录模式，优先于账号密码） */
  access_token?: string
  /** Cookie（可选） */
  cookie?: string
  /** 根文件夹 ID，默认 -11 */
  root_folder_id?: string
  /** 排序字段 */
  order_by?: string
  /** 排序方向 */
  order_direction?: string
}
