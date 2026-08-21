// WebDAV 客户端工具：PROPFIND 解析、路径拼接、Basic 认证头。

import { FileItem, calcFileType } from "../../internal/driver/base"

/** Basic 认证头值 */
export function basicAuthHeader(username: string, password: string): string {
  const raw = `${username || ""}:${password || ""}`
  return "Basic " + btoa(unescape(encodeURIComponent(raw)))
}

/** 规范化远端根路径：以 / 开头、不以 / 结尾（根为 ""） */
export function normalizeRoot(root: string | undefined): string {
  let r = (root || "/").replace(/\\/g, "/")
  if (!r.startsWith("/")) r = "/" + r
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1)
  return r
}

/** 将存储相对路径拼到远端根路径上，返回远端绝对路径 */
export function remotePath(
  rootFolder: string,
  relPath: string | undefined,
): string {
  const root = normalizeRoot(rootFolder)
  const rel = (relPath || "/")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/")
  if (!rel) return root || "/"
  return root === "/" || root === "" ? `/${rel}` : `${root}/${rel}`
}

/** 从响应 href 提取文件/目录名（解码 URL 编码） */
export function nameFromHref(href: string): string {
  const clean = href.split("?")[0]
  const segs = clean.split("/").filter(Boolean)
  let name = segs.length ? decodeURIComponent(segs[segs.length - 1]) : ""
  if (!name && clean.endsWith("/")) {
    name = segs.length > 1 ? decodeURIComponent(segs[segs.length - 2]) : ""
  }
  return name || "root"
}

/**
 * 解析 PROPFIND Depth:1 响应。
 * 返回 [{ name, size, is_dir, modified }]，跳过自身（根）条目。
 */
export function parsePropfindResponse(xml: string): Array<{
  name: string
  size: number
  is_dir: boolean
  modified: string
}> {
  const items: Array<{
    name: string
    size: number
    is_dir: boolean
    modified: string
  }> = []

  // 按 <d:response> 块切分（兼容多前缀）
  const responseRe = /<(?:\w+:)?response[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/g
  let m: RegExpExecArray | null
  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[1]

    const hrefMatch = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/.exec(
      block,
    )
    if (!hrefMatch) continue
    const href = hrefMatch[1].trim()

    // 目录：resourcetype 含 collection
    const isDir =
      /<(?:\w+:)?resourcetype[^>]*>[\s\S]*?<\/(?:\w+:)?collection\s*\/?>/.test(
        block,
      ) || /<(?:\w+:)?collection\s*\/?>/.test(block)

    // 大小
    let size = 0
    const sizeMatch =
      /<(?:\w+:)?getcontentlength[^>]*>([^<]*)<\/(?:\w+:)?getcontentlength>/.exec(
        block,
      )
    if (sizeMatch) size = parseInt(sizeMatch[1].trim(), 10) || 0

    // 修改时间（RFC 1123 或 ISO）
    let modified = new Date().toISOString()
    const modMatch =
      /<(?:\w+:)?getlastmodified[^>]*>([^<]*)<\/(?:\w+:)?getlastmodified>/.exec(
        block,
      )
    if (modMatch) {
      const d = new Date(modMatch[1].trim())
      if (!isNaN(d.getTime())) modified = d.toISOString()
    }

    items.push({
      name: nameFromHref(href),
      size: isDir ? 0 : size,
      is_dir: isDir,
      modified,
    })
  }

  // 过滤掉"自身"条目（href 以根路径结尾且名称与根一致）
  return items
}

/** 将 PROPFIND 条目转换为 FileItem */
export function propToFileItem(p: {
  name: string
  size: number
  is_dir: boolean
  modified: string
}): FileItem {
  return {
    name: p.name,
    size: p.size,
    is_dir: p.is_dir,
    modified: p.modified,
    sign: "",
    type: calcFileType(p.name, p.is_dir),
    thumb: "",
    raw_url: "",
  }
}
