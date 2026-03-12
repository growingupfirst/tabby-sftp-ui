import { Injectable } from '@angular/core'

export type SFTPFile = {
  name: string
  fullPath: string
  isDirectory: boolean
  isSymlink: boolean
  mode: number
  size: number
  modified: Date
}

export type SFTPSessionLike = {
  readdir: (p: string) => Promise<SFTPFile[]>
  mkdir: (p: string) => Promise<void>
  rmdir: (p: string) => Promise<void>
  unlink: (p: string) => Promise<void>
  rename: (oldPath: string, newPath: string) => Promise<void>
  upload: (remotePath: string, transfer: import('tabby-core').FileUpload) => Promise<void>
  download: (remotePath: string, transfer: import('tabby-core').FileDownload) => Promise<void>
}

export type SSHSessionLike = {
  openSFTP: () => Promise<SFTPSessionLike>
}

@Injectable({ providedIn: 'root' })
export class SftpConnectionService {
  async openFromSSHSession (sshSession: SSHSessionLike): Promise<SFTPSessionLike> {
    return await sshSession.openSFTP()
  }
}

