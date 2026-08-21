import CryptoJS from "crypto-js"

/** HMAC-SHA1 大写十六进制（对齐原版 signatureOfHmac） */
export function hmacSha1Upper(data: string, key: string): string {
  return CryptoJS.HmacSHA1(data, key).toString(CryptoJS.enc.Hex).toUpperCase()
}

/** AES-128-ECB PKCS7，大写十六进制（对齐原版 AesECBEncrypt） */
export function aes128EcbEncryptUpper(text: string, key16: string): string {
  const keyWA = CryptoJS.enc.Utf8.parse(key16.slice(0, 16))
  const dataWA = CryptoJS.enc.Utf8.parse(text)
  const encrypted = CryptoJS.AES.encrypt(dataWA, keyWA, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  })
  return encrypted.ciphertext.toString(CryptoJS.enc.Hex).toUpperCase()
}

/** HTTP Date：RFC1123 / Go http.TimeFormat（Mon, 02 Jan 2006 15:04:05 GMT） */
export function getHttpDateStr(date: Date = new Date()): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`
}

export function clientSuffix(): Record<string, string> {
  const a = Math.floor(Math.random() * 1e5)
  const b = Math.floor(Math.random() * 1e10)
  return {
    clientType: "TELEPC",
    version: "6.2",
    channelId: "web_cloud.189.cn",
    rand: `${a}_${b}`,
  }
}

/** 从完整 URL 提取 RequestURI（对齐原版正则 ://[^/]+((/[^/\\s?#]+)*)） */
export function extractRequestUri(fullUrl: string): string {
  try {
    const u = new URL(fullUrl)
    return u.pathname || "/"
  } catch {
    const m = fullUrl.match(/:\/\/[^/]+((\/[^/\s?#]+)*)/)
    return m?.[1] || "/"
  }
}

export function signatureOfHmac(
  sessionSecret: string,
  sessionKey: string,
  operate: string,
  fullUrl: string,
  dateOfGmt: string,
  param: string,
): string {
  const urlpath = extractRequestUri(fullUrl)
  let data = `SessionKey=${sessionKey}&Operate=${operate}&RequestURI=${urlpath}&Date=${dateOfGmt}`
  if (param) data += `&params=${param}`
  return hmacSha1Upper(data, sessionSecret)
}

/** Params.Encode：按 key 排序拼接 k=v */
export function encodeParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&")
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function xmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))
  return m ? xmlUnescape(m[1].trim()) : ""
}

export function xmlTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi")
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1])
  return out
}

export function parse189Time(str?: string): string {
  if (!str) return new Date().toISOString()
  const cleaned = str.replace(/ | /g, " ").trim()
  const m = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`
    const d = new Date(iso)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  const d = new Date(cleaned)
  if (!isNaN(d.getTime())) return d.toISOString()
  return new Date().toISOString()
}
