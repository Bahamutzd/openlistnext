import { Hono } from "hono"
import {
  listItems,
  getItem,
  makeDirectory,
  renameItem,
  removeItems,
  moveItems,
  copyItems,
  putItem,
  getDriver,
} from "../internal/op/storage"
import { resolvePath } from "../internal/model/db"
import { resolveShare } from "../internal/op/share"
import { listArchive } from "../pkg/archive"

export const fsRouter = new Hono()

// GET sub-directories of a path (used by FolderTree in metas/storages editors)
fsRouter.post("/dirs", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"
  try {
    // Share path support for completeness
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return c.json({ code: 400, message: shareRes.error, data: null })
      }
      if (shareRes.virtualList) {
        const dirs = []
        for (const f of shareRes.share.files || []) {
          try {
            const { item } = await getItem(f)
            if (item.is_dir) {
              const segs = String(f).split("/").filter(Boolean)
              dirs.push({
                name: segs[segs.length - 1] || f,
                size: 0,
                is_dir: true,
                modified: item.modified || new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 1,
              })
            }
          } catch {
            // skip unlistable share items
          }
        }
        return c.json({ code: 200, message: "success", data: dirs })
      }
      const { content } = await listItems(shareRes.realPath!)
      const dirs = content
        .filter((item: any) => item.is_dir)
        .map((item: any) => ({
          name: item.name,
          size: 0,
          is_dir: true,
          modified: item.modified || new Date().toISOString(),
          sign: item.sign || "",
          thumb: item.thumb || "",
          type: 1,
        }))
      return c.json({ code: 200, message: "success", data: dirs })
    }

    const { content } = await listItems(reqPath)
    const dirs = content
      .filter((item: any) => item.is_dir)
      .map((item: any) => ({
        name: item.name,
        size: 0,
        is_dir: true,
        modified: item.modified || new Date().toISOString(),
        sign: item.sign || "",
        thumb: item.thumb || "",
        type: 1,
      }))
    return c.json({ code: 200, message: "success", data: dirs })
  } catch (err: any) {
    return c.json({ code: 500, message: err.message, data: null })
  }
})

fsRouter.post("/list", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"

  try {
    // Share path: /@s/{shareId}/...
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return c.json({ code: 400, message: shareRes.error, data: null })
      }

      // Multi-file share root → virtual list of the shared items
      if (shareRes.virtualList) {
        const items = []
        for (const f of shareRes.share.files || []) {
          const segs = String(f).split("/").filter(Boolean)
          const name = segs[segs.length - 1] || f
          try {
            const { item } = await getItem(f)
            items.push({
              name,
              size: item.size || 0,
              is_dir: !!item.is_dir,
              modified: item.modified || new Date().toISOString(),
              sign: "",
              thumb: item.thumb || "",
              type: item.type ?? 0,
            })
          } catch {
            // If getItem failed, probe by listing — a listable path is a folder
            try {
              await listItems(f)
              items.push({
                name,
                size: 0,
                is_dir: true,
                modified: new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 1,
              })
            } catch {
              items.push({
                name,
                size: 0,
                is_dir: false,
                modified: new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 0,
              })
            }
          }
        }
        return c.json({
          code: 200,
          message: "success",
          data: {
            content: items,
            total: items.length,
            readme: shareRes.share.readme || "",
            header: shareRes.share.header || "",
            write: false,
            write_content_bypass: false,
            provider: "Share",
          },
        })
      }

      // Mapped to a real path — fall through to normal listing
      const { content, provider } = await listItems(shareRes.realPath!)
      const normalized = content.map((item: any) => ({
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        created: item.created || item.modified || new Date().toISOString(),
        modified: item.modified || new Date().toISOString(),
        sign: item.sign || "",
        thumb: item.thumb || "",
        type: item.type ?? 0,
      }))
      return c.json({
        code: 200,
        message: "success",
        data: {
          content: normalized,
          total: normalized.length,
          readme: shareRes.share.readme || "",
          header: shareRes.share.header || "",
          write: false,
          write_content_bypass: false,
          provider,
        },
      })
    }

    const { content, provider } = await listItems(reqPath)
    // Normalize each item to the full Obj shape expected by the frontend
    const normalized = content.map((item: any) => ({
      name: item.name,
      size: item.size,
      is_dir: item.is_dir,
      created: item.created || item.modified || new Date().toISOString(),
      modified: item.modified || new Date().toISOString(),
      sign: item.sign || "",
      thumb: item.thumb || "",
      type: item.type ?? 0,
    }))
    return c.json({
      code: 200,
      message: "success",
      data: {
        content: normalized,
        total: normalized.length,
        readme: "",
        header: "",
        write: true,
        write_content_bypass: false,
        provider,
      },
    })
  } catch (err: any) {
    return c.json({ code: 500, message: err.message, data: null })
  }
})

