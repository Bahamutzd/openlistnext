// 189 Cloud Drive (天翼云盘) driver
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/189
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { md5 } from "../../pkg/crypto"
import { Cloud189Addition, FileItem189, FolderItem189 } from "./types"
import { Pan189Client } from "./util"

const SUBREQUEST_LIMIT = 45

function parse189Date(dateStr: string): string {
  if (!dateStr) return new Date().toISOString()
  try {
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) return d.toISOString()
  } catch {}
  return new Date().toISOString()
}

function pan189FolderToFileItem(folder: FolderItem189): FileItem {
  return {
    name: folder.name,
    size: 0,
    is_dir: true,
    modified: parse189Date(folder.lastOpTime),
    sign: String(folder.id),
    type: 1,
    thumb: "",
    raw_url: "",
  }
}

function pan189FileToFileItem(file: FileItem189): FileItem {
  return {
    name: file.name,
    size: file.size || 0,
    is_dir: false,
    modified: parse189Date(file.lastOpTime),
    sign: String(file.id),
    type: calcFileType(file.name, false),
    thumb: file.icon?.smallUrl || file.icon?.largeUrl || "",
    raw_url: "",
  }
}

export function normalizeCloud189Addition(a: any): Cloud189Addition {
  const norm = { ...(a || {}) } as any
  norm.username = norm.username || ""
  norm.password = norm.password || ""
  norm.cookie = (norm.cookie || "").trim()
  norm.root_folder_id = norm.root_folder_id || "-11"
  norm.order_by = norm.order_by || "lastOpTime"
  norm.order_direction = norm.order_direction || "desc"
  return norm as Cloud189Addition
}

export class Cloud189Driver implements StorageDriver {
  private client: Pan189Client
  private addition: Cloud189Addition
  /** cache: physical path -> folderId (string) */
  private pathIdCache = new Map<string, string>()
  /** CF Workers subrequest budget */
  private budget = { used: 0, limit: SUBREQUEST_LIMIT }

  constructor(
    addition: Cloud189Addition,
    onCookieUpdate?: (cookie: string) => void,
  ) {
    this.addition = normalizeCloud189Addition(addition)
    this.client = new Pan189Client(this.addition, onCookieUpdate)
  }

  async init(): Promise<void> {
    await this.client.login()
  }

  /**
   * 将 physicalPath 解析为对应的 folderId。
   * 逐级向下解析并缓存路径 ID 映射。
   */
  private async resolveFolderId(physicalPath: string): Promise<string> {
    const rootId = this.client.getRootId()
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")

    if (clean === "/" || clean === `/${rootId}`) {
      return rootId
    }

    const segs = clean.split("/").filter(Boolean)
    let cachedLen = 0
    let parentId = rootId
    let prefix = ""

    for (let i = 0; i < segs.length; i++) {
      const p = "/" + segs.slice(0, i + 1).join("/")
      const id = this.pathIdCache.get(p)
      if (id !== undefined) {
        parentId = id
        cachedLen = i + 1
        prefix = p
      } else {
        break
      }
    }

    for (let i = cachedLen; i < segs.length; i++) {
      const name = segs[i]
      const { folders } = await this.client.getFiles(parentId, {
        findName: name,
        findIsDir: true,
        budget: this.budget,
      })

      const folder = folders.find((f) => f.name === name)
      if (!folder) {
        throw new Error(`[189Cloud] 目录未找到: ${name}`)
      }

      parentId = String(folder.id)
      prefix = "/" + segs.slice(0, i + 1).join("/")
      this.pathIdCache.set(prefix, parentId)
    }

    return parentId
  }

  /**
   * 将 physicalPath 解析为对应的文件对象及其父目录 ID
   */
  private async resolveFile(physicalPath: string): Promise<{
    file: FileItem189 | FolderItem189
    parentId: string
    isDir: boolean
  }> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    if (segs.length === 0) throw new Error("[189Cloud] 路径无效")

    const name = segs[segs.length - 1]
    const parentPath = "/" + segs.slice(0, segs.length - 1).join("/")
    const parentId = await this.resolveFolderId(parentPath)

    const { files, folders } = await this.client.getFiles(parentId, {
      findName: name,
      budget: this.budget,
    })

    const file = files.find((f) => f.name === name || String(f.id) === name)
    if (file) {
      return { file, parentId, isDir: false }
    }

    const folder = folders.find((f) => f.name === name || String(f.id) === name)
    if (folder) {
      return { file: folder, parentId, isDir: true }
    }

    throw new Error(`[189Cloud] 文件或目录未找到: ${name}`)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.budget.used = 0
    const folderId = await this.resolveFolderId(physicalPath)
    const { files, folders } = await this.client.getFiles(folderId, {
      budget: this.budget,
    })

    const items: FileItem[] = [
      ...folders.map(pan189FolderToFileItem),
      ...files.map(pan189FileToFileItem),
    ]

    return sortFileItems(
      items,
      this.addition.order_by === "filename"
        ? "file_name"
        : this.addition.order_by === "fileSize"
          ? "size"
          : "updated_at",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    this.budget.used = 0
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)

