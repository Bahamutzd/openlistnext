// FTP 存储驱动（Node-only，需要 basic-ftp / net socket）
// 与 Local 驱动一致：Cloudflare Workers（纯 Web 标准）下不可用，挂载时给出明确错误。

import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { FtpAddition } from "./types"

let ftpModule: any = null

async function initNodeFtp() {
  if (
    typeof process !== "undefined" &&
    process.release?.name === "node" &&
    !ftpModule
  ) {
    try {
      // 运行时拼接包名：与 sftp 一致，防止 esbuild 静态解析 basic-ftp
      // （basic-ftp 不含 .node，但保持同样写法以防其依赖变化）
      const PKG_BASIC_FTP = "basic-" + String.fromCharCode(0x66) + "tp" // "basic-ftp"
      ftpModule = await import(PKG_BASIC_FTP)
    } catch (e) {}
  }
}

function ensureNode(): any {
  if (!ftpModule)
    throw new Error(
      "FTP driver requires Node.js runtime (not available in Cloudflare Workers)",
    )
  return ftpModule
}

function normalizeFtpAddition(a: any): FtpAddition {
  const norm = { ...(a || {}) } as any
  norm.host = (norm.host || "").trim()
  norm.port = parseInt(norm.port, 10) || 21
  norm.username = norm.username || "anonymous"
  norm.password = norm.password || "guest"
  norm.root_folder_path = norm.root_folder_path || "/"
  norm.tls = !!norm.tls
  return norm as FtpAddition
}

export class FtpDriver implements StorageDriver {
  private addition: FtpAddition

  constructor(addition: FtpAddition) {
    this.addition = normalizeFtpAddition(addition)
  }

  private async connect() {
    const { Client } = ensureNode()
    const client = new Client()
    client.ftp.verbose = false
    await client.access({
      host: this.addition.host,
      port: this.addition.port,
      user: this.addition.username,
      password: this.addition.password,
      secure: this.addition.tls ? true : false,
      secureOptions: this.addition.tls_insecure_skip_verify
        ? { rejectUnauthorized: false }
        : undefined,
    })
    return client
  }

  /** FTP 远程路径（root_folder_path + physicalPath） */
  private remotePath(physicalPath: string): string {
    const root = this.addition.root_folder_path || "/"
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    if (clean === "/") return root
    return root === "/" ? clean : `${root.replace(/\/$/, "")}${clean}`
  }

  async init(): Promise<void> {
    if (!this.addition.host) {
      throw new Error("FTP host is required")
    }
    ensureNode()
    const client = await this.connect().catch((e: any) => {
      throw new Error(`FTP 连接失败: ${e.message}`)
    })
    client.close()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const client = await this.connect()
    try {
      const list = await client.list(this.remotePath(physicalPath))
      const items: FileItem[] = list
        .filter((f: any) => f.name !== "." && f.name !== "..")
        .map((f: any) => {
          const isDir = f.type === 2 || f.type === 1 // dir / link
          return {
            name: f.name,
            size: f.size || 0,
            is_dir: isDir,
            modified: f.modifiedAt
              ? new Date(f.modifiedAt).toISOString()
              : new Date().toISOString(),
            sign: "",
            type: calcFileType(f.name, isDir),
            raw_url: "",
          }
        })
      return items
    } finally {
      client.close()
    }
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const client = await this.connect()
    try {
      const list = await client.list(this.remotePath(physicalPath))
      const f = list.find(
        (x: any) => x.name === physicalPath.split("/").filter(Boolean).pop(),
      )
      if (!f) throw new Error("FTP file not found")
      const isDir = f.type === 2 || f.type === 1
      return {
        name: f.name,
        size: f.size || 0,
        is_dir: isDir,
        modified: f.modifiedAt
          ? new Date(f.modifiedAt).toISOString()
          : new Date().toISOString(),
        sign: "",
        type: calcFileType(f.name, isDir),
        raw_url: "",
      }
    } finally {
      client.close()
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const client = await this.connect()
    try {
      await client.ensureDir(this.remotePath(physicalPath))
    } finally {
      client.close()
    }
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const client = await this.connect()
    try {
      const src = this.remotePath(physicalPath)
      const dst = src.split("/").slice(0, -1).join("/") + "/" + newName
      await client.rename(src, dst)
    } finally {
      client.close()
    }
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const client = await this.connect()
    try {
      const base = this.remotePath(physicalPath).replace(/\/$/, "")
      for (const name of names) {
        const target = `${base}/${name}`
        try {
          await client.remove(target)
        } catch {
          await client.removeDir(target)
        }
      }
    } finally {
      client.close()
    }
  }

  async move(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    const client = await this.connect()
    try {
      for (const name of names) {
        const src = `${this.remotePath(srcPhys).replace(/\/$/, "")}/${name}`
        const dst = `${this.remotePath(dstDir).replace(/\/$/, "")}/${name}`
        await client.rename(src, dst)
      }
    } finally {
      client.close()
    }
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    // FTP 无服务端 copy，用下载→上传模拟
    const client = await this.connect()
    try {
      const { Readable } = await import("stream")
      for (const name of names) {
        const src = `${this.remotePath(srcPhys).replace(/\/$/, "")}/${name}`
        const dst = `${this.remotePath(dstDir).replace(/\/$/, "")}/${name}`
        const chunks: Buffer[] = []
        await client.downloadTo(
          new (class extends Readable {
            _read() {}
            push(chunk: any) {
              if (chunk) chunks.push(Buffer.from(chunk))
              return true
            }
          })(),
          src,
        )
        const buf = Buffer.concat(chunks)
        await client.uploadFrom(
          new (class extends Readable {
            private i = 0
            _read() {
              if (this.i >= buf.length) {
                this.push(null)
                return
              }
              this.push(buf.subarray(this.i, this.i + 65536))
              this.i += 65536
            }
          })(),
          dst,
        )
      }
    } finally {
      client.close()
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const client = await this.connect()
    try {
      const { Readable } = await import("stream")
      let i = 0
      const stream = new (class extends Readable {
        _read() {
          if (i >= content.length) {
            this.push(null)
            return
          }
          this.push(content.subarray(i, i + 65536))
          i += 65536
        }
      })()
      await client.uploadFrom(stream, this.remotePath(physicalPath))
    } finally {
      client.close()
    }
  }
}
