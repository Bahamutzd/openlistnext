// 189CloudPC 客户端：api.cloud.189.cn + SessionKey HMAC 签名
// 对齐原版 OpenList drivers/189pc（utils.go / help.go / driver.go）

import { rsaEncode } from "../189/crypto"
import { md5 } from "../../pkg/crypto"
import {
  Cloud189PcAddition,
  Cloud189PcFile,
  Cloud189PcFolder,
  Cloud189PcSession,
  Cloud189PcTokenUpdate,
} from "./types"
import {
  aes128EcbEncryptUpper,
  clientSuffix,
  encodeParams,
  getHttpDateStr,
  parse189Time,
  signatureOfHmac,
  xmlTag,
  xmlTags,
} from "./crypto"

const APP_ID = "8025431004"
const ACCOUNT_TYPE = "02"
const CLIENT_TYPE = "10020"
const WEB_URL = "https://cloud.189.cn"
const AUTH_URL = "https://open.e.189.cn"
const API_URL = "https://api.cloud.189.cn"
const UPLOAD_URL = "https://upload.cloud.189.cn"
const RETURN_URL = "https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html"
const OPENLIST_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

function uuid(): string {
  return crypto.randomUUID()
}

function isTransient189(status: number, text: string): boolean {
  if (status === 522 || status === 520 || status === 521 || status >= 500)
    return true
  return /error code:\s*52[0-9]|Cloudflare|just a moment/i.test(text || "")
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<{ res: Response; text: string }> {
  let last: { res: Response; text: string } | null = null
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, init)
    const text = await res.text()
    last = { res, text }
    if (!isTransient189(res.status, text)) return last
    if (i < attempts) await new Promise((r) => setTimeout(r, 300 * i))
  }
  return last!
}

