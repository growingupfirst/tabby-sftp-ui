import { Injectable } from '@angular/core'
import { TabContextMenuItemProvider } from 'tabby-core'

import { SftpUiService } from './sftp-ui.service'

@Injectable()
export class SftpContextMenuProvider extends TabContextMenuItemProvider {
  constructor (
    private sftpUi: SftpUiService,
  ) {
    super()
  }

  async getItems (): Promise<Array<{ label: string, click: () => void }>> {
    return [
      {
        label: 'Open SFTP UI',
        click: () => this.sftpUi.open(),
      },
    ]
  }
}

