import * as fs from 'fs'
import * as path from 'path'

import { FileDownload, FileUpload } from 'tabby-core'

export class LocalPathFileUpload extends FileUpload {
  private fd: number | null = null
  private position = 0

  constructor (private filePath: string) {
    super()
  }

  getName (): string {
    return path.basename(this.filePath)
  }

  getMode (): number {
    return 0o644
  }

  getSize (): number {
    try {
      return fs.statSync(this.filePath).size
    } catch {
      return 0
    }
  }

  async read (): Promise<Buffer> {
    if (this.isCancelled()) {
      return Buffer.alloc(0)
    }
    if (this.fd === null) {
      this.fd = fs.openSync(this.filePath, 'r')
    }
    const buf = Buffer.allocUnsafe(256 * 1024)
    const bytesRead = fs.readSync(this.fd, buf, 0, buf.length, this.position)
    if (!bytesRead) {
      return Buffer.alloc(0)
    }
    this.position += bytesRead
    this.increaseProgress(bytesRead)
    return buf.subarray(0, bytesRead)
  }

  close (): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {
        // ignore
      }
      this.fd = null
    }
  }
}

export class LocalPathFileDownload extends FileDownload {
  private fd: number | null = null

  constructor (private targetPath: string, private mode: number, private size: number) {
    super()
  }

  getName (): string {
    return path.basename(this.targetPath)
  }

  getMode (): number {
    return this.mode
  }

  getSize (): number {
    return this.size
  }

  async write (buffer: Buffer): Promise<void> {
    if (this.isCancelled()) {
      return
    }
    if (this.fd === null) {
      this.fd = fs.openSync(this.targetPath, 'w')
    }
    fs.writeSync(this.fd, buffer)
    this.increaseProgress(buffer.length)
  }

  close (): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {
        // ignore
      }
      this.fd = null
    }
  }
}

