// SFTP 存储驱动（Node-only，需要 ssh2 / net socket）
// 与 Local 驱动一致：Cloudflare Workers（纯 Web 标准）下不可用，挂载时给出明确错误。

import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { SftpAddition } from "./types"

let ssh2Module: any = null

async function initNodeSsh() {
  if (
    typeof process !== "undefined" &&
    process.release?.name === "node" &&
    !ssh2Module
  ) {
    try {
      // 运行时拼接包名：esbuild/wrangler 会对字符串字面量拼接做常量折叠并
      // 静态解析动态 import，导致把 ssh2（含 .node 原生文件 cpu-features/
      // sshcrypto）打进 Workers bundle 后构建失败。用 String.fromCharCode
      // 这类函数调用阻止折叠；该 import 仅 Node 容器模式会执行。
      const PKG_SSH2 = "ssh" + String.fromCharCode(0x32) // "ssh2"
      ssh2Module = await import(PKG_SSH2)
    } catch (e) {}
  }
}

function ensureNode(): any {
  if (!ssh2Module)
    throw new Error(
      "SFTP driver requires Node.js runtime (not available in Cloudflare Workers)",
    )
  return ssh2Module
}

function normalizeSftpAddition(a: any): SftpAddition {
  const norm = { ...(a || {}) } as any
  norm.host = (norm.host || "").trim()
  norm.port = parseInt(norm.port, 10) || 22
  norm.username = norm.username || ""
  norm.password = norm.password || ""
  norm.private_key = norm.private_key || ""
  norm.private_key_passphrase = norm.private_key_passphrase || ""
  norm.root_folder_path = norm.root_folder_path || "/"
  return norm as SftpAddition
}

export class SftpDriver implements StorageDriver {
  private addition: SftpAddition

  constructor(addition: SftpAddition) {
    this.addition = normalizeSftpAddition(addition)
  }

  /** 建立 SSH 连接并返回 sftp 通道 */
  private async connectSftp(): Promise<{
    conn: any
    sftp: any
    close: () => void
  }> {
    const { Client } = ensureNode()
    const conn = new Client()
    const config: any = {
      host: this.addition.host,
      port: this.addition.port,
      username: this.addition.username,
      readyTimeout: 20000,
    }
    if (this.addition.private_key) {
      config.privateKey = this.addition.private_key
      if (this.addition.private_key_passphrase) {
        config.passphrase = this.addition.private_key_passphrase
      }
    } else {
      config.password = this.addition.password
    }
    if (this.addition.ignore_hostkey) {
      config.readyTimeout = 20000
    }

    const sftp = await new Promise<any>((resolve, reject) => {
      conn.on("ready", () => {
        conn.sftp((err: any, sftp: any) => {
          if (err) return reject(err)
          resolve(sftp)
        })
      })
      conn.on("error", reject)
      conn.connect(config)
    })

    return {
      conn,
      sftp,
      close: () => {
        try {
          conn.end()
        } catch {}
      },
    }
  }

