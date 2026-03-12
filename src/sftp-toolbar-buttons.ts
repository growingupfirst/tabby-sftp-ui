import { Injectable } from '@angular/core'
import { AppService, ToolbarButton, ToolbarButtonProvider } from 'tabby-core'

import { SftpManagerTabComponent } from './sftp-manager-tab.component'

@Injectable()
export class SftpToolbarButtons extends ToolbarButtonProvider {
  constructor (
    private app: AppService,
  ) {
    super()
  }

  provide (): ToolbarButton[] {
    return [
      {
        title: 'SFTP',
        weight: 10,
        icon: `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7h5l2 2h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>
            <path d="M12 12v6"/>
            <path d="M9 15l3 3 3-3"/>
          </svg>
        `,
        click: () => {
          const tab = this.app.openNewTab({
            type: SftpManagerTabComponent,
          })
          tab.setTitle('SFTP')
        },
      },
    ]
  }
}

