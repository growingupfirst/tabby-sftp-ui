import { Injectable } from '@angular/core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'

import { SftpUiService } from './sftp-ui.service'

@Injectable()
export class SftpTerminalDecorator extends TerminalDecorator {
  constructor (
    private sftpUi: SftpUiService,
  ) {
    super()
  }

  override attach (terminal: BaseTerminalTabComponent): void {
    super.attach(terminal)

    // Best-effort DOM injection: place button near the existing Reconnect button if present.
    const tryInsert = () => {
      try {
        const host: HTMLElement | null = terminal.element?.nativeElement ?? null
        if (!host) {
          return false
        }

        // Find a likely toolbar area in the tab UI
        const toolbar =
          (host.querySelector('.terminal-toolbar') as HTMLElement | null) ??
          (host.querySelector('terminal-toolbar') as HTMLElement | null) ??
          (host.querySelector('.btn-toolbar') as HTMLElement | null)

        const container = toolbar ?? host

        if (container.querySelector('[data-tabby-sftp-ui-button="1"]')) {
          return true
        }

        const btn = document.createElement('button')
        btn.type = 'button'
        // Match Tabby's terminal toolbar buttons styling
        btn.className = 'btn btn-sm btn-link me-2'
        btn.setAttribute('data-tabby-sftp-ui-button', '1')
        btn.title = 'SFTP-UI'
        btn.textContent = 'SFTP-UI'
        btn.style.pointerEvents = 'auto'
        btn.style.zIndex = '10'
        btn.style.position = 'relative'
        btn.addEventListener('mousedown', (ev) => {
          ev.stopPropagation()
        })
        btn.addEventListener('click', (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          this.sftpUi.openForSourceTab(terminal as any)
        })

        // If there's a Reconnect button, insert next to it.
        const allButtons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
        const reconnectButton = allButtons.find(b => {
          const t = `${b.textContent ?? ''} ${b.title ?? ''} ${b.getAttribute('aria-label') ?? ''}`.toLowerCase()
          return t.includes('reconnect') || t.includes('переподключ')
        })

        if (reconnectButton?.parentElement) {
          // Put it right after Reconnect to avoid overlay issues
          reconnectButton.parentElement.insertBefore(btn, reconnectButton.nextSibling)
        } else {
          container.appendChild(btn)
        }

        return true
      } catch {
        return false
      }
    }

    // try a few times while the view is settling
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      if (tryInsert() || attempts > 20) {
        clearInterval(timer)
      }
    }, 500)

    this.subscribeUntilDetached(terminal, { unsubscribe: () => clearInterval(timer) } as any)
  }
}