function tryJson(text: string): any | null {
  const t = text.trim()
  if (!t.startsWith("{") && !t.startsWith("[")) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

function parseSession(text: string): Cloud189PcSession | null {
  const json = tryJson(text)
  if (json?.sessionKey || json?.SessionKey) {
    return {
      loginName: json.loginName,
      sessionKey: json.sessionKey || json.SessionKey,
      sessionSecret: json.sessionSecret || json.SessionSecret,
      familySessionKey: json.familySessionKey,
      familySessionSecret: json.familySessionSecret,
      accessToken: json.accessToken,
      refreshToken: json.refreshToken,
    }
  }
  if (text.includes("<userSession") || xmlTag(text, "sessionKey")) {
    const sessionKey = xmlTag(text, "sessionKey")
    const sessionSecret = xmlTag(text, "sessionSecret")
    if (!sessionKey || !sessionSecret) return null
    return {
      loginName: xmlTag(text, "loginName"),
      sessionKey,
      sessionSecret,
      familySessionKey: xmlTag(text, "familySessionKey"),
      familySessionSecret: xmlTag(text, "familySessionSecret"),
      accessToken: xmlTag(text, "accessToken"),
      refreshToken: xmlTag(text, "refreshToken"),
    }
  }
  return null
}

function apiError(text: string, json?: any): string | null {
  if (text.includes("userSessionBO is null")) return "userSessionBO is null"
  if (text.includes("InvalidSessionKey")) return "InvalidSessionKey"
  const jsonCode =
    json?.errorCode ||
    json?.ErrorCode ||
    (json?.res_code !== undefined &&
    json?.res_code !== 0 &&
    json?.res_code !== "0"
      ? String(json.res_code)
      : "")
  const jsonMsg =
    json?.errorMsg || json?.res_message || json?.message || json?.msg || ""
  if (jsonCode && jsonCode !== "SUCCESS") {
    return jsonMsg
      ? `err_code: ${jsonCode} ,err_msg: ${jsonMsg}`
      : `err_code: ${jsonCode}`
  }
  const xmlCode = xmlTag(text, "code") || xmlTag(text, "errorCode")
  const xmlMsg =
    xmlTag(text, "message") || xmlTag(text, "msg") || xmlTag(text, "errorMsg")
  if (xmlCode && xmlCode !== "SUCCESS") {
    return xmlMsg ? `code: ${xmlCode} ,msg: ${xmlMsg}` : `code: ${xmlCode}`
  }
  if (text.includes("UserInvalidOpenToken")) return "UserInvalidOpenToken"
  return null
}

function parseFolderXml(inner: string): Cloud189PcFolder {
  return {
    id: xmlTag(inner, "id"),
    name: xmlTag(inner, "name"),
    lastOpTime: xmlTag(inner, "lastOpTime"),
    createDate: xmlTag(inner, "createDate"),
    parentId: xmlTag(inner, "parentId"),
  }
}

function parseFileXml(inner: string): Cloud189PcFile {
  const size = Number(xmlTag(inner, "size") || "0")
  return {
    id: xmlTag(inner, "id"),
    name: xmlTag(inner, "name"),
    size: Number.isFinite(size) ? size : 0,
    lastOpTime: xmlTag(inner, "lastOpTime"),
    createDate: xmlTag(inner, "createDate"),
    md5: xmlTag(inner, "md5"),
    parentId: xmlTag(inner, "parentId"),
    icon: {
      smallUrl: xmlTag(inner, "smallUrl"),
      largeUrl: xmlTag(inner, "largeUrl"),
    },
  }
}

export class Pan189PcClient {
  private addition: Cloud189PcAddition
  private session: Cloud189PcSession | null = null
  private onTokenUpdate?: (
    tokens: Cloud189PcTokenUpdate,
  ) => void | Promise<void>

  constructor(
    addition: Cloud189PcAddition,
    onTokenUpdate?: (tokens: Cloud189PcTokenUpdate) => void | Promise<void>,
  ) {
    this.addition = addition
    this.onTokenUpdate = onTokenUpdate
  }

  public isFamily(): boolean {
    return (this.addition.type || "personal") === "family"
  }

  public getRootId(): string {
    if (this.isFamily()) {
      return this.addition.root_folder_id &&
        this.addition.root_folder_id !== "-11"
        ? this.addition.root_folder_id
        : ""
    }
    return this.addition.root_folder_id || "-11"
  }

  public getFamilyId(): string {
    return this.addition.family_id || ""
  }

  async init(): Promise<void> {
    if (this.addition.access_token) {
      this.session = {
        sessionKey: "",
        sessionSecret: "",
        accessToken: this.addition.access_token,
        refreshToken: this.addition.refresh_token,
      }
      await this.refreshSession()
    } else if (this.addition.refresh_token) {
      this.session = {
        sessionKey: "",
        sessionSecret: "",
        refreshToken: this.addition.refresh_token,
      }
      await this.refreshToken()
    } else {
      await this.loginByPassword()
    }

    if (!this.addition.family_id) {
      try {
        this.addition.family_id = await this.getFamilyID()
      } catch (e: any) {
        console.warn("[189CloudPC] getFamilyID failed:", e?.message || e)
      }
    }
    if (this.addition.family_transfer) {
      try {
        await this.createFamilyTransferFolder()
      } catch (e: any) {
        console.warn(
          "[189CloudPC] createFamilyTransferFolder failed:",
          e?.message || e,
        )
      }
    }
  }

  private async persistTokens(access?: string, refresh?: string) {
    if (access) this.addition.access_token = access
    if (refresh) this.addition.refresh_token = refresh
    await this.onTokenUpdate?.({
      access_token: this.addition.access_token,
      refresh_token: this.addition.refresh_token,
    })
  }

  private async refreshSession(retryCount = 0): Promise<void> {
    const accessToken = this.session?.accessToken || this.addition.access_token
    if (!accessToken)
      throw new Error("[189CloudPC] access_token 为空，无法刷新会话")

    const q = new URLSearchParams({
      ...clientSuffix(),
      appId: APP_ID,
      accessToken,
    })
    const { res, text } = await fetchWithRetry(
      `${API_URL}/getSessionForPC.action?${q}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json;charset=UTF-8",
          Referer: WEB_URL,
          "User-Agent": OPENLIST_UA,
          "X-Request-ID": uuid(),
        },
      },
    )
    const json = tryJson(text)
    const err = apiError(text, json)
    if (err) {
      if (
        err.includes("UserInvalidOpenToken") ||
        text.includes("UserInvalidOpenToken")
      ) {
        return this.refreshToken(retryCount)
      }
      throw new Error(`[189CloudPC] 刷新会话失败: ${err}`)
    }
    if (isTransient189(res.status, text)) {
      throw new Error(
        `[189CloudPC] 刷新会话失败: 天翼源站瞬时不可达（HTTP ${res.status}）。请稍后刷新重试。`,
      )
    }
    const sess = parseSession(text)
    if (!sess?.sessionKey) {
      throw new Error(
        `[189CloudPC] 刷新会话失败: 未解析到 sessionKey（${text.slice(0, 180)}）`,
      )
    }
    this.session = {
      ...sess,
      accessToken: sess.accessToken || accessToken,
      refreshToken:
        sess.refreshToken ||
        this.session?.refreshToken ||
        this.addition.refresh_token,
    }
  }

  private async refreshToken(retryCount = 0): Promise<void> {
    if (retryCount >= 3) {
      throw new Error("[189CloudPC] refresh token 失败（超过最大重试次数）")
    }
    const refreshToken =
      this.session?.refreshToken || this.addition.refresh_token
    if (!refreshToken) {
      return this.loginByPassword()
    }
    const res = await fetch(`${AUTH_URL}/api/oauth2/refreshToken.do`, {
      method: "POST",
      headers: {
        Accept: "application/json;charset=UTF-8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": OPENLIST_UA,
      },
      body: new URLSearchParams({
        clientId: APP_ID,
        refreshToken,
        grantType: "refresh_token",
        format: "json",
      }),
    })
    const text = await res.text()
    const json = tryJson(text)
    const err = apiError(text, json)
    if (err || !json?.accessToken) {
      if ((this.addition.login_type || "password") === "qrcode") {
        throw new Error("[189CloudPC] 二维码会话已过期，请重新扫码登录")
      }
      return this.loginByPassword()
    }
    this.session = {
      sessionKey: "",
      sessionSecret: "",
      accessToken: json.accessToken,
      refreshToken: json.refreshToken || refreshToken,
    }
    await this.persistTokens(json.accessToken, json.refreshToken)
    await this.refreshSession(retryCount + 1)
  }

  private async loginByPassword(): Promise<void> {
    const username = this.addition.username || ""
    const password = this.addition.password || ""
    if (!username || !password) {
      throw new Error("[189CloudPC] 账号或密码为空，且 access_token 无效")
    }

    const unify = await fetch(
      `${WEB_URL}/api/portal/unifyLoginForPC.action?` +
        new URLSearchParams({
          appId: APP_ID,
          clientType: CLIENT_TYPE,
          returnURL: RETURN_URL,
          timeStamp: String(Date.now()),
        }),
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          Referer: WEB_URL,
          "User-Agent": OPENLIST_UA,
        },
      },
    )
    const html = await unify.text()
    const captchaToken = html.match(/'captchaToken' value='(.+?)'/)?.[1] || ""
    const lt = html.match(/lt = "(.+?)"/)?.[1] || ""
    const paramId = html.match(/paramId = "(.+?)"/)?.[1] || ""
    const reqId = html.match(/reqId = "(.+?)"/)?.[1] || ""
    if (!lt || !paramId) {
      throw new Error("[189CloudPC] 获取 PC 登录参数失败（unifyLoginForPC）")
    }

    const encRes = await fetch(`${AUTH_URL}/api/logbox/config/encryptConf.do`, {
      method: "POST",
      headers: {
        Accept: "application/json;charset=UTF-8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": OPENLIST_UA,
      },
      body: new URLSearchParams({ appId: APP_ID }),
    })
    const encConf = await encRes.json()
    const pubKey = encConf?.data?.pubKey
    const pre = encConf?.data?.pre || ""
    if (!pubKey) {
      throw new Error(
        `[189CloudPC] 获取 EncryptConf 失败: ${JSON.stringify(encConf)}`,
      )
    }
    const pem = `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`
    const rsaUsername = pre + rsaEncode(username, pem, true).toUpperCase()
    const rsaPassword = pre + rsaEncode(password, pem, true).toUpperCase()

    const loginRes = await fetch(
      `${AUTH_URL}/api/logbox/oauth2/loginSubmit.do`,
      {
        method: "POST",
        headers: {
          Accept: "application/json;charset=UTF-8",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": OPENLIST_UA,
          REQID: reqId,
          lt,
        },
        body: new URLSearchParams({
          appKey: APP_ID,
          accountType: ACCOUNT_TYPE,
          userName: rsaUsername,
          password: rsaPassword,
          validateCode: this.addition.validate_code || "",
          captchaToken,
          returnUrl: RETURN_URL,
          dynamicCheck: "FALSE",
          clientType: CLIENT_TYPE,
          cb_SaveName: "1",
          isOauth2: "false",
          state: "",
          paramId,
        }),
      },
    )
    const loginData = await loginRes.json()
    if (!loginData?.toUrl) {
      throw new Error(
        `[189CloudPC] 登录失败: ${loginData?.msg || JSON.stringify(loginData)}`,
      )
    }

    const sessQ = new URLSearchParams({
      ...clientSuffix(),
      redirectURL: loginData.toUrl,
    })
    const { text: sessText } = await fetchWithRetry(
      `${API_URL}/getSessionForPC.action?${sessQ}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json;charset=UTF-8",
          Referer: WEB_URL,
          "User-Agent": OPENLIST_UA,
          "X-Request-ID": uuid(),
        },
      },
    )
    const sessJson = tryJson(sessText)
    const err = apiError(sessText, sessJson)
    if (err) throw new Error(`[189CloudPC] 获取 Session 失败: ${err}`)
    const sess = parseSession(sessText)
    if (!sess?.sessionKey && !sessJson?.accessToken) {
      throw new Error(
        `[189CloudPC] 登录后未获得 session（${sessText.slice(0, 180)}）`,
      )
    }
    this.session = {
      sessionKey: sess?.sessionKey || "",
      sessionSecret: sess?.sessionSecret || "",
      familySessionKey: sess?.familySessionKey,
      familySessionSecret: sess?.familySessionSecret,
      loginName: sess?.loginName,
      accessToken: sess?.accessToken || sessJson?.accessToken,
      refreshToken: sess?.refreshToken || sessJson?.refreshToken,
    }
    if (!this.session.sessionKey && this.session.accessToken) {
      await this.refreshSession()
    }
    await this.persistTokens(
      this.session.accessToken,
      this.session.refreshToken,
    )
  }

  private sessionPair(isFamily: boolean): { key: string; secret: string } {
    if (!this.session?.sessionKey || !this.session.sessionSecret) {
      throw new Error("[189CloudPC] 未登录")
    }
    if (isFamily) {
      return {
        key: this.session.familySessionKey || this.session.sessionKey,
        secret: this.session.familySessionSecret || this.session.sessionSecret,
      }
    }
    return {
      key: this.session.sessionKey,
      secret: this.session.sessionSecret,
    }
  }

  private async request(
    url: string,
    method: "GET" | "POST",
    options: {
      query?: Record<string, string>
      form?: Record<string, string>
      encryptedParams?: Record<string, string>
      isFamily?: boolean
      retried?: boolean
    } = {},
  ): Promise<{ text: string; json: any | null }> {
    const isFamily = !!options.isFamily
    const { key, secret } = this.sessionPair(isFamily)

    const q = new URLSearchParams(clientSuffix())
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null) q.set(k, v)
      }
    }
    let paramsData = ""
    if (options.encryptedParams) {
      paramsData = aes128EcbEncryptUpper(
        encodeParams(options.encryptedParams),
        secret.slice(0, 16),
      )
      q.set("params", paramsData)
    }
    const fullUrl = `${url}?${q.toString()}`
    const dateOfGmt = getHttpDateStr()
    const headers: Record<string, string> = {
      Accept: "application/json;charset=UTF-8",
      Referer: WEB_URL,
      "User-Agent": OPENLIST_UA,
      Date: dateOfGmt,
      SessionKey: key,
      "X-Request-ID": uuid(),
      Signature: signatureOfHmac(
        secret,
        key,
        method,
        url,
        dateOfGmt,
        paramsData,
      ),
    }
    let body: string | undefined
    if (options.form) {
      headers["Content-Type"] =
        "application/x-www-form-urlencoded; charset=UTF-8"
      body = new URLSearchParams(options.form).toString()
    }

    const { res, text } = await fetchWithRetry(fullUrl, {
      method,
      headers,
      body,
    })
    const json = tryJson(text)
    if (
      text.includes("userSessionBO is null") ||
      text.includes("InvalidSessionKey")
    ) {
      if (!options.retried) {
        await this.refreshSession()
        return this.request(url, method, { ...options, retried: true })
      }
    }
    const err = apiError(text, json)
    if (err) throw new Error(`[189CloudPC] ${err}`)
    if (isTransient189(res.status, text) || (res.status >= 400 && !json)) {
      throw new Error(`[189CloudPC] HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return { text, json }
  }

  private async get(
    url: string,
    query?: Record<string, string>,
    isFamily = false,
  ) {
    return this.request(url, "GET", { query, isFamily })
  }

  private async post(
    url: string,
    query?: Record<string, string>,
    form?: Record<string, string>,
    isFamily = false,
  ) {
    return this.request(url, "POST", { query, form, isFamily })
  }

  private parseList(
    text: string,
    json: any | null,
  ): {
    files: Cloud189PcFile[]
    folders: Cloud189PcFolder[]
    count: number
  } {
    if (json?.fileListAO) {
      const ao = json.fileListAO
      return {
        files: ao.fileList || [],
        folders: ao.folderList || [],
        count: ao.count ?? 0,
      }
    }
    const files = xmlTags(text, "file")
      .map(parseFileXml)
      .filter((f) => f.id)
    const folders = xmlTags(text, "folder")
      .map(parseFolderXml)
      .filter((f) => f.id)
    const countStr = xmlTag(text, "count")
    const count = Number(countStr || files.length + folders.length)
    return {
      files,
      folders,
      count: Number.isFinite(count) ? count : files.length + folders.length,
    }
  }

  async getFiles(
    folderId: string,
    options?: { findName?: string; findIsDir?: boolean },
  ): Promise<{ files: Cloud189PcFile[]; folders: Cloud189PcFolder[] }> {
    const isFamily = this.isFamily()
    const allFiles: Cloud189PcFile[] = []
    const allFolders: Cloud189PcFolder[] = []
    const orderBy = this.addition.order_by || "filename"
    const descending =
      (this.addition.order_direction || "asc") === "desc" ? "true" : "false"
    const familyOrder =
      orderBy === "filesize" ? "2" : orderBy === "lastOpTime" ? "3" : "1"

    for (let pageNum = 1; ; pageNum++) {
      let url = API_URL
      if (isFamily) url += "/family/file"
      url += "/listFiles.action"
      const query: Record<string, string> = {
        folderId: folderId || this.getRootId(),
        fileType: "0",
        mediaAttr: "0",
        iconOption: "5",
        pageNum: String(pageNum),
        pageSize: "1000",
      }
      if (isFamily) {
        query.familyId = this.getFamilyId()
        query.orderBy = familyOrder
        query.descending = descending
      } else {
        query.recursive = "0"
        query.orderBy = orderBy
        query.descending = descending
      }
      const { text, json } = await this.get(url, query, isFamily)
      const parsed = this.parseList(text, json)
      if (
        parsed.count === 0 &&
        parsed.files.length === 0 &&
        parsed.folders.length === 0
      ) {
        break
      }
      allFiles.push(...parsed.files)
      allFolders.push(...parsed.folders)
      if (options?.findName) {
        if (
          options.findIsDir &&
          parsed.folders.some((f) => f.name === options.findName)
        ) {
          break
        }
        if (
          !options.findIsDir &&
          parsed.files.some((f) => f.name === options.findName)
        ) {
          break
        }
      }
      if (parsed.files.length + parsed.folders.length < 1000) break
    }
    return { files: allFiles, folders: allFolders }
  }

  async getDownloadUrl(fileId: string): Promise<string> {
    const isFamily = this.isFamily()
    let url = API_URL
    if (isFamily) url += "/family/file"
    url += "/getFileDownloadUrl.action"
    const query: Record<string, string> = { fileId }
    if (isFamily) query.familyId = this.getFamilyId()
    else {
      query.dt = "3"
      query.flag = "1"
    }
    const { text, json } = await this.get(url, query, isFamily)
    let raw =
      json?.fileDownloadUrl ||
      json?.URL ||
      xmlTag(text, "fileDownloadUrl") ||
      xmlTag(text, "fileDownloadUrl".toLowerCase())
    if (!raw) {
      throw new Error(`[189CloudPC] 获取下载地址失败 (fileId: ${fileId})`)
    }
    raw = raw.replace(/&amp;/g, "&").replace(/^http:\/\//i, "https://")
    try {
      const probe = await fetch(raw, {
        method: "GET",
        headers: { "User-Agent": OPENLIST_UA },
        redirect: "manual",
      })
      const loc = probe.headers.get("location")
      if ((probe.status === 302 || probe.status === 301) && loc) {
        raw = loc.replace(/^http:\/\//i, "https://")
      }
    } catch {
      /* 回退原始 URL */
    }
    return raw
  }

  async mkdir(parentFolderId: string, folderName: string): Promise<void> {
    const isFamily = this.isFamily()
    let url = API_URL
    if (isFamily) url += "/family/file"
    url += "/createFolder.action"
    const query: Record<string, string> = {
      folderName,
      relativePath: "",
    }
    if (isFamily) {
      query.familyId = this.getFamilyId()
      query.parentId = parentFolderId || this.getRootId()
    } else {
      query.parentFolderId = parentFolderId || this.getRootId()
    }
    await this.post(url, query, undefined, isFamily)
  }

  async rename(id: string, isFolder: boolean, newName: string): Promise<void> {
    const isFamily = this.isFamily()
    let url = API_URL
    const method: "GET" | "POST" = isFamily ? "GET" : "POST"
    if (isFamily) url += "/family/file"
    url += isFolder ? "/renameFolder.action" : "/renameFile.action"
    const query: Record<string, string> = isFolder
      ? { folderId: id, destFolderName: newName }
      : { fileId: id, destFileName: newName }
    if (isFamily) query.familyId = this.getFamilyId()
    await this.request(url, method, { query, isFamily })
  }

  private async createBatchTask(
    type: "MOVE" | "COPY" | "DELETE",
    items: Array<{ id: string; name: string; isFolder: boolean }>,
    targetFolderId = "",
  ): Promise<string> {
    const isFamily = this.isFamily()
    const form: Record<string, string> = {
      type,
      taskInfos: JSON.stringify(
        items.map((it) => ({
          fileId: it.id,
          fileName: it.name,
          isFolder: it.isFolder ? 1 : 0,
        })),
      ),
    }
    if (targetFolderId) form.targetFolderId = targetFolderId
    if (isFamily) form.familyId = this.getFamilyId()
    const { text, json } = await this.post(
      `${API_URL}/batch/createBatchTask.action`,
      undefined,
      form,
      isFamily,
    )
    return json?.taskId || xmlTag(text, "taskId") || ""
  }

  private async waitBatchTask(type: string, taskId: string): Promise<void> {
    if (!taskId) return
    for (let i = 0; i < 30; i++) {
      const { text, json } = await this.post(
        `${API_URL}/batch/checkBatchTask.action`,
        undefined,
        { type, taskId },
      )
      const status = Number(
        json?.taskStatus ?? xmlTag(text, "taskStatus") ?? "4",
      )
      if (status === 4) return
      if (status === 2) throw new Error("[189CloudPC] 批量任务存在冲突")
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  async move(
    fileId: string,
    isFolder: boolean,
    fileName: string,
    targetFolderId: string,
  ): Promise<void> {
    const taskId = await this.createBatchTask(
      "MOVE",
      [{ id: fileId, name: fileName, isFolder }],
      targetFolderId,
    )
    await this.waitBatchTask("MOVE", taskId)
  }

  async copy(
    fileId: string,
    isFolder: boolean,
    fileName: string,
    targetFolderId: string,
  ): Promise<void> {
    const taskId = await this.createBatchTask(
      "COPY",
      [{ id: fileId, name: fileName, isFolder }],
      targetFolderId,
    )
    await this.waitBatchTask("COPY", taskId)
  }

  async remove(
    fileId: string,
    isFolder: boolean,
    fileName: string,
  ): Promise<void> {
    const taskId = await this.createBatchTask("DELETE", [
      { id: fileId, name: fileName, isFolder },
    ])
    await this.waitBatchTask("DELETE", taskId)
  }

  private async getFamilyID(): Promise<string> {
    const { text, json } = await this.get(
      `${API_URL}/family/manage/getFamilyList.action`,
      undefined,
      true,
    )
    const list = json?.familyInfoResp || []
    if (Array.isArray(list) && list.length) {
      const login = this.session?.loginName || ""
      const hit = list.find((i: any) => login.includes(i.remarkName || ""))
      return String((hit || list[0]).familyId)
    }
    const ids = xmlTags(text, "familyId")
    if (!ids.length) throw new Error("[189CloudPC] 无法自动获取 family_id")
    return ids[0]
  }

  private async createFamilyTransferFolder(): Promise<void> {
    await this.post(
      `${API_URL}/family/file/createFolder.action`,
      {
        folderName: "FamilyTransferFolder",
        familyId: this.getFamilyId(),
      },
      undefined,
      true,
    )
  }

  async upload(
    parentFolderId: string,
    fileName: string,
    content: Buffer,
  ): Promise<void> {
    if (content.length < 1) {
      throw new Error("[189CloudPC] 不允许上传空文件")
    }
    const isFamily = this.isFamily()
    const fileSize = content.length
    const sliceSize = Math.min(10 * 1024 * 1024, Math.max(fileSize, 1))
    const params: Record<string, string> = {
      parentFolderId: parentFolderId || this.getRootId(),
      fileName: encodeURIComponent(fileName),
      fileSize: String(fileSize),
      sliceSize: String(sliceSize),
      lazyCheck: "1",
    }
    let fullUrl = UPLOAD_URL
    if (isFamily) {
      params.familyId = this.getFamilyId()
      fullUrl += "/family"
    } else {
      fullUrl += "/person"
    }
    const init = await this.request(fullUrl + "/initMultiUpload", "GET", {
      encryptedParams: params,
      isFamily,
    })
    const data = init.json?.data || {}
    if (data.fileDataExists) return
    const uploadFileId = data.uploadFileId
    if (!uploadFileId) {
      throw new Error(`[189CloudPC] 上传初始化失败: ${init.text.slice(0, 180)}`)
    }
    const partCount = Math.ceil(fileSize / sliceSize) || 1
    const fileMd5Hex = md5(content).toUpperCase()
    const sliceMd5Hexs: string[] = []
    for (let i = 0; i < partCount; i++) {
      const start = i * sliceSize
      const end = Math.min(start + sliceSize, fileSize)
      const part = content.subarray(start, end)
      const partMd5Hex = md5(part)
      sliceMd5Hexs.push(partMd5Hex.toUpperCase())
      const md5Bytes = hexToBytes(partMd5Hex)
      const partInfo = `${i + 1}-${bytesToBase64(md5Bytes)}`
      const urls = await this.request(fullUrl + "/getMultiUploadUrls", "GET", {
        encryptedParams: { uploadFileId, partInfo },
        isFamily,
      })
      const uploadUrls = urls.json?.uploadUrls || urls.json?.data || {}
      const first = Object.values(uploadUrls)[0] as any
      if (!first?.requestURL) {
        throw new Error(`[189CloudPC] 缺少第 ${i + 1} 片上传地址`)
      }
      const headers: Record<string, string> = {}
      if (first.requestHeader) {
        for (const h of String(first.requestHeader).split("&")) {
          const idx = h.indexOf("=")
          if (idx > 0) headers[h.slice(0, idx)] = h.slice(idx + 1)
        }
      }
      const putRes = await fetch(first.requestURL, {
        method: "PUT",
        headers,
        body: part as unknown as BodyInit,
      })
      if (!putRes.ok) {
        throw new Error(
          `[189CloudPC] 分片 ${i + 1} 上传失败 (HTTP ${putRes.status})`,
        )
      }
    }
    const sliceMd5 =
      fileSize > sliceSize
        ? md5(sliceMd5Hexs.join("\n")).toUpperCase()
        : fileMd5Hex
    await this.request(fullUrl + "/commitMultiUploadFile", "GET", {
      encryptedParams: {
        uploadFileId,
        fileMd5: fileMd5Hex,
        sliceMd5,
        lazyCheck: "1",
        isLog: "0",
        opertype: "3",
      },
      isFamily,
    })
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export { parse189Time }
