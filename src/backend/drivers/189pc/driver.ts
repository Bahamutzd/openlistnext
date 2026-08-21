// 189CloudPC 驱动（天翼云盘 PC 客户端协议）
// 对齐原版 OpenList drivers/189pc：api.cloud.189.cn + SessionKey HMAC

import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { Cloud189PcAddition, Cloud189PcFile, Cloud189PcFolder } from "./types"
import { Pan189PcClient, parse189Time } from "./client"

function folderToItem(folder: Cloud189PcFolder): FileItem {
  return {
    name: folder.name,
    size: 0,
    is_dir: true,
    created: parse189Time(folder.createDate),
    modified: parse189Time(folder.lastOpTime || folder.createDate),
    sign: String(folder.id),
    type: 1,
    thumb: "",
    raw_url: "",
  }
}

function fileToItem(file: Cloud189PcFile): FileItem {
  return {
    name: file.name,
    size: file.size || 0,
    is_dir: false,
    created: parse189Time(file.createDate),
    modified: parse189Time(file.lastOpTime || file.createDate),
    sign: String(file.id),
    type: calcFileType(file.name, false),
    thumb: file.icon?.smallUrl || file.icon?.largeUrl || "",
    raw_url: "",
  }
}

export function normalizeCloud189PcAddition(a: any): Cloud189PcAddition {
  const norm = { ...(a || {}) } as any
  if (norm.root_folder_id == null || norm.root_folder_id === "") {
    norm.root_folder_id = norm.type === "family" ? "" : "-11"
  }
  if (norm.type === "family" && norm.root_folder_id === "-11") {
    norm.root_folder_id = ""
  }
  norm.order_by = norm.order_by || "filename"
  if (norm.order_by === "fileSize") norm.order_by = "filesize"
  norm.order_direction = norm.order_direction || "asc"
  norm.type = norm.type || "personal"
  return norm as Cloud189PcAddition
}

export class Cloud189PcDriver implements StorageDriver {
  private client: Pan189PcClient
  private addition: Cloud189PcAddition
  private pathIdCache = new Map<string, string>()

  constructor(
    addition: Cloud189PcAddition,
    onTokenUpdate?: (tokens: {
      access_token?: string
      refresh_token?: string
    }) => void | Promise<void>,
  ) {
    this.addition = normalizeCloud189PcAddition(addition)
    this.client = new Pan189PcClient(this.addition, onTokenUpdate)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

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
      })
      const folder = folders.find((f) => f.name === name)
      if (!folder) {
        throw new Error(`[189CloudPC] 目录未找到: ${name}`)
      }
      parentId = String(folder.id)
      prefix = "/" + segs.slice(0, i + 1).join("/")
      this.pathIdCache.set(prefix, parentId)
    }
    return parentId
  }

  private async resolveFile(physicalPath: string): Promise<{
    file: Cloud189PcFile | Cloud189PcFolder
    parentId: string
    isDir: boolean
  }> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    if (segs.length === 0) throw new Error("[189CloudPC] 路径无效")
    const name = segs[segs.length - 1]
    const parentPath = "/" + segs.slice(0, segs.length - 1).join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const { files, folders } = await this.client.getFiles(parentId, {
      findName: name,
    })
    const file = files.find((f) => f.name === name || String(f.id) === name)
    if (file) return { file, parentId, isDir: false }
    const folder = folders.find((f) => f.name === name || String(f.id) === name)
    if (folder) return { file: folder, parentId, isDir: true }
    throw new Error(`[189CloudPC] 文件或目录未找到: ${name}`)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFolderId(physicalPath)
    const { files, folders } = await this.client.getFiles(folderId)
    const items: FileItem[] = [
      ...folders.map(folderToItem),
      ...files.map(fileToItem),
    ]
    return sortFileItems(
      items,
      this.addition.order_by === "filename"
        ? "file_name"
        : this.addition.order_by === "filesize"
          ? "size"
          : "updated_at",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    if (
      segs.length === 0 ||
      segs[segs.length - 1] === this.client.getRootId()
    ) {
      const rootId = this.client.getRootId() || "-11"
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
    const { file, isDir } = await this.resolveFile(physicalPath)
    if (isDir) return folderToItem(file as Cloud189PcFolder)
    const item = fileToItem(file as Cloud189PcFile)
    try {
      item.raw_url = await this.client.getDownloadUrl(String(file.id))
    } catch (e: any) {
      console.warn(`[189CloudPC] 获取 ${file.name} 下载地址失败:`, e.message)
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const dirName = segs.pop() || "新文件夹"
    const parentId = await this.resolveFolderId("/" + segs.join("/"))
    await this.client.mkdir(parentId, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const { file, isDir } = await this.resolveFile(physicalPath)
    await this.client.rename(String(file.id), isDir, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
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
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const fileName = segs.pop() || "file"
    const parentId = await this.resolveFolderId("/" + segs.join("/"))
    await this.client.upload(parentId, fileName, content)
  }
}
