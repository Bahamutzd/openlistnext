// WebDAV PROPFIND 响应 XML 生成
// 对齐原版 OpenList 需要的属性集（Windows 资源管理器 / rclone 都能识别）。

export interface DavProp {
  name: string
  size: number
  is_dir: boolean
  modified?: string
  created?: string
  etag?: string
}

/** 解析 PROPFIND 请求体，返回是否请求了 allprop（默认按 allprop 处理） */
export function parsePropfindBody(body: string | null): { allprop: boolean } {
  if (!body) return { allprop: true }
  return { allprop: !/xmlns:[A-Za-z]+="DAV:"[\s\S]*<(?:D:)?prop>/.test(body) }
}

/** RFC 1123（getlastmodified） */
function toHttpDate(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date()
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString()
}

/** ISO 8601（creationdate） */
function toIsoDate(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date()
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

/** 文件名 → 简化 MIME（避免全部 octet-stream） */
function guessContentType(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase()
  const map: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    htm: "text/html",
    xml: "text/xml",
    json: "application/json",
    js: "text/javascript",
    css: "text/css",
    csv: "text/csv",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    wav: "audio/wav",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  }
  return map[ext] || "application/octet-stream"
}

/** 对 href / 名称做 XML 转义 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/**
 * 生成 multistatus 响应。
 * props: 当前请求路径的条目 + 子项（子项 href 会被自动拼接）。
 */
export function buildMultistatus(baseHref: string, props: DavProp[]): string {
  const lines: string[] = ['<?xml version="1.0" encoding="utf-8"?>']
  lines.push('<d:multistatus xmlns:d="DAV:">')

  for (const p of props) {
    const href = p.is_dir
      ? `${baseHref.replace(/\/$/, "")}/${encodeURIComponent(p.name)}/`
      : `${baseHref.replace(/\/$/, "")}/${encodeURIComponent(p.name)}`
    lines.push("  <d:response>")
    lines.push(`    <d:href>${escapeXml(href)}</d:href>`)
    lines.push("    <d:propstat>")
    lines.push("      <d:prop>")
    lines.push(
      p.is_dir
        ? "        <d:resourcetype><d:collection/></d:resourcetype>"
        : "        <d:resourcetype/>",
    )
    if (!p.is_dir) {
      lines.push(`        <d:getcontentlength>${p.size}</d:getcontentlength>`)
      lines.push(
        `        <d:getcontenttype>${guessContentType(p.name)}</d:getcontenttype>`,
      )
    }
    lines.push(
      `        <d:getlastmodified>${toHttpDate(p.modified)}</d:getlastmodified>`,
    )
    lines.push(
      `        <d:creationdate>${toIsoDate(p.created || p.modified)}</d:creationdate>`,
    )
    if (p.etag)
      lines.push(`        <d:getetag>${escapeXml(p.etag)}</d:getetag>`)
    lines.push("      </d:prop>")
    lines.push("      <d:status>HTTP/1.1 200 OK</d:status>")
    lines.push("    </d:propstat>")
    lines.push("  </d:response>")
  }

  lines.push("</d:multistatus>")
  return lines.join("\n")
}