  /** SFTP 远程路径 */
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
      throw new Error("SFTP host is required")
    }
    ensureNode()
    const { close } = await this.connectSftp().catch((e: any) => {
      throw new Error(`SFTP 连接失败: ${e.message}`)
    })
    close()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const { sftp, close } = await this.connectSftp()
    try {
      const list: any[] = await new Promise((resolve, reject) => {
        sftp.readdir(this.remotePath(physicalPath), (err: any, files: any) => {
          if (err) return reject(err)
          resolve(files)
        })
      })
      return list
        .filter((f: any) => f.filename !== "." && f.filename !== "..")
        .map((f: any) => {
          const isDir = f.attrs.isDirectory()
          return {
            name: f.filename,
            size: f.attrs.size || 0,
            is_dir: isDir,
            modified: f.attrs.mtime
              ? new Date(f.attrs.mtime * 1000).toISOString()
              : new Date().toISOString(),
            sign: "",
            type: calcFileType(f.filename, isDir),
            raw_url: "",
          }
        })
    } finally {
      close()
    }
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const { sftp, close } = await this.connectSftp()
    try {
      const remote = this.remotePath(physicalPath)
      const stat: any = await new Promise((resolve, reject) => {
        sftp.stat(remote, (err: any, st: any) => {
          if (err) return reject(err)
          resolve(st)
        })
      })
      const name = remote.split("/").filter(Boolean).pop() || "file"
      const isDir = stat.isDirectory()
      return {
        name,
        size: stat.size || 0,
        is_dir: isDir,
        modified: stat.mtime
          ? new Date(stat.mtime * 1000).toISOString()
          : new Date().toISOString(),
        sign: "",
        type: calcFileType(name, isDir),
        raw_url: "",
      }
    } finally {
      close()
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const { sftp, close } = await this.connectSftp()
    try {
      await new Promise((resolve, reject) => {
        sftp.mkdir(this.remotePath(physicalPath), (err: any) =>
          err ? reject(err) : resolve(null),
        )
      })
    } finally {
      close()
    }
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const { sftp, close } = await this.connectSftp()
    try {
      const src = this.remotePath(physicalPath)
      const dst = src.split("/").slice(0, -1).join("/") + "/" + newName
      await new Promise((resolve, reject) => {
        sftp.rename(src, dst, (err: any) => (err ? reject(err) : resolve(null)))
      })
    } finally {
      close()
    }
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const { sftp, close } = await this.connectSftp()
    try {
      const base = this.remotePath(physicalPath).replace(/\/$/, "")
      for (const name of names) {
        const target = `${base}/${name}`
        try {
          await new Promise((resolve, reject) => {
            sftp.unlink(target, (err: any) =>
              err ? reject(err) : resolve(null),
            )
          })
        } catch {
          // 目录 → 递归删除
          await this.rmrf(sftp, target)
        }
      }
    } finally {
      close()
    }
  }

  /** 递归删除目录 */
  private async rmrf(sftp: any, dir: string): Promise<void> {
    const list: any[] = await new Promise((resolve, reject) => {
      sftp.readdir(dir, (err: any, files: any) =>
        err ? reject(err) : resolve(files),
      )
    })
    for (const f of list) {
      const p = `${dir}/${f.filename}`
      if (f.attrs.isDirectory()) {
        await this.rmrf(sftp, p)
      } else {
        await new Promise((resolve, reject) => {
          sftp.unlink(p, (err: any) => (err ? reject(err) : resolve(null)))
        })
      }
    }
    await new Promise((resolve, reject) => {
      sftp.rmdir(dir, (err: any) => (err ? reject(err) : resolve(null)))
    })
  }

  async move(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    const { sftp, close } = await this.connectSftp()
    try {
      for (const name of names) {
        const src = `${this.remotePath(srcPhys).replace(/\/$/, "")}/${name}`
        const dst = `${this.remotePath(dstDir).replace(/\/$/, "")}/${name}`
        await new Promise((resolve, reject) => {
          sftp.rename(src, dst, (err: any) =>
            err ? reject(err) : resolve(null),
          )
        })
      }
    } finally {
      close()
    }
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    // SFTP 无服务端 copy，用 读→写 模拟
    const { sftp, close } = await this.connectSftp()
    try {
      for (const name of names) {
        const src = `${this.remotePath(srcPhys).replace(/\/$/, "")}/${name}`
        const dst = `${this.remotePath(dstDir).replace(/\/$/, "")}/${name}`
        const chunks: Buffer[] = []
        await new Promise((resolve, reject) => {
          const rs = sftp.createReadStream(src)
          rs.on("data", (c: Buffer) => chunks.push(Buffer.from(c)))
          rs.on("end", resolve)
          rs.on("error", reject)
        })
        const buf = Buffer.concat(chunks)
        await new Promise((resolve, reject) => {
          const ws = sftp.createWriteStream(dst)
          ws.on("close", resolve)
          ws.on("error", reject)
          ws.end(buf)
        })
      }
    } finally {
      close()
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const { sftp, close } = await this.connectSftp()
    try {
      await new Promise((resolve, reject) => {
        const ws = sftp.createWriteStream(this.remotePath(physicalPath))
        ws.on("close", resolve)
        ws.on("error", reject)
        ws.end(content)
      })
    } finally {
      close()
    }
  }
}
