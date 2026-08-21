// WebDAV Basic Auth + 权限校验
// 对齐原版 OpenList：HTTP Basic 认证，用户权限位控制读写，
// base_path 作为 WebDAV 根目录（客户端看到的 / 即用户的 base_path）。

import { getDb } from "../model/db"
import { hashPassword } from "../../server/auth"
import { isAdmin, PermissionBit } from "../../pkg/permission"

export interface DavUser {
  id: number
  username: string
  base_path: string
  role: number
  permission: number
  disabled: boolean
}

/** 解析 Authorization: Basic base64(user:pass) */
export function parseBasicAuth(
  header: string | undefined,
): { username: string; password: string } | null {
  if (!header) return null
  const m = /^Basic\s+(.+)$/i.exec(header.trim())
  if (!m) return null
  try {
    // 统一走 Base64 解码：优先 Uint8Array（兼容非 ASCII 用户名），失败再回退 atob
    let decoded: string
    if (typeof atob === "function") {
      decoded = atob(m[1])
    } else {
      const bin = Buffer.from(m[1], "base64")
      decoded = bin.toString("utf8")
    }
    const idx = decoded.indexOf(":")
    if (idx < 0) return null
    return {
      username: decoded.slice(0, idx),
      password: decoded.slice(idx + 1),
    }
  } catch {
    return null
  }
}

/** 校验用户：密码（兼容明文 / SHA-256 盐哈希）、禁用、base_path */
export async function verifyDavUser(
  username: string,
  password: string,
): Promise<DavUser | null> {
  const db = await getDb()
  const user = (db.users || []).find(
    (u: any) => u.username === username && !u.disabled,
  )
  if (!user) return null

  const hashed = await hashPassword(password)
  const userPass = user.password || ""
  // 兼容三种情况：标准哈希 / 明文存储（旧数据）/ 空密码字段按默认密码 admin 处理
  const valid =
    userPass === hashed ||
    userPass === password ||
    (userPass === "" && password === "admin")

  if (!valid) return null

  return {
    id: user.id,
    username: user.username,
    base_path: user.base_path || "/",
    role: user.role,
    permission: user.permission,
    disabled: !!user.disabled,
  }
}

/** WebDAV 读权限（PROPFIND / GET / HEAD） */
export function canDavRead(user: DavUser | null): boolean {
  if (!user) return false
  if (isAdmin(user)) return true
  return ((user.permission >> PermissionBit.WEBDAV_READ) & 1) === 1
}

/** WebDAV 写权限（PUT / MKCOL / DELETE / MOVE / COPY） */
export function canDavWrite(user: DavUser | null): boolean {
  if (!user) return false
  if (isAdmin(user)) return true
  return ((user.permission >> PermissionBit.WEBDAV_MANAGE) & 1) === 1
}
