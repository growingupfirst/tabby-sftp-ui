import { Injectable } from '@angular/core'
import { HotkeyProvider } from 'tabby-core'

@Injectable()
export class SftpUiHotkeyProvider extends HotkeyProvider {
  async provide (): Promise<Array<{ id: string, name: string }>> {
    return [
      { id: 'open-sftp-ui', name: 'Open SFTP UI' },
    ]
  }
}

