// WebDAV 服务端路由（/dav）
// 对齐原版 OpenList：Basic Auth + 权限位控制读写，PROPFIND / GET / PUT /
// MKCOL / DELETE / MOVE / COPY / LOCK / UNLOCK，根路径挂 /dav。

import { Hono } from "hono"
import {
  parseBasicAuth,
  verifyDavUser,
  canDavRead,
} from "../internal/webdav/auth"
import {
  handlePropfind,
  handleGet,
  handlePut,
  handleMkcol,
  handleDelete,
  handleMove,
  handleCopy,
  davError,
} from "../internal/webdav/methods"
import { toVirtualPath } from "../internal/webdav/methods"

export const davRouter = new Hono()

/** Basic Auth 中间件：失败返回 401 + WWW-Authenticate */
async function davAuth(c: any, next: () => Promise<void>) {
  const creds = parseBasicAuth(c.req.header("Authorization"))
  if (!creds) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="OpenListNext"' },
    })
  }
  const user = await verifyDavUser(creds.username, creds.password)
  if (!user) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="OpenListNext"' },
    })
  }
  c.set("davUser", user)
  await next()
}

davRouter.use("*", davAuth)

// OPTIONS：声明支持的 DAV 能力（Windows 资源管理器 / rclone 会先探测）
davRouter.options("*", (c) => {
  return new Response(null, {
    status: 200,
    headers: {
      DAV: "1, 2",
      Allow:
        "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK",
      "Content-Length": "0",
    },
  })
})

davRouter.on("PROPFIND", "/*", (c) => {
  const user = c.get("davUser")
  const reqPath = c.req.path.replace(/^\/dav/, "") || "/"
  return handlePropfind(
    c,
    reqPath === "" ? "/" : reqPath,
    user,
    c.req.header("Depth"),
    null,
  )
})

davRouter.get("/*", (c) => {
  const user = c.get("davUser")
  const reqPath = c.req.path.replace(/^\/dav/, "") || "/"
  return handleGet(c, reqPath === "" ? "/" : reqPath, user, false)
})

davRouter.on("HEAD", "/*", (c) => {
  const user = c.get("davUser")
  const reqPath = c.req.path.replace(/^\/dav/, "") || "/"
  return handleGet(c, reqPath === "" ? "/" : reqPath, user, true)
})

davRouter.put("/*", (c) => {
  const user = c.get("davUser")
  const reqPath = c.req.path.replace(/^\/dav/, "") || "/"
  return handlePut(c, reqPath === "" ? "/" : reqPath, user)
})

davRouter.on("MKCOL", "/*", (c) => {
  const user = c.get("davUser")
  const reqPath = c.req.path.replace(/^\/dav/, "") || "/"
  return handleMkcol(c, reqPath === "" ? "/" : reqPath, user)
})

davRouter.delete("/*", (c) => {
  const user = c.get("davUser")
  const reqPath = c.req.path.replace(/^\/dav/, "") || "/"
  return handleDelete(c, reqPath === "" ? "/" : reqPath, user)
})

davRouter.on("MOVE", "/*", (c) => {
  const user = c.get("davUser")
  const reqPath = c.req.path.replace(/^\/dav/, "") || "/"
  return handleMove(
    c,
    reqPath === "" ? "/" : reqPath,
    user,
    c.req.header("Destination"),
  )
})

davRouter.on("COPY", "/*", (c) => {
  const user = c.get("davUser")
  const reqPath = c.req.path.replace(/^\/dav/, "") || "/"
  return handleCopy(
    c,
    reqPath === "" ? "/" : reqPath,
    user,
    c.req.header("Destination"),
  )
})

// LOCK / UNLOCK：假锁定（生成固定 token，不真正锁文件）
davRouter.on("LOCK", "/*", (c) => {
  if (!canDavRead(c.get("davUser"))) return davError(403)
  const token = `opaquelocktoken:${Math.random().toString(36).slice(2)}`
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock>` +
      `<d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope>` +
      `<d:depth>infinity</d:depth><d:timeout>Second-3600</d:timeout>` +
      `<d:locktoken><d:href>${token}</d:href></d:locktoken>` +
      `<d:lockroot><d:href>${c.req.path}</d:href></d:lockroot>` +
      `</d:activelock></d:lockdiscovery></d:prop>`,
    {
      status: 200,
      headers: {
        "Content-Type": 'application/xml; charset="utf-8"',
        LockToken: `<${token}>`,
      },
    },
  )
})

davRouter.on("UNLOCK", "/*", (c) => new Response(null, { status: 204 }))

// PROPPATCH：空成功，避免 Windows 卡死
davRouter.on("PROPPATCH", "/*", (c) => {
  return new Response(
    '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>' +
      (c.req.path || "/dav/") +
      "</d:href><d:propstat><d:prop></d:prop><d:status>HTTP/1.1 200 OK</d:status>" +
      "</d:propstat></d:response></d:multistatus>",
    {
      status: 207,
      headers: { "Content-Type": 'application/xml; charset="utf-8"' },
    },
  )
})
