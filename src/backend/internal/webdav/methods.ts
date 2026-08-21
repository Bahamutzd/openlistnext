// WebDAV 协议方法核心实现：路径映射、PROPFIND、下载、写入操作。
// 所有函数接收 Hono Context，便于读写请求体与请求头。

import { Context } from "hono"
import { resolvePath } from "../model/db"
import {
  listItems,
  getItem,
  makeDirectory,
  renameItem,
  removeItems,
  moveItems,
  copyItems,
  putItem,
} from "../op/storage"
import { getDriver } from "../op/storage"
import { DavUser, canDavRead, canDavWrite } from "./auth"
import { DavProp, buildMultistatus } from "./xml"

/** 将 WebDAV 请求路径（含 base_path 前缀）转换为虚拟路径 */
export function toVirtualPath(reqPath: string, user: DavUser): string {
  const base =
    "/" + (user.base_path || "/").split("/").filter(Boolean).join("/")
  let clean = "/" + reqPath.split("/").filter(Boolean).join("/")
  if (clean === "/") {
    return base === "/" ? "/" : base
  }
  const rel = clean.slice(1)
  return base === "/" ? clean : `${base}/${rel}`
}

/** PROPFIND：Depth 0 → 条目自身；Depth 1 → 条目 + 直接子项 */
export async function handlePropfind(
  c: Context,
  reqPath: string,
  user: DavUser,
  depth: string | null,
  body: string | null,
): Promise<Response> {
  if (!canDavRead(user)) return davError(403)
  const virtualPath = toVirtualPath(reqPath, user)

  // Depth: 0 或 1（infinity 暂按 1 处理，避免全盘递归）
  const wantChildren = depth !== "0"

  try {
    const resolved = await resolvePath(virtualPath)
    // 深度 0 → 只返回当前条目；深度 1 → 当前条目 + 子项
    const self: DavProp = {
      name: "",
      size: 0,
      is_dir: true,
      modified: new Date().toISOString(),
      created: new Date().toISOString(),
    }

    if (wantChildren) {
      const { content } = await listItems(virtualPath)
      const props: DavProp[] = content.map((item) => ({
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        modified: item.modified,
        created: (item as any).created || item.modified,
      }))

      // 与原有链路保持一致：href 以 /dav 前缀拼装
      const baseHref = "/dav" + (reqPath === "/" ? "" : reqPath)
      return new Response(buildMultistatus(baseHref, props), {
        status: 207,
        headers: {
          "Content-Type": 'application/xml; charset="utf-8"',
          DAV: "1, 2",
        },
      })
    }

    // Depth 0：查询单条条目（文件或目录）
    const { item } = await getItem(virtualPath)
    const baseHref = "/dav" + (reqPath === "/" ? "" : reqPath)
    const props: DavProp[] = [
      {
        name: "",
        size: item.size,
        is_dir: item.is_dir,
        modified: item.modified,
        created: (item as any).created || item.modified,
      },
    ]
    return new Response(buildMultistatus(baseHref, props), {
      status: 207,
      headers: {
        "Content-Type": 'application/xml; charset="utf-8"',
        DAV: "1, 2",
      },
    })
  } catch (e: any) {
    return davError(404)
  }
}