    if (
      segs.length === 0 ||
      segs[segs.length - 1] === this.client.getRootId()
    ) {
      const rootId = this.client.getRootId()
      return {
        name: rootId,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: rootId,
        type: 1,
        raw_url: "",
      }
    }

    try {
      const { file, isDir } = await this.resolveFile(physicalPath)
      if (isDir) {
        return pan189FolderToFileItem(file as FolderItem189)
      }

      const item = pan189FileToFileItem(file as FileItem189)
      try {
        item.raw_url = await this.client.getDownloadUrl(String(file.id))
      } catch (e: any) {
        console.warn(`[189Cloud] 获取 ${file.name} 下载地址失败:`, e.message)
      }
      return item
    } catch (e) {
      // 容错：直接尝试作为 folderId 探测
      const lastSeg = segs[segs.length - 1]
      try {
        await this.client.getFiles(lastSeg)
        return {
          name: lastSeg,
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          sign: lastSeg,
          type: 1,
          raw_url: "",
        }
      } catch {
        throw e
      }
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    this.budget.used = 0
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const dirName = segs.pop() || "新文件夹"
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    await this.client.mkdir(parentId, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.budget.used = 0
    const { file, isDir } = await this.resolveFile(physicalPath)
    await this.client.rename(String(file.id), isDir, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    this.budget.used = 0
    const { file, isDir } = await this.resolveFile(physicalPath)
    await this.client.remove(String(file.id), isDir, file.name)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    this.budget.used = 0
    const { file, isDir } = await this.resolveFile(srcPhysical)
    const dstParts = String(dstDir).split("/").filter(Boolean)
    const targetParentId = await this.resolveFolderId("/" + dstParts.join("/"))
    await this.client.move(String(file.id), isDir, file.name, targetParentId)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    this.budget.used = 0
    const { file, isDir } = await this.resolveFile(srcPhysical)
    const dstParts = String(dstDir).split("/").filter(Boolean)
    const targetParentId = await this.resolveFolderId("/" + dstParts.join("/"))
    await this.client.copy(String(file.id), isDir, file.name, targetParentId)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    if (content.length < 1) {
      throw new Error("[189Cloud] 不允许上传空文件")
    }
    this.budget.used = 0
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const fileName = segs.pop() || "file"
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath)

    const fileSize = content.length
    const fileMd5 = md5(content)
    const sliceSize = Math.min(4 * 1024 * 1024, fileSize)
    const sliceMd5 = md5(content.subarray(0, sliceSize))
    const lastWriteTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

    // 1. 初始化（秒传检测）
    const initResp = await this.client.uploadInit({
      parentFolderId: parentId,
      fileName,
      fileSize,
      fileMd5,
      sliceSize,
      sliceMd5,
      lastWriteTime,
    })
    if (initResp.data?.fileDataExists) {
      return // 秒传成功
    }
    if (!initResp.data?.uploadFileId || !initResp.data?.uploadHost) {
      throw new Error(
        `[189Cloud] 上传初始化失败: ${initResp.res_message || "缺少 uploadFileId"}`,
      )
    }
    const { uploadFileId, uploadHost } = initResp.data

    // 2. 分片（默认 4MB；大文件每片 4MB，但不超过 1000 片）
    const partSize = Math.max(4 * 1024 * 1024, Math.ceil(fileSize / 1000))
    const partCount = Math.ceil(fileSize / partSize)
    const urlsResp = await this.client.getUploadUrls({
      uploadFileId,
      partSize,
      partCount,
    })
    const uploadUrls = urlsResp.uploadUrls
    if (!uploadUrls) {
      throw new Error("[189Cloud] 获取分片上传地址失败")
    }

    const partEtags: Array<{ partNumber: number; partEtag: string }> = []
    const uploadHostClean = uploadHost.replace(/\/+$/, "")
    for (let i = 0; i < partCount; i++) {
      const start = i * partSize
      const end = Math.min(start + partSize, fileSize)
      const part = content.subarray(start, end)
      const partMd5 = md5(part)

      const partInfo = uploadUrls[String(i)] || uploadUrls[String(i + 1)]
      if (!partInfo?.requestURL) {
        throw new Error(`[189Cloud] 缺少第 ${i} 片上传地址`)
      }
      // requestHeader 形如 "Content-Type: application/octet-stream; ..."
      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(part.length),
      }
      if (partInfo.requestHeader) {
        for (const h of partInfo.requestHeader.split("\r\n")) {
          const idx = h.indexOf(":")
          if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
        }
      }
      const partUrl = partInfo.requestURL.startsWith("http")
        ? partInfo.requestURL
        : `https://${uploadHostClean}${partInfo.requestURL}`
      const partRes = await fetch(partUrl, {
        method: "PUT",
        headers,
        body: part as unknown as BodyInit,
      })
      if (!partRes.ok) {
        throw new Error(
          `[189Cloud] 分片 ${i} 上传失败 (HTTP ${partRes.status})`,
        )
      }
      partEtags.push({ partNumber: i + 1, partEtag: partMd5 })
    }

    // 3. 提交
    await this.client.commitUpload({
      uploadFileId,
      fileSize,
      partEtagList: partEtags,
    })
  }
}