fsRouter.post("/get", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"
  try {
    // Share path: /@s/{shareId}/...
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return c.json({ code: 400, message: shareRes.error, data: null })
      }

      // Multi-file share root: report as a virtual folder so the frontend lists it
      if (shareRes.virtualList) {
        const shareId = reqPath.split("/").filter(Boolean)[1] || "share"
        return c.json({
          code: 200,
          message: "success",
          data: {
            name: shareId,
            size: 0,
            is_dir: true,
            modified: new Date().toISOString(),
            sign: "",
            thumb: "",
            type: 1,
            raw_url: "",
            readme: shareRes.share.readme || "",
            header: shareRes.share.header || "",
            provider: "Share",
            related: [],
            write: false,
            write_content_bypass: false,
          },
        })
      }

      // Mapped to a real path — get with share-aware raw_url (/sd/{shareId}...)
      const shareId = reqPath.split("/").filter(Boolean)[1] || ""
      const { item, provider } = await getItem(shareRes.realPath!)
      const subPath = reqPath.replace(/^\/@s\/[^/]+/, "")
      return c.json({
        code: 200,
        message: "success",
        data: {
          name: item.name,
          size: item.size,
          is_dir: item.is_dir,
          created:
            (item as any).created || item.modified || new Date().toISOString(),
          modified: item.modified,
          sign: item.sign || "",
          thumb: (item as any).thumb || "",
          type: item.type ?? 0,
          raw_url: `/api/sd/${shareId}${subPath}`,
          readme: shareRes.share.readme || "",
          header: shareRes.share.header || "",
          provider,
          related: [],
          write: false,
          write_content_bypass: false,
        },
      })
    }

    const { item, provider, rawUrl } = await getItem(reqPath)
    return c.json({
      code: 200,
      message: "success",
      data: {
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        created:
          (item as any).created || item.modified || new Date().toISOString(),
        modified: item.modified,
        sign: item.sign || "",
        thumb: (item as any).thumb || "",
        type: item.type ?? 0,
        raw_url: rawUrl,
        readme: "",
        header: "",
        provider,
        related: [],
        write: true,
        write_content_bypass: false,
      },
    })
  } catch (err: any) {
    return c.json({ code: 500, message: err.message, data: null })
  }
})