/** GET/HEAD：按 webdav_policy 返回 302 直链 / 代理 / 流式响应 */
export async function handleGet(
  c: Context,
  reqPath: string,
  user: DavUser,
  head: boolean,
): Promise<Response> {
  if (!canDavRead(user)) return davError(403)
  const virtualPath = toVirtualPath(reqPath, user)

  try {
    const { item, rawUrl } = await getItem(virtualPath)
    if (item.is_dir) return davError(404)

    const resolved = await resolvePath(virtualPath)
    const storage = resolved.storage
    const policy = (storage as any)?.webdav_policy || "302_redirect"

    // 下载策略：
    //  - 302_redirect：优先直链（raw_url 存在且为绝对 URL 时才 302）
    //  - use_proxy_url：302 到本站 /api/p 代理
    //  - native_proxy（默认）：直接流式透传 /api/p 响应（支持 Range）
    // 仅当策略为 302_redirect 时尝试直链，其余一律走代理，保证鉴权与 Range。
    if (policy === "302_redirect" && rawUrl) {
      const urlStr = String(rawUrl)
      if (/^https?:\/\//i.test(urlStr)) {
        return Response.redirect(urlStr, 302)
      }
      console.warn("[dav] rawUrl not absolute, falling back to proxy:", urlStr)
    }
    if (policy === "use_proxy_url") {
      // 302 到代理 URL
      const host = c.req.header("host") || ""
      const protocol = c.req.header("x-forwarded-proto") || "http"
      const proxyPath =
        "/api/p" + (virtualPath.startsWith("/") ? "" : "/") + virtualPath
      return Response.redirect(`${protocol}://${host}${proxyPath}`, 302)
    }

    // 本地文件或其它无直链驱动 → 走 raw 路由的代理下载（支持 Range / HEAD）
    const proxyPath =
      "/api/p" + (virtualPath.startsWith("/") ? "" : "/") + virtualPath
    const host = c.req.header("host") || ""
    const protocol = c.req.header("x-forwarded-proto") || "http"
    const upstream = await fetch(`${protocol}://${host}${proxyPath}`, {
      method: head ? "HEAD" : "GET",
      headers: c.req.header("Range") ? { Range: c.req.header("Range")! } : {},
    })
    // 兼容 raw 路由返回的 Buffer JSON（部分驱动/缓存会序列化 Buffer）
    // 不依赖 Content-Type，直接按内容特征检测 {"type":"Buffer","data":[...]}
    if (!head && upstream.ok) {
      const ct = upstream.headers.get("content-type") || ""
      if (ct.includes("json") || ct.includes("text")) {
        const text = await upstream.text()
        const trimmed = text.trimStart()
        if (trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(text)
            if (
              parsed &&
              parsed.type === "Buffer" &&
              Array.isArray(parsed.data)
            ) {
              console.warn(
                `[dav] unpacked Buffer JSON for '${virtualPath}' (${parsed.data.length} bytes)`,
              )
              return new Response(new Uint8Array(parsed.data), {
                status: 200,
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Content-Length": String(parsed.data.length),
                  "Accept-Ranges": "bytes",
                },
              })
            }
          } catch {}
        }
      }
    }
    // 注意：若上面解包后直接 return，则不会走到下方透传逻辑
    // 透传响应头，确保客户端能识别字节范围与内容类型
    const respHeaders = new Headers(upstream.headers)
    respHeaders.set(
      "Content-Type",
      upstream.headers.get("content-type") || "application/octet-stream",
    )
    if (upstream.headers.get("content-length")) {
      respHeaders.set("Content-Length", upstream.headers.get("content-length")!)
    }
    respHeaders.set(
      "Accept-Ranges",
      upstream.headers.get("accept-ranges") || "bytes",
    )
    if (upstream.headers.get("content-range")) {
      respHeaders.set("Content-Range", upstream.headers.get("content-range")!)
    }
    if (head) {
      // HEAD：只透传头部，不返回 body
      return new Response(null, {
        status: upstream.status,
        headers: respHeaders,
      })
    }
    if (upstream.bodyUsed) {
      // body 已被上方探测消费（非 Buffer JSON 的文本）→ 重新 fetch 流式透传
      const retry = await fetch(`${protocol}://${host}${proxyPath}`, {
        method: "GET",
        headers: c.req.header("Range") ? { Range: c.req.header("Range")! } : {},
      })
      return new Response(retry.body, {
        status: retry.status,
        headers: respHeaders,
      })
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    })
  } catch (e: any) {
    console.error("[dav] GET failed:", e.message, e.stack)
    return davError(404, e.message || "Not found")
  }
}

/** PUT：写入文件（覆盖已有文件时先删后写） */
export async function handlePut(
  c: Context,
  reqPath: string,
  user: DavUser,
): Promise<Response> {
  if (!canDavWrite(user)) return davError(403)
  const virtualPath = toVirtualPath(reqPath, user)

  try {
    const buf = await c.req.arrayBuffer()
    const bytes = buf.byteLength
    const max = 100 * 1024 * 1024
    if (bytes > max) {
      return davError(413, "File too large; use the web upload instead")
    }
    // 覆盖已有文件：驱动层 put 可能不支持覆盖（如 OneDrive 409），先删再写
    try {
      await getItem(virtualPath)
      // 已存在 → 先删除
      const dir = virtualPath.split("/").slice(0, -1).join("/") || "/"
      const name = virtualPath.split("/").filter(Boolean).pop() || ""
      await removeItems(dir, [name])
    } catch {
      // 不存在 → 直接写入
    }
    await putItem(virtualPath, Buffer.from(buf))
    return new Response(null, { status: 201 })
  } catch (e: any) {
    if (e.message?.includes("storage not found")) return davError(409)
    return davError(500, e.message)
  }
}

/** MKCOL：创建目录 */
export async function handleMkcol(
  c: Context,
  reqPath: string,
  user: DavUser,
): Promise<Response> {
  if (!canDavWrite(user)) return davError(403)
  const virtualPath = toVirtualPath(reqPath, user)
  try {
    await makeDirectory(virtualPath)
    return new Response(null, { status: 201 })
  } catch (e: any) {
    return davError(405)
  }
}

