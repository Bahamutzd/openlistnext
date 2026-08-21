// Strm 驱动：把 .strm 文件映射为可播放/可下载的媒体文件。
// 配置 paths（每行 "源路径=目标路径"），strm 文件内容即媒体 URL。
// 纯 Web 标准实现，Serverless 可用。

import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { StrmAddition } from "./types"

function cleanPath(p: string): string {
  return (
    "/" +
    String(p || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  )
}

function normalizeStrmAddition(a: any): StrmAddition {
  const norm = { ...(a || {}) } as any
  norm.paths = norm.paths || ""
  norm.siteUrl = norm.siteUrl || ""
  norm.filterFileTypes = norm.filterFileTypes || "strm"
  norm.downloadFileTypes = norm.downloadFileTypes || "ass"
  norm.encodePath = norm.encodePath !== false
  norm.withoutUrl = !!norm.withoutUrl
  return norm as StrmAddition
}

export class StrmDriver implements StorageDriver {
  private addition: StrmAddition
  /** 路径映射：源路径（key）→ 目标路径列表（value） */
  private pathMap = new Map<string, string[]>()

  constructor(addition: StrmAddition) {
    this.addition = normalizeStrmAddition(addition)
  }

  async init(): Promise<void> {
    if (!this.addition.paths) {
      throw new Error("strm paths is required")
    }
    this.pathMap = new Map()
    for (const line of this.addition.paths.split("\n")) {
      const t = line.trim()
      if (!t) continue
      const idx = t.indexOf("=")
      if (idx < 0) continue
      const k = cleanPath(t.slice(0, idx).trim())
      const v = cleanPath(t.slice(idx + 1).trim())
      if (!k || !v) continue
      const list = this.pathMap.get(k) || []
      list.push(v)
      this.pathMap.set(k, list)
    }
    if (this.pathMap.size === 0) {
      throw new Error("strm paths must contain at least one 'src=dst' mapping")
    }
  }

  /** 根据虚拟路径解析源路径和目标子路径 */
  private resolve(virtualPath: string): {
    srcPath: string
    dsts: string[]
    sub: string
  } | null {
    const clean = cleanPath(virtualPath)
    // 最长匹配源路径
    let bestSrc = ""
    let bestDsts: string[] = []
    for (const [src, dsts] of this.pathMap) {
      if (src !== "/" && (clean === src || clean.startsWith(src + "/"))) {
        if (src.length > bestSrc.length) {
          bestSrc = src
          bestDsts = dsts
        }
      }
    }
    if (!bestSrc) {
      // 根路径：如果只有一个映射且源为 /，则用根
      if (clean === "/" && this.pathMap.has("/")) {
        return { srcPath: "/", dsts: this.pathMap.get("/")!, sub: "" }
      }
      return null
    }
    const sub = clean.slice(bestSrc.length).replace(/^\//, "")
    return { srcPath: bestSrc, dsts: bestDsts, sub }
  }

  /** 拼接 strm 完整 URL */
  private strmUrl(content: string): string {
    let c = content.trim()
    if (!c) return ""
    if (this.addition.withoutUrl) {
      return (this.addition.siteUrl || "") + c
    }
    if (/^https?:\/\//i.test(c)) return c
    if (this.addition.siteUrl) {
      return (
        this.addition.siteUrl.replace(/\/$/, "") + "/" + c.replace(/^\//, "")
      )
    }
    return c
  }

  async list(virtualPath: string, _physicalPath: string): Promise<FileItem[]> {
    const r = this.resolve(virtualPath)
    if (!r) throw new Error("strm path not found")
    const filterExts = (this.addition.filterFileTypes || "strm")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)

    const items: FileItem[] = []
    for (const dst of r.dsts) {
      // 目标路径就是 strm 文件所在目录；直接构造 .strm 文件条目
      const subSegs = r.sub ? r.sub.split("/").filter(Boolean) : []
      // 对于子路径，先建目录层级
      if (subSegs.length > 0) {
        // 目录条目
        const dirItem: FileItem = {
          name: subSegs[subSegs.length - 1],
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          sign: "",
          type: 1,
          raw_url: "",
        }
        if (!items.some((i) => i.name === dirItem.name && i.is_dir)) {
          items.push(dirItem)
        }
        continue
      }
      // 根映射：列出目标路径下的 .strm 文件（按文件名模拟）
      // 简化：把目标路径本身当作一个可播放文件
      const name = dst.split("/").filter(Boolean).pop() || "media"
      const ext = name.split(".").pop()?.toLowerCase() || ""
      if (filterExts.length && !filterExts.includes(ext)) continue
      items.push({
        name,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: dst,
        type: calcFileType(name, false),
        raw_url: dst,
      })
    }
    return items
  }

  async get(virtualPath: string, _physicalPath: string): Promise<FileItem> {
    const r = this.resolve(virtualPath)
    if (!r) throw new Error("strm file not found")
    const name = virtualPath.split("/").filter(Boolean).pop() || "media"
    return {
      name,
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: "",
      type: calcFileType(name, false),
      raw_url: this.strmUrl(r.dsts[0] || ""),
    }
  }

  async mkdir(_v: string, _p: string): Promise<void> {
    throw new Error("strm Driver cannot make dir")
  }
  async rename(_v: string, _p: string, _n: string): Promise<void> {
    throw new Error("strm Driver cannot rename file")
  }
  async remove(_v: string, _p: string, _n: string[]): Promise<void> {
    throw new Error("strm Driver cannot remove file")
  }
  async move(
    _a: string,
    _b: string,
    _c: string[],
    _d: string,
    _e: string,
  ): Promise<void> {
    throw new Error("strm Driver cannot move file")
  }
  async copy(
    _a: string,
    _b: string,
    _c: string[],
    _d: string,
    _e: string,
  ): Promise<void> {
    throw new Error("strm Driver cannot copy file")
  }
  async put(_v: string, _p: string, _c: Buffer): Promise<void> {
    throw new Error("strm Driver cannot put file")
  }
}