fsRouter.post("/mkdir", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"
  try {
    await makeDirectory(reqPath)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/rename", async (c) => {
  const { path: oldPath, name: newName } = await c.req.json().catch(() => ({}))
  try {
    await renameItem(oldPath, newName)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/remove", async (c) => {
  const { dir, names } = await c.req.json().catch(() => ({}))
  try {
    await removeItems(dir, names)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/move", async (c) => {
  const { src_dir, dst_dir, names } = await c.req.json().catch(() => ({}))
  try {
    await moveItems(src_dir, dst_dir, names)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/copy", async (c) => {
  const { src_dir, dst_dir, names } = await c.req.json().catch(() => ({}))
  try {
    await copyItems(src_dir, dst_dir, names)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.put("/put", async (c) => {
  const reqPath = decodeURIComponent(c.req.header("File-Path") || "")
  try {
    const buffer = await c.req.arrayBuffer()
    await putItem(reqPath, Buffer.from(buffer))
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/add_offline_download", async (c) => {
  const { path: reqPath, urls, tool } = await c.req.json().catch(() => ({}))
  const urlList = Array.isArray(urls) ? urls.filter(Boolean) : []
  if (urlList.length === 0) {
    return c.json({ code: 400, message: "No URLs provided" })
  }

  try {
    // 解析目标目录所在的存储驱动，交给网盘官方离线下载 API 处理
    // （Serverless 可用：下载发生在网盘服务器上，本服务只是调 API）
    const resolved = await resolvePath(reqPath || "/")
    if (resolved.isVirtual || !resolved.storage) {
      return c.json({ code: 400, message: "Invalid destination path" })
    }
    const storage = resolved.storage
    const driver = await getDriver(storage.driver, storage)

    if (typeof (driver as any).offlineDownload === "function") {
      const result = await (driver as any).offlineDownload(
        urlList,
        resolved.physical!,
      )
      return c.json({
        code: 200,
        message: "success",
        data: result,
      })
    }

    return c.json({
      code: 400,
      message: `Driver '${storage.driver}' does not support offline download`,
      data: null,
    })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

// ─── 压缩包浏览 / 解压（纯 Web 标准，Serverless 可用） ───

// 通过 raw 代理读取文件内容（支持远端驱动），返回 ArrayBuffer
async function fetchFileBuffer(
  c: any,
  virtualPath: string,
): Promise<ArrayBuffer> {
  const host = c.req.header("host") || ""
  const protocol = c.req.header("x-forwarded-proto") || "http"
  const proxyPath =
    "/api/p" + (virtualPath.startsWith("/") ? "" : "/") + virtualPath
  const res = await fetch(`${protocol}://${host}${proxyPath}`)
  if (!res.ok) throw new Error(`读取文件失败 (HTTP ${res.status})`)
  return res.arrayBuffer()
}

// 列出压缩包内文件
fsRouter.post("/archive/list", async (c) => {
  const { path } = await c.req.json().catch(() => ({}))
  if (!path) return c.json({ code: 400, message: "path required", data: null })
  try {
    const buf = await fetchFileBuffer(c, path)
    const name = path.split("/").filter(Boolean).pop() || "archive"
    const result = await listArchive(buf, name)
    return c.json({ code: 200, message: "success", data: result })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

// 解压到目标目录
fsRouter.post("/archive/decompress", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { src_dir, dst_dir, name, archive_pass, inner_path } = body
  const names: string[] = Array.isArray(name) ? name : []
  if (!src_dir || !dst_dir || names.length === 0) {
    return c.json({
      code: 400,
      message: "src_dir/dst_dir/name required",
      data: null,
    })
  }

  try {
    const results: string[] = []
    for (const n of names) {
      const srcPath = `${src_dir}/${n}`
      const buf = await fetchFileBuffer(c, srcPath)
      const listing = await listArchive(buf, n)
      if (!listing.supported) {
        results.push(`${n}: ${listing.error || "不支持的压缩格式"}`)
        continue
      }
      // 仅支持 zip/tar 的实际解压（需要逐文件解出内容）
      // 简单实现：对每个条目走 读取→写入 的流程
      const lower = n.toLowerCase()
      if (!lower.endsWith(".zip") && !lower.endsWith(".tar")) {
        results.push(`${n}: 暂只支持 zip/tar 解压`)
        continue
      }
      const inner = (inner_path || "/")
        .replace(/^\//, "")
        .split("/")
        .filter(Boolean)
      for (const entry of listing.entries) {
        if (entry.is_dir) continue
        // 过滤 inner_path 前缀
        const entrySegs = entry.path.split("/")
        if (inner.length && entrySegs[0] !== inner[0]) continue
        const rel = entrySegs.slice(inner.length).join("/")
        if (!rel) continue
        const dstVirtual = `${dst_dir}/${rel}`
        // 读取单文件内容（zip 需要解压，此处用流式读取整包再取）
        // 简单实现：从原始 buffer 中提取该文件（仅 store 方法可直取）
        // deflate 需要 inflate —— 当前环境有 DecompressionStream('deflate-raw')
        // 为控制复杂度，zip 内文件提取用标准 API 尝试
        const content = await extractZipEntry(buf, entry.path)
        if (content === null) {
          results.push(`${n}: 无法提取 ${entry.path}`)
          continue
        }
        await putItem(dstVirtual, content)
      }
      results.push(`${n}: 解压完成（${listing.entries.length} 个条目）`)
    }
    return c.json({ code: 200, message: "success", data: results })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

/** 从 zip 字节中提取指定路径的文件内容（支持 store 与 deflate） */
async function extractZipEntry(
  buf: ArrayBuffer,
  targetPath: string,
): Promise<Buffer | null> {
  const view = new DataView(buf)
  const len = buf.byteLength
  let eocd = -1
  const maxScan = Math.min(len - 22, 65536)
  for (let i = len - 22; i >= len - 22 - maxScan && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const cdCount = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  let p = cdOffset
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > len) break
    if (view.getUint32(p, true) !== 0x02014b50) break
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const uncompressedSize = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    const name = new TextDecoder("utf-8")
      .decode(new Uint8Array(buf, p + 46, nameLen))
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
    if (name === targetPath) {
      // 读取 local header
      if (localOffset + 30 > len) return null
      const lNameLen = view.getUint16(localOffset + 26, true)
      const lExtraLen = view.getUint16(localOffset + 28, true)
      const dataStart = localOffset + 30 + lNameLen + lExtraLen
      const raw = new Uint8Array(buf, dataStart, compressedSize)
      if (method === 0) {
        // store
        return Buffer.from(raw)
      }
      if (method === 8) {
        // deflate → DecompressionStream('deflate-raw')
        if (typeof (globalThis as any).DecompressionStream === "function") {
          const ds = new (globalThis as any).DecompressionStream("deflate-raw")
          const stream = new Blob([raw]).stream().pipeThrough(ds)
          const out = await new Response(stream).arrayBuffer()
          return Buffer.from(out)
        }
        return null
      }
      return null
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}