/** DELETE：删除文件或目录 */
export async function handleDelete(
  c: Context,
  reqPath: string,
  user: DavUser,
): Promise<Response> {
  if (!canDavWrite(user)) return davError(403)
  const virtualPath = toVirtualPath(reqPath, user)
  try {
    // removeItems(dir, names) 内部会拼 dir/name，这里传 dir + [最后一段]
    const dir = virtualPath.split("/").slice(0, -1).join("/") || "/"
    const name = virtualPath.split("/").filter(Boolean).pop() || ""
    await removeItems(dir, [name])
    return new Response(null, { status: 204 })
  } catch (e: any) {
    console.error("[dav] DELETE failed:", e.message)
    return davError(404, e.message || "Not found")
  }
}

/** MOVE：改名（同目录）或移动（跨目录） */
export async function handleMove(
  c: Context,
  reqPath: string,
  user: DavUser,
  destination: string | null,
): Promise<Response> {
  if (!canDavWrite(user)) return davError(403)
  if (!destination) return davError(400)
  const virtualPath = toVirtualPath(reqPath, user)
  try {
    // Destination 是完整 URL（或绝对路径），需先剥掉 /dav 前缀再转虚拟路径
    const destPath = toVirtualPath(
      stripDavPrefix(stripDestination(destination)),
      user,
    )
    const name = virtualPath.split("/").filter(Boolean).pop() || ""

    if (destPath === virtualPath) return davError(403) // 原地移动无意义

    const srcDir = virtualPath.split("/").slice(0, -1).join("/") || "/"
    const dstDir = destPath.split("/").slice(0, -1).join("/") || "/"

    if (srcDir === dstDir) {
      const newName = destPath.split("/").filter(Boolean).pop() || name
      await renameItem(virtualPath, newName)
    } else {
      await moveItems(srcDir, dstDir, [name])
    }
    return new Response(null, { status: 201 })
  } catch (e: any) {
    console.error("[dav] MOVE failed:", e.message)
    return davError(404, e.message || "Not found")
  }
}

/** COPY：复制文件或目录 */
export async function handleCopy(
  c: Context,
  reqPath: string,
  user: DavUser,
  destination: string | null,
): Promise<Response> {
  if (!canDavWrite(user)) return davError(403)
  if (!destination) return davError(400)
  const virtualPath = toVirtualPath(reqPath, user)
  try {
    const destPath = toVirtualPath(
      stripDavPrefix(stripDestination(destination)),
      user,
    )
    const name = virtualPath.split("/").filter(Boolean).pop() || ""
    const srcDir = virtualPath.split("/").slice(0, -1).join("/") || "/"
    const dstDir = destPath.split("/").slice(0, -1).join("/") || "/"

    // 同存储内复制：先读源文件内容，再写入目标（驱动不保证支持 server-side copy）
    const { item } = await getItem(virtualPath)
    if (item.is_dir) return davError(403, "Directory copy not supported yet")

    // 通过 raw 代理流式读取源文件
    const proxyPath =
      "/api/p" + (virtualPath.startsWith("/") ? "" : "/") + virtualPath
    const host = c.req.header("host") || ""
    const protocol = c.req.header("x-forwarded-proto") || "http"
    const upstream = await fetch(`${protocol}://${host}${proxyPath}`)
    if (!upstream.ok) return davError(404, "Source not readable")

    const text = await upstream.text()
    const trimmed = text.trimStart()
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(text)
        if (parsed && parsed.type === "Buffer" && Array.isArray(parsed.data)) {
          // 上游是 Buffer JSON → 直接写入原始字节
          await putItem(destPath, Buffer.from(parsed.data))
          return new Response(null, { status: 201 })
        }
      } catch {}
    }
    // 普通内容 → 直接写入原始文本字节
    await putItem(destPath, Buffer.from(text, "utf8"))
    return new Response(null, { status: 201 })
  } catch (e: any) {
    console.error("[dav] COPY failed:", e.message)
    return davError(404, e.message || "Not found")
  }
}

/** 从 Destination 头剥离主机与协议前缀 */
function stripDestination(dest: string): string {
  try {
    const u = new URL(dest)
    return u.pathname
  } catch {
    return dest
  }
}

/** 剥掉 /dav 前缀（Destination 通常是完整站点路径） */
function stripDavPrefix(path: string): string {
  return path.replace(/^\/dav(?:\/|$)/, "/")
}

/** 统一错误响应 */
export function davError(status: number, message?: string): Response {
  return new Response(message || "", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
