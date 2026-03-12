import { Injectable, NgZone } from '@angular/core'
import { AppService, HotkeysService, LogService, NotificationsService, SplitTabComponent } from 'tabby-core'

import { SftpManagerTabComponent } from './sftp-manager-tab.component'

@Injectable()
export class SftpUiService {
  private logger: any

  constructor (
    private app: AppService,
    private hotkeys: HotkeysService,
    private log: LogService,
    private zone: NgZone,
    private notifications: NotificationsService,
  ) {
    this.logger = this.log.create('sftp-ui')

    this.hotkeys.hotkey$.subscribe(h => {
      if (h === 'open-sftp-ui') {
        this.open()
      }
    })

    this.logger.info('loaded')
  }

  open (): void {
    const active = this.app.activeTab
    const focused = active instanceof SplitTabComponent ? (active.getFocusedTab?.() ?? null) : active
    this.openForSourceTab(focused)
  }

  openForSourceTab (sourceTab: any): void {
    const sshSession = sourceTab?.sshSession ?? null
    const profile = sourceTab?.profile ?? null

    this.zone.run(() => {
      try {
        if (!sshSession) {
          this.notifications.error('SFTP-UI', 'No SSH session on current tab')
          return
        }
        const baseTitle =
          sourceTab?.customTitle ||
          sourceTab?.title ||
          profile?.name ||
          profile?.options?.host ||
          'SFTP'
        const tab = this.app.openNewTab({
          type: SftpManagerTabComponent,
          inputs: {
            sshSession,
            profile,
          },
        })
        tab.setTitle(`${baseTitle} + SFTP`)
        this.notifications.notice('SFTP-UI opened')
      } catch (e) {
        this.notifications.error('SFTP-UI failed to open', String(e))
        this.logger.error('openForSourceTab failed', e)
      }
    })
  }
}

