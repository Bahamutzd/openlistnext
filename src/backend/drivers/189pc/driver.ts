// 189CloudPC 驱动（天翼云盘 PC 版）
// 复用 189 驱动实现，支持 access_token 登录模式（无需账号密码）。

import { StorageDriver, FileItem } from "../../internal/driver/base"
import { Cloud189Driver } from "../189/driver"
import { Cloud189PcAddition } from "./types"

export class Cloud189PcDriver implements StorageDriver {
  private inner: Cloud189Driver

  constructor(addition: Cloud189PcAddition) {
    // 直接复用 189 驱动，传入 access_token
    this.inner = new Cloud189Driver(addition as any)
  }

  async init(): Promise<void> {
    await this.inner.init()
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    return this.inner.list(virtualPath, physicalPath)
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    return this.inner.get(virtualPath, physicalPath)
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    return this.inner.mkdir(virtualPath, physicalPath)
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    return this.inner.rename(virtualPath, physicalPath, newName)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    return this.inner.remove(virtualPath, physicalPath, names)
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    return this.inner.move(srcDir, dstDir, names, srcPhys, dstPhys)
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    return this.inner.copy(srcDir, dstDir, names, srcPhys, dstPhys)
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    return this.inner.put(virtualPath, physicalPath, content)
  }
}
