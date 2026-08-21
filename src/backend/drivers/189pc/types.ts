// 189CloudPC 配置与协议类型（对齐原版 OpenList drivers/189pc）

export interface Cloud189PcAddition {
  login_type?: string
  username?: string
  password?: string
  validate_code?: string
  access_token?: string
  refresh_token?: string
  cookie?: string
  root_folder_id?: string
  order_by?: string
  order_direction?: string
  type?: string
  family_id?: string
  upload_method?: string
  upload_thread?: string
  family_transfer?: boolean
  rapid_upload?: boolean
  no_use_ocr?: boolean
}

export interface Cloud189PcSession {
  loginName?: string
  sessionKey: string
  sessionSecret: string
  familySessionKey?: string
  familySessionSecret?: string
  accessToken?: string
  refreshToken?: string
}

export interface Cloud189PcFile {
  id: string
  name: string
  size: number
  lastOpTime?: string
  createDate?: string
  md5?: string
  parentId?: string
  icon?: { smallUrl?: string; largeUrl?: string }
}

export interface Cloud189PcFolder {
  id: string
  name: string
  lastOpTime?: string
  createDate?: string
  parentId?: string
}

export interface Cloud189PcTokenUpdate {
  access_token?: string
  refresh_token?: string
}
