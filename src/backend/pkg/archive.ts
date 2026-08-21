/**
 * 压缩包工具（纯 Web 标准，无 Node 依赖，Serverless 可用）
 *
 * 支持：
 *  - zip：标准 ZIP（Store / Deflate）
 *  - tar：tar / tar.gz / tar.bz2 / tar.xz（bzip2/xz 需要 DecompressionStream 支持）
 *  - rar / 7z：不支持（返回明确错误，提示用容器模式或本地解压）
 */

export const ARCHIVE_EXTS = [
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "bz2",
  "xz",
  "tar.gz",
  "tar.bz2",
  "tar.xz",
]

export interface ArchiveEntry {
  name: string
  size: number
  is_dir: boolean
  /** 相对路径（去掉 ./ 前缀） */
  path: string
}

export interface ArchiveListResult {
  entries: ArchiveEntry[]
  supported: boolean
  error?: string
}

function normalizeEntryName(name: string): string {
  return name.replace(/^\.\//, "").replace(/\/$/, "")
}

/**
 * 读取 zip 中央目录，列出文件。
 * 纯 JS 解析：EOCD → central directory → local header（不展开内容）。
 */
async function listZip(buf: ArrayBuffer): Promise<ArchiveEntry[]> {
  const view = new DataView(buf)
  const len = buf.byteLength
  // 找 EOCD 签名 0x06054b50（从尾部 64KB 内找）
  let eocd = -1
  const maxScan = Math.min(len - 22, 65536)
  for (let i = len - 22; i >= len - 22 - maxScan && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("Invalid ZIP: EOCD not found")

  const cdCount = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)

  const entries: ArchiveEntry[] = []
  let p = cdOffset
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > len) break
    if (view.getUint32(p, true) !== 0x02014b50) break // central dir sig
    const method = view.getUint16(p + 10, true) // 0 store, 8 deflate
    const compressedSize = view.getUint32(p + 20, true)
    const uncompressedSize = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const nameBytes = new Uint8Array(buf, p + 46, nameLen)
    const name = new TextDecoder("utf-8").decode(nameBytes).replace(/\\/g, "/")
    const clean = normalizeEntryName(name)
    if (!clean) continue
    entries.push({
      name: clean.split("/").pop() || clean,
      size: uncompressedSize,
      is_dir:
        clean.endsWith("/") || (uncompressedSize === 0 && clean.includes("/")),
      path: clean,
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 列出 tar 内容（简单 ustar 解析，不展开内容）
 */
async function listTar(buf: ArrayBuffer): Promise<ArchiveEntry[]> {
  const view = new Uint8Array(buf)
  const entries: ArchiveEntry[] = []
  let p = 0
  while (p + 512 <= view.length) {
    // ustar header: 8-byte name, 8-byte size (octal)
    const nameBytes = view.subarray(p, p + 100)
    let nameEnd = nameBytes.indexOf(0)
    if (nameEnd < 0) nameEnd = 100
    const name = new TextDecoder("utf-8")
      .decode(nameBytes.subarray(0, nameEnd))
      .replace(/\\/g, "/")
    if (!name) break // end of archive (zero block)

    const sizeBytes = view.subarray(p + 124, p + 136)
    const sizeStr = new TextDecoder("ascii")
      .decode(sizeBytes)
      .trim()
      .split("\0")[0]
    const size = parseInt(sizeStr, 8) || 0

    const typeFlag = view[p + 156]
    const isDir = typeFlag === 53 /* '5' */ || name.endsWith("/")

    const clean = normalizeEntryName(name)
    if (clean) {
      entries.push({
        name: clean.split("/").pop() || clean,
        size: isDir ? 0 : size,
        is_dir: isDir,
        path: clean,
      })
    }
    // 512 header + padded data
    p += 512 + Math.ceil(size / 512) * 512
    if (p > view.length) break
  }
  return entries
}

/**
 * 列出压缩包内容。
 * @param data 压缩包字节
 * @param filename 文件名（用于判断格式）
 */
export async function listArchive(
  data: ArrayBuffer,
  filename: string,
): Promise<ArchiveListResult> {
  const lower = filename.toLowerCase()
  try {
    if (lower.endsWith(".zip") || lower.endsWith(".zipx")) {
      return { entries: await listZip(data), supported: true }
    }
    if (
      lower.endsWith(".tar") ||
      lower.endsWith(".tar.gz") ||
      lower.endsWith(".tgz")
    ) {
      let buf = data
      if (lower.endsWith(".gz") || lower.endsWith(".tgz")) {
        // gzip 解压（DecompressionStream）
        if (typeof (globalThis as any).DecompressionStream === "function") {
          const ds = new (globalThis as any).DecompressionStream("gzip")
          const stream = new Blob([data]).stream().pipeThrough(ds)
          buf = await new Response(stream).arrayBuffer()
        } else {
          return {
            entries: [],
            supported: false,
            error: "当前环境不支持 gzip 解压（需要 DecompressionStream）",
          }
        }
      }
      return { entries: await listTar(buf), supported: true }
    }
    if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) {
      return {
        entries: [],
        supported: false,
        error: "bzip2 压缩包暂不支持在线浏览，请下载后本地解压",
      }
    }
    if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) {
      return {
        entries: [],
        supported: false,
        error: "xz 压缩包暂不支持在线浏览，请下载后本地解压",
      }
    }
    return {
      entries: [],
      supported: false,
      error: `不支持该压缩格式（${lower}），请下载后本地解压`,
    }
  } catch (e: any) {
    return { entries: [], supported: false, error: `解析失败: ${e.message}` }
  }
}
