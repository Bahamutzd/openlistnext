// WebDAV 存储驱动
// 把外部 WebDAV（Nextcloud / 群晖 / 另一台 OpenList /dav 等）作为存储挂载进来。
// 底层走标准 WebDAV 协议：PROPFIND / MKCOL / PUT / DELETE / MOVE / COPY。

import { StorageDriver, FileItem } from "../../internal/driver/base"
import { WebDavAddition } from "./types"
import {
  basicAuthHeader,
  normalizeRoot,
  remotePath,
  parsePropfindResponse,
  propToFileItem,
} from "./util"

export class WebDavDriver implements StorageDriver {
  private addition: WebDavAddition
  private baseUrl: string

  constructor(addition: WebDavAddition) {
    this.addition = {
      vendor: "other",
      root_folder_path: "/",
      ...(addition || {}),
    }
    this.baseUrl = (this.addition.address || "").replace(/\/+$/, "")
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: basicAuthHeader(
        this.addition.username || "",
        this.addition.password || "",
      ),
    }
    if (this.addition.vendor === "sharepoint") {
      h["X-Requested-With"] = "XMLHttpRequest"
    }
    return h
  }

  /** 远端 URL（保留路径编码） */
  private url(path: string): string {
    return this.baseUrl + path
  }

  async init(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error("WebDAV address is required")
    }
    // 探测：对根做一次 PROPFIND，验证地址与凭据
    const res = await fetch(
      this.url(remotePath(this.addition.root_folder_path, "/")),
      {
        method: "PROPFIND",
        headers: { ...this.headers, Depth: "0" },
      },
    )
    if (res.status === 401 || res.status === 403) {
      throw new Error("WebDAV authentication failed (401/403)")
    }
    if (!res.ok) {
      throw new Error(`WebDAV init failed: ${res.status}`)
    }
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const res = await fetch(
      this.url(remotePath(this.addition.root_folder_path, physicalPath)),
      {
        method: "PROPFIND",
        headers: { ...this.headers, Depth: "1" },
      },
    )
    if (!res.ok) {
      throw new Error(`WebDAV list failed: ${res.status}`)
    }
    const xml = await res.text()
    return parsePropfindResponse(xml).map(propToFileItem)
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const res = await fetch(
      this.url(remotePath(this.addition.root_folder_path, physicalPath)),
      {
        method: "PROPFIND",
        headers: { ...this.headers, Depth: "0" },
      },
    )
    if (!res.ok) {
      throw new Error(`WebDAV get failed: ${res.status}`)
    }
    const xml = await res.text()
    const items = parsePropfindResponse(xml)
    if (!items.length) {
      throw new Error("WebDAV resource not found")
    }
    const p = items[0]
    const item = propToFileItem(p)
    // 下载直链：直接指向远端地址（带认证头）
    item.raw_url = this.url(
      remotePath(this.addition.root_folder_path, physicalPath),
    )
    item.raw_url_headers = this.headers
    return item
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const res = await fetch(
      this.url(remotePath(this.addition.root_folder_path, physicalPath)),
      { method: "MKCOL", headers: this.headers },
    )
    if (res.status !== 201 && res.status !== 200 && res.status !== 405) {
      throw new Error(`WebDAV mkdir failed: ${res.status}`)
    }
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const src = remotePath(this.addition.root_folder_path, physicalPath)
    const dst =
      remotePath(this.addition.root_folder_path, physicalPath)
        .split("/")
        .slice(0, -1)
        .join("/") +
      "/" +
      encodeURIComponent(newName)
    const res = await fetch(this.url(src), {
      method: "MOVE",
      headers: { ...this.headers, Destination: this.url(dst) },
    })
    if (res.status !== 201 && res.status !== 200 && res.status !== 204) {
      throw new Error(`WebDAV rename failed: ${res.status}`)
    }
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    for (const name of names) {
      const target =
        remotePath(this.addition.root_folder_path, physicalPath).replace(
          /\/$/,
          "",
        ) +
        "/" +
        encodeURIComponent(name)
      const res = await fetch(this.url(target), {
        method: "DELETE",
        headers: this.headers,
      })
      if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
        throw new Error(`WebDAV delete failed: ${res.status}`)
      }
    }
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    for (const name of names) {
      const src =
        remotePath(this.addition.root_folder_path, srcPhys).replace(/\/$/, "") +
        "/" +
        encodeURIComponent(name)
      const dst =
        remotePath(this.addition.root_folder_path, dstPhys).replace(/\/$/, "") +
        "/" +
        encodeURIComponent(name)
      const res = await fetch(this.url(src), {
        method: "MOVE",
        headers: { ...this.headers, Destination: this.url(dst) },
      })
      if (res.status !== 201 && res.status !== 200 && res.status !== 204) {
        throw new Error(`WebDAV move failed: ${res.status}`)
      }
    }
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    for (const name of names) {
      const src =
        remotePath(this.addition.root_folder_path, srcPhys).replace(/\/$/, "") +
        "/" +
        encodeURIComponent(name)
      const dst =
        remotePath(this.addition.root_folder_path, dstPhys).replace(/\/$/, "") +
        "/" +
        encodeURIComponent(name)
      const res = await fetch(this.url(src), {
        method: "COPY",
        headers: { ...this.headers, Destination: this.url(dst) },
      })
      if (res.status !== 201 && res.status !== 200 && res.status !== 204) {
        throw new Error(`WebDAV copy failed: ${res.status}`)
      }
    }
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const res = await fetch(
      this.url(remotePath(this.addition.root_folder_path, physicalPath)),
      {
        method: "PUT",
        headers: {
          ...this.headers,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(content.length),
        },
        body: content as unknown as BodyInit,
      },
    )
    if (res.status !== 201 && res.status !== 200 && res.status !== 204) {
      throw new Error(`WebDAV put failed: ${res.status}`)
    }
  }
}
