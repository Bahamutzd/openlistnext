// Strm 驱动（对齐原版 OpenList drivers/strm 语义）
// paths 每行定义「虚拟根名 → 目标存储挂载路径」的映射；浏览/下载时
// 转发到目标存储驱动（listItems / getItem），媒体文件改名为 .strm 暴露，
// 其内容为指向本站 /api/p 代理的链接文本。纯 Web 标准实现，Serverless 可用。

import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { StrmAddition, StrmPathEntry, StrmResolved } from "./types"

// 动态引入 op/storage，避免 storage.ts → strm/driver.ts → storage.ts 循环依赖
async function opStorage(): Promise<
  typeof import("../../internal/op/storage")
> {
  return import("../../internal/op/storage")
}

function cleanPath(p: string): string {
  return (
    "/" +
    String(p || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  )
}

/** 与原版 util.go getPair 一致的解析：
 *  - 含 ":" 且 key 不含 "/" → (key, value)
 *  - 否则 → (最后一段, 完整路径) */
function getPair(line: string): { key: string; value: string } | null {
  const t = line.trim()
  if (!t) return null
  if (t.includes(":")) {
    const pair = t.split(":")
    const k = pair[0].trim()
    const v = pair.slice(1).join(":").trim()
    if (k && !k.includes("/")) return { key: k, value: v }
  }
  const segs = t.split("/").filter(Boolean)
  if (segs.length === 0) return null
  const key = segs[segs.length - 1]
  return { key, value: cleanPath(t) }
}

export class StrmDriver implements StorageDriver {
  private addition: StrmAddition
  private pathMap: StrmPathEntry[] = []
  /** 只有一个映射时自动铺平（autoFlatten） */
  private autoFlatten = false
  private oneKey = ""
  private supportSuffix = new Set<string>()
  private downloadSuffix = new Set<string>()
  private minSizeBytes = 0

  constructor(addition: StrmAddition) {
    this.addition = normalizeStrmAddition(addition)
  }

  async init(): Promise<void> {
    const a = this.addition
    if (!a.paths) {
      throw new Error("paths is required")
    }
    this.pathMap = []
    for (const line of a.paths.split("\n")) {
      const pair = getPair(line)
      if (!pair) continue
      this.pathMap.push({ key: pair.key, dst: pair.value })
    }
    if (this.pathMap.length === 0) {
      throw new Error(
        "strm paths must contain at least one mapping (e.g. 'movies:/mnt/media')",
      )
    }
    this.autoFlatten = this.pathMap.length === 1
    if (this.autoFlatten) this.oneKey = this.pathMap[0].key

    // supportSuffix（默认媒体后缀，缺失时补全原版默认列表）
    const supportTypes = (a.filterFileTypes || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const DEFAULT_SUPPORT =
      "mp4,mkv,flv,avi,wmv,ts,rmvb,webm,mp3,flac,aac,wav,ogg,m4a,wma,alac"
    for (const ext of DEFAULT_SUPPORT.split(",")) {
      this.supportSuffix.add(ext)
    }
    for (const ext of supportTypes) this.supportSuffix.add(ext)

    // downloadSuffix（字幕/小文件默认原样暴露）
    const downloadTypes = (a.downloadFileTypes || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const DEFAULT_DOWNLOAD = "ass,srt,vtt,sub,strm"
    for (const ext of DEFAULT_DOWNLOAD.split(",")) {
      this.downloadSuffix.add(ext)
    }
    for (const ext of downloadTypes) this.downloadSuffix.add(ext)

    this.minSizeBytes = (a.minFileSize || 0) * 1024 * 1024
  }

  /** 解析虚拟路径 → (key, sub)；autoFlatten 时所有路径都落到唯一 key */
  private getRootAndPath(path: string): StrmResolved {
    if (this.autoFlatten) return { key: this.oneKey, sub: path }
    const clean = cleanPath(path).replace(/^\//, "")
    const parts = clean.split("/")
    const key = parts[0] || ""
    const sub = parts.length > 1 ? parts.slice(1).join("/") : ""
    return { key, sub }
  }

  /** 生成 strm 文件内容：本站 /api/p + 编码路径（对齐原版 getLink） */
  private buildStrmContent(apiBase: string, targetPath: string): string {
    const a = this.addition
    let finalPath = a.encodePath !== false ? encodeURI(targetPath) : targetPath
    if (!finalPath.startsWith("/")) finalPath = "/" + finalPath

    const pathPrefix = a.pathPrefix || "/d"
    finalPath = `${pathPrefix.replace(/\/$/, "")}${finalPath}`

    if (a.withSign) {
      // 本项目未实现全局 sign（sign_all 默认关），原版会附加 ?sign=；这里省略
      // 保持向后兼容：withSign 开启时附加空 sign 查询参数占位
      finalPath += "?sign="
    }

    if (a.withoutUrl) return finalPath

    const apiUrl = (a.siteUrl || apiBase).replace(/\/$/, "")
    return `${apiUrl}${finalPath}`
  }

  /** 把目标存储的条目转换为 strm 可见条目（对齐原版 convert2strmObjs） */
  private async convert2strmObjs(
    reqPath: string,
    objs: FileItem[],
  ): Promise<FileItem[]> {
    const a = this.addition
    const apiBase = (a.siteUrl || "").replace(/\/$/, "")
    const result: FileItem[] = []
    for (const obj of objs) {
      if (obj.is_dir) {
        result.push(obj)
        continue
      }
      const name = obj.name
      const dotIdx = name.lastIndexOf(".")
      const sourceExt = dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : ""
      const fullPath = `${reqPath === "/" ? "" : reqPath}/${name}`
      if (this.downloadSuffix.has(sourceExt)) {
        // 字幕等小文件：原样暴露，供播放器/下载直接跟随
        result.push({ ...obj, name })
        continue
      }
      if (this.supportSuffix.has(sourceExt)) {
        if (this.minSizeBytes > 0 && (obj.size || 0) < this.minSizeBytes) {
          continue // 太小，过滤
        }
        // 改名 .strm，内容 = 本站代理链接
        const strmName =
          dotIdx >= 0 ? name.slice(0, dotIdx) + ".strm" : name + ".strm"
        const content = this.buildStrmContent(apiBase, fullPath)
        result.push({
          ...obj,
          name: strmName,
          size: content.length,
          sign: "strm",
          raw_url: "", // 不直接用目标 raw_url；内容由 /api/p 生成
        })
        continue
      }
      // 其他后缀直接过滤（不显示）
    }
    return result
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    // 根路径且非 autoFlatten → 列虚拟根（每个 key 一个目录）
    const isRoot = physicalPath === "/" || physicalPath === ""
    if (isRoot && !this.autoFlatten) {
      return this.pathMap.map((p) => ({
        name: p.key,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
      }))
    }

    const { key, sub } = this.getRootAndPath(physicalPath)
    const entries = this.pathMap.filter((p) => p.key === key)
    if (entries.length === 0) {
      throw new Error("strm path not found")
    }

    const all: FileItem[] = []
    const { listItems } = await opStorage()
    for (const entry of entries) {
      const reqPath = cleanPath(entry.dst) + (sub ? `/${sub}` : "")
      try {
        const { content } = await listItems(reqPath)
        const converted = await this.convert2strmObjs(
          cleanPath(entry.dst),
          content,
        )
        all.push(...converted)
      } catch {
        // 目标存储不可用/不存在 → 跳过该映射
      }
    }
    return all
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const { key, sub } = this.getRootAndPath(physicalPath)
    const entries = this.pathMap.filter((p) => p.key === key)
    if (entries.length === 0) {
      throw new Error("strm file not found")
    }

    // 尝试从目标存储取真实对象（对齐原版 Get：fs.Get 各目标，第一个成功返回）
    const { getItem } = await opStorage()
    for (const entry of entries) {
      // .strm 是虚拟名：目标存储里实际是原名（如 阿凡达.mkv → 阿凡达.strm）。
      // 候选：.strm 名本身、去掉 .strm 的 stem（xxx.mkv 或 xxx）、stem 原样。
      const candidates: string[] = []
      if (sub.endsWith(".strm")) {
        const stem = sub.slice(0, -".strm".length)
        candidates.push(sub, stem)
      } else {
        candidates.push(sub)
      }
      for (const cand of candidates) {
        const reqPath = cleanPath(entry.dst) + (cand ? `/${cand}` : "")
        try {
          const { item } = await getItem(reqPath)
          if (item.is_dir) {
            // 目录：返回目录条目（保持 is_dir）
            return {
              name: item.name,
              size: 0,
              is_dir: true,
              modified: item.modified || new Date().toISOString(),
              sign: "",
              type: 1,
              raw_url: "",
            }
          }
          // 真实文件：返回条目（raw_url 交给 raw.ts 走目标驱动）
          return item
        } catch {
          // 继续下一个候选
        }
      }
    }

    // 目标存储都没有 → 若请求的是 .strm 本身，返回一个空条目
    if (sub.endsWith(".strm")) {
      const name = sub.split("/").filter(Boolean).pop() || "file.strm"
      return {
        name,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "strm",
        type: 0,
        raw_url: "",
      }
    }
    throw new Error("strm file not found")
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

function normalizeStrmAddition(a: any): StrmAddition {
  const norm = { ...(a || {}) } as any
  norm.paths = norm.paths || ""
  norm.siteUrl = norm.siteUrl || ""
  norm.pathPrefix = norm.pathPrefix || "/d"
  norm.downloadFileTypes = norm.downloadFileTypes || ""
  norm.filterFileTypes = norm.filterFileTypes || ""
  norm.minFileSize = parseInt(norm.minFileSize, 10) || 0
  norm.encodePath = norm.encodePath !== false
  norm.withoutUrl = !!norm.withoutUrl
  norm.withSign = !!norm.withSign
  norm.saveStrmToLocal = !!norm.saveStrmToLocal
  norm.saveStrmLocalPath = norm.saveStrmLocalPath || ""
  norm.saveLocalMode = norm.saveLocalMode || "insert"
  norm.version = parseInt(norm.version, 10) || 5
  return norm as StrmAddition
}
