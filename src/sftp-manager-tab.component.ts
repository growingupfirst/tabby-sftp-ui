import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as crypto from 'crypto'

import { Component, Injector, OnInit, HostListener } from '@angular/core'
import { AppService, BaseTabComponent, FileTransfer, FileUpload, PlatformService, ProfilesService } from 'tabby-core'

import { LocalPathFileDownload, LocalPathFileUpload } from './local-transfers'
import { SftpConnectionService, SFTPFile, SFTPSessionLike, SSHSessionLike } from './sftp.service'

type LocalEntry = {
  name: string
  fullPath: string
  isDirectory: boolean
  size?: number
  mtimeMs?: number
}

type DragPayload =
  | { kind: 'local-file', fullPath: string, name: string }
  | { kind: 'remote-file', remotePath: string, name: string, size: number, mode: number }
  | { kind: 'remote-dir', remotePath: string, name: string }

@Component({
  selector: 'tabby-sftp-manager-tab',
  template: `
    <div class="sftp-root" tabindex="0" (keydown)="onKeyDown($event)">
      <div class="top-profiles" *ngIf="profile || recentProfiles.length">
        <div class="current" *ngIf="profile">
          <span class="label">Device:</span>
          <span class="value">{{ getProfileLabel(profile) }}</span>
        </div>
        <div class="recent" *ngIf="recentProfiles.length">
          <span class="label">Recent:</span>
          <button
            class="profile-chip"
            *ngFor="let p of recentProfiles"
            (click)="launchProfileFromSFTP(p)"
          >
            {{ getProfileLabel(p) }}
          </button>
        </div>
      </div>
      <div class="sftp-body">
        <div class="pane">
          <div class="pane-title">
            <div class="pane-label">Local</div>
            <div class="pane-path">
              <input
                [(ngModel)]="localPathInput"
                (keyup.enter)="goToLocalPathInput()"
              />
            </div>
            <div class="pane-actions">
              <select class="path-preset" (change)="onLocalPresetChange($event.target.value)">
                <option value="">Go to…</option>
                <option *ngFor="let p of localPathPresets" [value]="p.id">
                  {{ p.label }}
                </option>
              </select>
              <button
                class="fav-toggle"
                [class.active]="isCurrentFavorite()"
                (click)="toggleCurrentFavorite()"
                title="Toggle favorite for this path"
              >
                ★
              </button>
              <select class="path-favorite" (change)="onLocalFavoriteSelect($event.target.value)">
                <option value="">Favorites…</option>
                <option *ngFor="let f of localFavorites" [value]="f.id">
                  {{ f.label }}
                </option>
              </select>
              <button (click)="localUp()" [disabled]="!canLocalUp()">Up</button>
              <button (click)="goToLocalPathInput()">Go</button>
              <button (click)="refreshLocal()">Refresh</button>
            </div>
          </div>
          <div class="pane-filters">
            <div class="breadcrumbs">
              <ng-container *ngFor="let part of getLocalBreadcrumbs(); let i = index; let last = last">
                <button
                  class="crumb-button"
                  (click)="navigateLocalBreadcrumb(i)"
                  (contextmenu)="onLocalBreadcrumbContextMenu(i, $event)"
                >
                  {{ part.label }}
                </button>
                <span class="crumb-separator" *ngIf="!last">›</span>
              </ng-container>
            </div>
            <input [(ngModel)]="localFilter" placeholder="Filter files..." />
            <label class="show-hidden-toggle">
              <input type="checkbox" [(ngModel)]="showHiddenLocal" />
              <span>Show hidden</span>
            </label>
          </div>
          <div class="pane-list"
            (dragover)="onDragOver($event)"
            (drop)="onDropOnLocal($event)"
          >
            <div class="entry header">
              <span class="icon"></span>
              <span class="name sortable" (click)="setLocalSort('name')">Name</span>
              <span class="size sortable" (click)="setLocalSort('size')">Size</span>
              <span class="date sortable" (click)="setLocalSort('modified')">Modified</span>
            </div>
            <div
              class="entry"
              *ngIf="canLocalUp()"
              (dblclick)="localUp()"
            >
              <span class="icon">⬆</span>
              <span class="name">Go up</span>
              <span class="size"></span>
              <span class="date"></span>
            </div>
            <div
              class="entry"
              *ngFor="let e of getFilteredLocalEntries()"
              (click)="selectLocal(e, $event)"
              (dblclick)="openLocal(e)"
              (mousedown)="onLocalMouseDown(e, $event)"
              (contextmenu)="onLocalContextMenu(e, $event)"
              (dragover)="onLocalEntryDragOver(e, $event)"
              (drop)="onLocalEntryDrop(e, $event)"
              [class.drop-target]="localDropActive"
              [class.selected]="isLocalSelected(e)"
              [draggable]="true"
              (dragstart)="onDragStartLocal($event, e)"
            >
              <span class="icon">{{ e.isDirectory ? '📁' : '📄' }}</span>
              <span class="name">{{ e.name }}</span>
              <span class="size">{{ getLocalSizeDisplay(e) }}</span>
              <span class="date">{{ e.mtimeMs ? (e.mtimeMs | date:'yyyy-MM-dd HH:mm') : '' }}</span>
            </div>
          </div>
          <div class="pane-actions-bar">
            <div class="selection" *ngIf="selectedLocal.length">
              Selected: {{ selectedLocal.length === 1 ? selectedLocal[0].name : (selectedLocal.length + ' items') }}
            </div>
            <div class="action-inputs">
              <input [(ngModel)]="localActionName" placeholder="Name / new name" />
              <input [(ngModel)]="localActionPerms" placeholder="Perms (e.g. 755)" />
            </div>
            <div class="action-buttons">
              <button (click)="localRename()" [disabled]="selectedLocal.length !== 1">Rename</button>
              <button (click)="refreshLocal()">Refresh</button>
              <button (click)="localDelete()" [disabled]="!selectedLocal.length">Delete</button>
              <button (click)="localNewFolder()">New Folder</button>
              <button (click)="localEditPermissions()" [disabled]="selectedLocal.length !== 1 || !localActionPerms">Edit Permissions</button>
              <button (click)="localShowSize()" [disabled]="selectedLocal.length !== 1 || !selectedLocal[0].isDirectory">Show Size</button>
            </div>
          </div>
        </div>

        <div class="pane">
          <div class="pane-title">
            <div class="pane-label">
              Remote
              <span *ngIf="connected && profile?.options?.host" class="pane-sub">
                — {{ profile.options.host }}
              </span>
            </div>
            <div class="pane-path">
              <input
                [(ngModel)]="remotePathInput"
                (keyup.enter)="goToRemotePathInput()"
                [disabled]="!connected"
              />
            </div>
            <div class="pane-actions">
              <button (click)="remoteUp()" [disabled]="!connected || remotePath === '/'">Up</button>
              <button (click)="goToRemotePathInput()" [disabled]="!connected">Go</button>
              <button (click)="refreshRemote()" [disabled]="!connected">Refresh</button>
            </div>
          </div>
          <div class="pane-filters">
            <div class="breadcrumbs" *ngIf="connected">
              <ng-container *ngFor="let part of getRemoteBreadcrumbs(); let i = index; let last = last">
                <button
                  class="crumb-button"
                  (click)="navigateRemoteBreadcrumb(i)"
                >
                  {{ part.label }}
                </button>
                <span class="crumb-separator" *ngIf="!last">›</span>
              </ng-container>
            </div>
            <input [(ngModel)]="remoteFilter" placeholder="Filter files..." />
            <label class="show-hidden-toggle">
              <input type="checkbox" [(ngModel)]="showHiddenRemote" />
              <span>Show hidden</span>
            </label>
          </div>
          <div class="pane-list"
            (dragover)="onDragOver($event)"
            (drop)="onDropOnRemote($event)"
          >
            <div class="entry dim" *ngIf="!connected">
              <span class="name">Not connected</span>
            </div>
            <div class="entry header" *ngIf="connected">
              <span class="icon"></span>
              <span class="name sortable" (click)="setRemoteSort('name')">Name</span>
              <span class="size sortable" (click)="setRemoteSort('size')">Size</span>
              <span class="date sortable" (click)="setRemoteSort('modified')">Modified</span>
            </div>
            <div
              class="entry"
              *ngIf="connected && remotePath !== '/'"
              (dblclick)="remoteUp()"
            >
              <span class="icon">⬆</span>
              <span class="name">Go up</span>
              <span class="size"></span>
              <span class="date"></span>
            </div>
            <div
              class="entry"
              *ngFor="let e of getFilteredRemoteEntries()"
              (click)="selectRemote(e, $event)"
              (dblclick)="openRemote(e)"
              (mousedown)="onRemoteMouseDown(e, $event)"
              (contextmenu)="onRemoteContextMenu(e, $event)"
              (dragover)="onRemoteEntryDragOver(e, $event)"
              (drop)="onRemoteEntryDrop(e, $event)"
              [class.drop-target]="remoteDropActive"
              [class.selected]="isRemoteSelected(e)"
              [draggable]="connected"
              (dragstart)="onDragStartRemote($event, e)"
            >
              <span class="icon">{{ e.isDirectory ? '📁' : '📄' }}</span>
              <span class="name">{{ e.name }}</span>
              <span class="size">{{ getRemoteSizeDisplay(e) }}</span>
              <span class="date">{{ e.modified | date:'yyyy-MM-dd HH:mm' }}</span>
            </div>
          </div>
          <div class="pane-actions-bar">
            <div class="selection" *ngIf="selectedRemote.length">
              Selected: {{ selectedRemote.length === 1 ? selectedRemote[0].name : (selectedRemote.length + ' items') }}
            </div>
            <div class="action-inputs">
              <input [(ngModel)]="remoteActionName" placeholder="Name / new name" />
              <input [(ngModel)]="remoteActionPerms" placeholder="Perms (e.g. 755)" />
            </div>
            <div class="action-buttons">
              <button (click)="remoteRename()" [disabled]="selectedRemote.length !== 1">Rename</button>
              <button (click)="refreshRemote()" [disabled]="!connected">Refresh</button>
              <button (click)="remoteDelete()" [disabled]="!selectedRemote.length">Delete</button>
              <button (click)="remoteNewFolder()" [disabled]="!connected">New Folder</button>
              <button (click)="remoteEditPermissions()" [disabled]="selectedRemote.length !== 1 || !remoteActionPerms">Edit Permissions</button>
              <button (click)="remoteShowSize()" [disabled]="selectedRemote.length !== 1 || !selectedRemote[0].isDirectory">Show Size</button>
              <button (click)="remoteDownload()" [disabled]="!selectedRemote.length">Download</button>
            </div>
          </div>
        </div>
      </div>
      <div class="sftp-transfers" *ngIf="transfers.length">
        <div class="transfer" *ngFor="let t of transfers">
          <div class="transfer-main">
            <div class="transfer-title">
              <span class="direction">{{ t.direction === 'upload' ? 'Upload' : 'Download' }}</span>
              <span class="name">{{ t.name }}</span>
            </div>
            <div class="transfer-path">
              <span class="label">Remote:</span>
              <span class="value">{{ t.remotePath }}</span>
            </div>
            <div class="transfer-path">
              <span class="label">Local:</span>
              <span class="value">{{ t.localPath }}</span>
            </div>
            <div class="bar">
              <div class="fill" [style.width.%]="getTransferProgress(t.transfer)"></div>
            </div>
          </div>
          <div class="transfer-stats">
            <div class="percent">{{ getTransferProgress(t.transfer) | number:'1.0-0' }}%</div>
            <div class="speed">{{ formatSpeed(t.transfer.getSpeed()) }}</div>
            <button class="btn-cancel" (click)="cancelTransfer(t)" [disabled]="t.transfer.isComplete() || t.transfer.isCancelled()">Cancel</button>
          </div>
        </div>
      </div>

      <div class="delete-overlay" *ngIf="deleteConfirmVisible">
        <div class="delete-dialog">
          <div class="delete-text">{{ deleteConfirmText }}</div>
          <div class="delete-buttons">
            <button class="danger" (click)="confirmDelete()">Delete</button>
            <button (click)="cancelDelete()">Cancel</button>
          </div>
        </div>
      </div>

      <div class="delete-overlay" *ngIf="replaceConfirmVisible">
        <div class="delete-dialog">
          <div class="delete-text">{{ replaceConfirmText }}</div>
          <div class="delete-buttons">
            <button class="danger" (click)="confirmReplace()">Replace</button>
            <button (click)="cancelReplace()">Cancel</button>
          </div>
        </div>
      </div>

      <div class="delete-overlay" *ngIf="inputDialogVisible">
        <div class="delete-dialog" (click)="$event.stopPropagation()">
          <div class="delete-text">{{ inputDialogTitle }}</div>
          <input
            class="dialog-input"
            [(ngModel)]="inputDialogValue"
            [placeholder]="inputDialogPlaceholder"
            (keyup.enter)="confirmInputDialog()"
          />
          <div class="delete-buttons">
            <button class="danger" (click)="confirmInputDialog()" [disabled]="!inputDialogValue.trim()">OK</button>
            <button (click)="cancelInputDialog()">Cancel</button>
          </div>
        </div>
      </div>

      <div
        class="local-menu"
        *ngIf="localMenuVisible"
        [style.left.px]="localMenuX"
        [style.top.px]="localMenuY"
        (click)="$event.stopPropagation()"
      >
        <div class="local-menu-item" *ngFor="let item of localMenuItems" (click)="onLocalMenuItemClick(item)">
          {{ item.label }}
        </div>
      </div>
    </div>
  `,
  styles: [`
    .sftp-root { display: flex; flex-direction: column; height: 100%; padding: 10px; gap: 10px; position: relative; }
    button { padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06); color: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .top-profiles { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px 8px; gap: 12px; font-size: 11px; opacity: 0.9; }
    .top-profiles .current .label,
    .top-profiles .recent .label { text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin-right: 4px; }
    .top-profiles .value { font-weight: 600; }
    .top-profiles .profile-chip { padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.04); color: inherit; cursor: pointer; font-size: 11px; }
    .top-profiles .profile-chip:hover { background: rgba(255,255,255,0.12); }
    .sftp-body { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; flex: 1; min-height: 0; }
    .pane { display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; overflow: hidden; min-height: 0; }
    .pane-title { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; padding: 8px 10px; background: rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.08); }
    .pane-label { font-weight: 600; display: flex; align-items: baseline; gap: 6px; }
    .pane-sub { font-weight: 400; font-size: 11px; opacity: 0.75; }
    .pane-path { opacity: 0.8; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pane-path input { width: 100%; padding: 4px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.3); color: inherit; font-family: inherit; font-size: 12px; }
    .pane-actions { display: flex; gap: 8px; align-items: center; }
    .pane-actions .path-preset,
    .pane-actions .path-favorite { max-width: 150px; padding: 3px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.22); background: rgba(20,20,20,0.95); color: inherit; font-size: 11px; }
    .pane-actions .path-preset option { background: #151515; color: #f5f5f5; }
    .pane-actions .path-favorite option { background: #151515; color: #f5f5f5; }
    .pane-actions .fav-toggle { padding: 2px 6px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.25); background: rgba(255,255,255,0.05); font-size: 11px; line-height: 1; }
    .pane-actions .fav-toggle.active { background: rgba(255,215,0,0.2); border-color: rgba(255,215,0,0.6); color: #ffd700; }
    .pane-filters { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(0,0,0,0.12); }
    .pane-filters input { flex: 1; padding: 4px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.3); color: inherit; font-size: 12px; }
    .show-hidden-toggle { display: flex; align-items: center; gap: 4px; font-size: 11px; opacity: 0.8; white-space: nowrap; }
    .show-hidden-toggle input[type="checkbox"] { margin: 0; }
    .breadcrumbs { display: flex; flex-wrap: wrap; gap: 4px; font-size: 11px; opacity: 0.9; align-items: center; }
    .crumb-button { padding: 2px 6px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.04); color: inherit; cursor: pointer; font-size: 11px; }
    .crumb-button:hover { background: rgba(255,255,255,0.10); }
    .crumb-separator { opacity: 0.6; }
    .pane-list { flex: 1; overflow: auto; padding: 4px; }
    .entry { display: grid; grid-template-columns: 24px minmax(0, 1.5fr) 80px 140px; gap: 8px; padding: 6px 8px; border-radius: 8px; user-select: none; align-items: center; }
    .entry:hover { background: rgba(255,255,255,0.06); }
    .entry.drop-target { outline: 1px dashed rgba(255,255,255,0.35); background: rgba(80, 160, 255, 0.10); }
    .entry.dim { opacity: 0.7; }
    .icon { text-align: center; opacity: 0.85; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .size { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; text-align: right; opacity: 0.8; }
    .date { font-size: 11px; opacity: 0.75; text-align: right; white-space: nowrap; }
    .entry.header { font-weight: 600; opacity: 0.9; background: rgba(255,255,255,0.02); }
    .sortable { cursor: pointer; }
    .entry.selected { background: rgba(80,160,255,0.18); }
    .pane-actions-bar { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-top: 1px solid rgba(255,255,255,0.06); background: rgba(0,0,0,0.18); }
    .pane-actions-bar .selection { font-size: 11px; opacity: 0.85; }
    .pane-actions-bar .action-inputs { display: flex; gap: 6px; }
    .pane-actions-bar .action-inputs input { flex: 1; padding: 3px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.3); color: inherit; font-size: 11px; }
    .pane-actions-bar .action-buttons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .sftp-transfers { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; max-height: 120px; overflow-y: auto; }
    .transfer { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); font-size: 11px; }
    .transfer-title { display: flex; gap: 6px; align-items: baseline; margin-bottom: 2px; }
    .transfer-title .direction { text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; font-weight: 600; font-size: 10px; }
    .transfer-title .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .transfer-path { display: flex; gap: 4px; opacity: 0.75; }
    .transfer-path .label { min-width: 48px; }
    .transfer-path .value { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .bar { position: relative; height: 4px; border-radius: 999px; background: rgba(255,255,255,0.07); margin-top: 4px; overflow: hidden; }
    .bar .fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: inherit; background: linear-gradient(90deg, #4dabff, #78ffce); transition: width 0.15s linear; }
    .transfer-stats { display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 4px; opacity: 0.8; }
    .transfer-stats .percent { font-weight: 600; }
    .transfer-stats .speed { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .btn-cancel { padding: 2px 6px; font-size: 10px; border-radius: 999px; }
    .delete-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 20; }
    .delete-dialog { min-width: 260px; max-width: 360px; padding: 14px 16px; border-radius: 10px; background: rgba(20,20,20,0.96); border: 1px solid rgba(255,255,255,0.15); box-shadow: 0 18px 45px rgba(0,0,0,0.75); display: flex; flex-direction: column; gap: 10px; }
    .delete-text { font-size: 13px; }
    .dialog-input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.3); color: inherit; font-size: 13px; }
    .delete-buttons { display: flex; justify-content: flex-end; gap: 8px; }
    .delete-buttons .danger { background: rgba(255,80,80,0.85); border-color: rgba(255,120,120,0.85); }
    .local-menu { position: absolute; min-width: 180px; max-width: 260px; max-height: 260px; overflow-y: auto; padding: 4px 0; border-radius: 10px; background: rgba(18,18,22,0.98); border: 1px solid rgba(255,255,255,0.16); box-shadow: 0 18px 45px rgba(0,0,0,0.8); z-index: 30; backdrop-filter: blur(12px); }
    .local-menu-item { padding: 6px 12px; font-size: 12px; cursor: pointer; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
    .local-menu-item:hover { background: linear-gradient(90deg, rgba(120,200,255,0.24), rgba(120,255,206,0.15)); }
  `],
})
export class SftpManagerTabComponent extends BaseTabComponent implements OnInit {
  // injected from the SSH tab when opened via SFTP-UI button
  sshSession: SSHSessionLike | null = null
  profile: any = null

  connecting = false
  connected = false

  // legacy UI fields kept for now (not used when opened from SSH tab)
  host = ''
  port = 22
  username = ''
  password = ''

  localPath = os.homedir()
  localEntries: LocalEntry[] = []

  remotePath = '/'
  remoteEntries: SFTPFile[] = []

  private sftpSession: SFTPSessionLike | null = null

  localDropActive = false
  remoteDropActive = false

  transfers: Array<{
    transfer: FileTransfer
    direction: 'upload' | 'download'
    name: string
    remotePath: string
    localPath: string
  }> = []

  private transfersTimer: number | null = null
  localFilter = ''
  remoteFilter = ''
  remotePathInput = this.remotePath
  localPathInput = this.localPath
  private localFolderSizeLoading: Set<string> = new Set()
  private remoteFolderSizeLoading: Set<string> = new Set()
  private localSortBy: 'name' | 'size' | 'modified' = 'name'
  private localSortAsc = true
  private remoteSortBy: 'name' | 'size' | 'modified' = 'name'
  private remoteSortAsc = true
  private localCache: {
    entriesRef: LocalEntry[]
    filter: string
    showHidden: boolean
    sortBy: 'name' | 'size' | 'modified'
    asc: boolean
    result: LocalEntry[]
  } | null = null
  private remoteCache: {
    entriesRef: SFTPFile[]
    filter: string
    showHidden: boolean
    sortBy: 'name' | 'size' | 'modified'
    asc: boolean
    result: SFTPFile[]
  } | null = null
  showHiddenLocal = false
  showHiddenRemote = false
  selectedLocal: LocalEntry[] = []
  selectedRemote: SFTPFile[] = []
  localActionName = ''
  localActionPerms = ''
  remoteActionName = ''
  remoteActionPerms = ''
  private localLastSelectedIndex: number | null = null
  private remoteLastSelectedIndex: number | null = null

  deleteConfirmVisible = false
  deleteConfirmMode: 'local' | 'remote' | null = null
  deleteConfirmText = ''
  private pendingLocalDelete: LocalEntry[] = []
  private pendingRemoteDelete: SFTPFile[] = []

  replaceConfirmVisible = false
  replaceConfirmText = ''
  private replaceConfirmResolve: ((v: boolean) => void) | null = null

  inputDialogVisible = false
  inputDialogTitle = ''
  inputDialogPlaceholder = ''
  inputDialogValue = ''
  private inputDialogMode: 'local-new-folder' | 'remote-new-folder' | 'local-rename' | 'remote-rename' | null = null
  private inputDialogTargetPath: string | null = null
  private inputDialogRemotePath: string | null = null
  private platform!: PlatformService
  private openedRemoteFiles: Map<string, {
    remotePath: string
    mode: number
    watcher: fsSync.FSWatcher | null
    debounceTimer: number | null
    syncing: boolean
    pending: boolean
    lastUploadedSignature: string | null
  }> = new Map()
  localPathPresets: Array<{ id: string, label: string, path: string }> = []
  localFavorites: Array<{ id: string, label: string, path: string }> = []
  recentProfiles: any[] = []
  localMenuVisible = false
  localMenuX = 0
  localMenuY = 0
  localMenuItems: Array<{ label: string, path: string }> = []

  constructor (
    injector: Injector,
    private sftp: SftpConnectionService,
    private profilesService: ProfilesService,
    private app: AppService,
  ) {
    // Tabby runtime BaseTabComponent expects Injector in constructor, but typings in this SDK may differ.
    // @ts-expect-error runtime-compatible super(injector)
    super(injector)
    this.platform = injector.get(PlatformService as any)

    // build local path presets (similar to Termius quick locations)
    const home = os.homedir()
    this.localPathPresets.push({ id: 'home', label: 'Home', path: home })
    const desktop = path.join(home, 'Desktop')
    const documents = path.join(home, 'Documents')
    const downloads = path.join(home, 'Downloads')
    if (fsSync.existsSync(desktop)) {
      this.localPathPresets.push({ id: 'desktop', label: 'Desktop', path: desktop })
    }
    if (fsSync.existsSync(documents)) {
      this.localPathPresets.push({ id: 'documents', label: 'Documents', path: documents })
    }
    if (fsSync.existsSync(downloads)) {
      this.localPathPresets.push({ id: 'downloads', label: 'Downloads', path: downloads })
    }

    this.loadLocalFavorites()
    void this.refreshLocal()

    this.transfersTimer = window.setInterval(() => {
      this.transfers = this.transfers.filter(t => !t.transfer.isComplete() && !t.transfer.isCancelled())
    }, 1000)
  }

  ngOnInit (): void {
    // If there's no live SSH session, this tab was likely restored across
    // restart or opened in an invalid context. Close it immediately to avoid
    // an empty, nameless SFTP tab lingering after restart.
    if (!this.sshSession) {
      try {
        this.app.closeTab(this)
      } catch (e) {
        console.error('[SFTP-UI] Failed to close invalid SFTP tab', e)
      }
      return
    }

    this.remotePathInput = this.remotePath
    this.localPathInput = this.localPath
    if (this.sshSession) {
      void this.connect()
    }
    this.loadRecentProfiles()
  }

  async connect (): Promise<void> {
    if (this.connecting || this.connected) {
      return
    }
    if (!this.sshSession) {
      console.error('[SFTP-UI] No SSH session on current tab')
      return
    }
    this.connecting = true
    try {
      this.sftpSession = await this.sftp.openFromSSHSession(this.sshSession)
      this.connected = true
      this.remotePath = this.getDefaultRemotePath()
      this.remotePathInput = this.remotePath
      await this.refreshRemote()
    } catch (e) {
      console.error('[SFTP-UI] SFTP connection failed', e)
    } finally {
      this.connecting = false
    }
  }

  async disconnect (): Promise<void> {
    this.sftpSession = null
    this.connected = false
    this.remoteEntries = []
  }

  canLocalUp (): boolean {
    const parent = path.dirname(this.localPath)
    return parent !== this.localPath
  }

  localUp (): void {
    const parent = path.dirname(this.localPath)
    if (parent !== this.localPath) {
      this.localPath = parent
      this.localPathInput = this.localPath
      void this.refreshLocal()
    }
  }

  remoteUp (): void {
    if (!this.connected || this.remotePath === '/') {
      return
    }
    const next = path.posix.dirname(this.remotePath)
    this.remotePath = next === '.' ? '/' : next
    this.remotePathInput = this.remotePath
    void this.refreshRemote()
  }

  async refreshLocal (): Promise<void> {
    try {
      const names = await fs.readdir(this.localPath)
      const entries: LocalEntry[] = []
      for (const name of names) {
        const fullPath = path.join(this.localPath, name)
        try {
          const st = await fs.stat(fullPath)
          entries.push({
            name,
            fullPath,
            isDirectory: st.isDirectory(),
            size: st.size,
            mtimeMs: st.mtimeMs,
          })
        } catch {
          // ignore entries that disappeared
        }
      }
      this.localEntries = entries
    } catch (e) {
      console.error('[SFTP-UI] Local listing failed', e)
    }
  }

  async refreshRemote (): Promise<void> {
    if (!this.connected) {
      return
    }
    try {
      if (!this.sftpSession) {
        throw new Error('Not connected')
      }
      this.remoteEntries = await this.sftpSession.readdir(this.remotePath)
    } catch (e) {
      console.error('[SFTP-UI] Remote listing failed', e)
    }
  }

  openLocal (e: LocalEntry): void {
    if (!e.isDirectory) {
      return
    }
    this.localPath = e.fullPath
    this.localPathInput = this.localPath
    void this.refreshLocal()
  }

  openRemote (e: SFTPFile): void {
    if (!this.connected) {
      return
    }
    if (e.isDirectory) {
      this.remotePath = e.fullPath
      this.remotePathInput = this.remotePath
      void this.refreshRemote()
    } else {
      void this.openRemoteFile(e)
    }
  }

  onDragOver (ev: DragEvent): void {
    ev.preventDefault()
  }

  onLocalMouseDown (entry: LocalEntry, event: MouseEvent): void {
    if (event.button === 2) {
      this.onLocalContextMenu(entry, event)
    }
  }

  onRemoteMouseDown (entry: SFTPFile, event: MouseEvent): void {
    if (event.button === 2) {
      this.onRemoteContextMenu(entry, event)
    }
  }

  selectLocal (entry: LocalEntry, event: MouseEvent): void {
    const list = this.getFilteredLocalEntries()
    const index = list.indexOf(entry)
    if (index === -1) {
      return
    }
    const isCtrl = event.ctrlKey || event.metaKey
    const isShift = event.shiftKey
    if (isShift && this.localLastSelectedIndex != null) {
      const [from, to] = this.localLastSelectedIndex < index
        ? [this.localLastSelectedIndex, index]
        : [index, this.localLastSelectedIndex]
      const range = list.slice(from, to + 1)
      const set = new Set(this.selectedLocal)
      for (const e of range) {
        set.add(e)
      }
      this.selectedLocal = Array.from(set)
    } else if (isCtrl) {
      const exists = this.selectedLocal.includes(entry)
      if (exists) {
        this.selectedLocal = this.selectedLocal.filter(e => e !== entry)
      } else {
        this.selectedLocal = [...this.selectedLocal, entry]
      }
      this.localLastSelectedIndex = index
    } else {
      this.selectedLocal = [entry]
      this.localLastSelectedIndex = index
    }
    if (this.selectedLocal.length === 1) {
      this.localActionName = this.selectedLocal[0].name
    }
  }

  isLocalSelected (entry: LocalEntry): boolean {
    return this.selectedLocal.includes(entry)
  }

  selectRemote (entry: SFTPFile, event: MouseEvent): void {
    const list = this.getFilteredRemoteEntries()
    const index = list.indexOf(entry)
    if (index === -1) {
      return
    }
    const isCtrl = event.ctrlKey || event.metaKey
    const isShift = event.shiftKey
    if (isShift && this.remoteLastSelectedIndex != null) {
      const [from, to] = this.remoteLastSelectedIndex < index
        ? [this.remoteLastSelectedIndex, index]
        : [index, this.remoteLastSelectedIndex]
      const range = list.slice(from, to + 1)
      const set = new Set(this.selectedRemote)
      for (const e of range) {
        set.add(e)
      }
      this.selectedRemote = Array.from(set)
    } else if (isCtrl) {
      const exists = this.selectedRemote.includes(entry)
      if (exists) {
        this.selectedRemote = this.selectedRemote.filter(e => e !== entry)
      } else {
        this.selectedRemote = [...this.selectedRemote, entry]
      }
      this.remoteLastSelectedIndex = index
    } else {
      this.selectedRemote = [entry]
      this.remoteLastSelectedIndex = index
    }
    if (this.selectedRemote.length === 1) {
      this.remoteActionName = this.selectedRemote[0].name
      const currentPerms = (this.selectedRemote[0].mode & 0o777).toString(8)
      this.remoteActionPerms = currentPerms
    }
  }

  isRemoteSelected (entry: SFTPFile): boolean {
    return this.selectedRemote.includes(entry)
  }

  setLocalSort (field: 'name' | 'size' | 'modified'): void {
    if (this.localSortBy === field) {
      this.localSortAsc = !this.localSortAsc
    } else {
      this.localSortBy = field
      this.localSortAsc = true
    }
  }

  setRemoteSort (field: 'name' | 'size' | 'modified'): void {
    if (this.remoteSortBy === field) {
      this.remoteSortAsc = !this.remoteSortAsc
    } else {
      this.remoteSortBy = field
      this.remoteSortAsc = true
    }
  }

  onDragStartLocal (ev: DragEvent, e: LocalEntry): void {
    const sources = this.selectedLocal.includes(e) && this.selectedLocal.length ? this.selectedLocal : [e]
    const movePayload = sources.map(x => x.fullPath)
    ev.dataTransfer?.setData('application/x-tabby-sftp-ui-local-move', JSON.stringify(movePayload))

    // Existing cross-device drag (local -> remote) only for files
    if (!e.isDirectory) {
      const payload: DragPayload = { kind: 'local-file', fullPath: e.fullPath, name: e.name }
      ev.dataTransfer?.setData('application/x-tabby-sftp-ui', JSON.stringify(payload))
      ev.dataTransfer?.setData('text/plain', e.fullPath)
    }
    ev.dataTransfer?.setDragImage?.((ev.target as HTMLElement) ?? document.body, 0, 0)
  }

  onDragStartRemote (ev: DragEvent, item: SFTPFile): void {
    if (!this.connected) {
      return
    }
    const sources = this.selectedRemote.includes(item) && this.selectedRemote.length ? this.selectedRemote : [item]
    const movePayload = sources.map(x => x.fullPath)
    ev.dataTransfer?.setData('application/x-tabby-sftp-ui-remote-move', JSON.stringify(movePayload))

    // Existing cross-device drag (remote -> local) only for files
    const payload: DragPayload = item.isDirectory
      ? { kind: 'remote-dir', remotePath: item.fullPath, name: item.name }
      : { kind: 'remote-file', remotePath: item.fullPath, name: item.name, size: item.size, mode: item.mode }
    ev.dataTransfer?.setData('application/x-tabby-sftp-ui', JSON.stringify(payload))
    ev.dataTransfer?.setData('text/plain', item.fullPath)
    ev.dataTransfer?.setDragImage?.((ev.target as HTMLElement) ?? document.body, 0, 0)
  }

  async onDropOnRemote (ev: DragEvent): Promise<void> {
    ev.preventDefault()
    this.remoteDropActive = false
    if (!this.connected) {
      return
    }
    if (!this.sftpSession) {
      return
    }

    // Drag & drop from OS file manager (Explorer/Finder) into the remote pane
    const osPaths = this.getDroppedOsPaths(ev)
    if (osPaths.length) {
      try {
        for (const p of osPaths) {
          const baseName = path.basename(p)
          const existing = this.remoteEntries.find(e => e.name === baseName)
          if (existing) {
            const ok = await this.showReplaceConfirm(`Replace existing "${baseName}" on remote?`)
            if (!ok) {
              continue
            }
            const remoteTarget = path.posix.join(this.remotePath, baseName)
            await this.deleteRemotePathRecursive(remoteTarget)
          }
          await this.uploadLocalPathToRemote(this.remotePath, p)
        }
        await this.refreshRemote()
      } catch (e) {
        console.error('[SFTP-UI] Upload from OS drop failed', e)
      }
      return
    }

    // Fallback: use Tabby's native drag parser (supports directories and HTMLFileUpload)
    try {
      const dirUpload = await (this.platform as any).startUploadFromDragEvent?.(ev, true)
      if (dirUpload && this.sftpSession) {
        await this.uploadDirectoryUploadToRemote(this.remotePath, dirUpload)
        await this.refreshRemote()
        return
      }
    } catch (e) {
      console.error('[SFTP-UI] startUploadFromDragEvent failed', e)
    }

    const raw = ev.dataTransfer?.getData('application/x-tabby-sftp-ui')
    if (!raw) {
      return
    }
    let payload: DragPayload
    try {
      payload = JSON.parse(raw) as DragPayload
    } catch {
      return
    }
    if (payload.kind !== 'local-file') {
      return
    }
    try {
      const targetRemotePath = path.posix.join(this.remotePath, payload.name)
      const existsOnRemote = this.remoteEntries.some(e => e.name === payload.name)
      if (existsOnRemote) {
        const ok = await this.showReplaceConfirm(`Replace existing "${payload.name}" on remote?`)
        if (!ok) {
          return
        }
        await this.deleteRemotePathRecursive(targetRemotePath)
      }
      const upload = new LocalPathFileUpload(payload.fullPath)
      this.trackTransfer(upload, 'upload', targetRemotePath, payload.fullPath)
      await this.sftpSession.upload(targetRemotePath, upload)
      await this.refreshRemote()
    } catch (e) {
      console.error('[SFTP-UI] Upload failed', e)
    }
  }

  async onDropOnLocal (ev: DragEvent): Promise<void> {
    ev.preventDefault()
    this.localDropActive = false

    // 1) Tabby's internal drag (remote -> local download)
    const rawInternal = ev.dataTransfer?.getData('application/x-tabby-sftp-ui')
    if (rawInternal) {
      let payload: DragPayload
      try {
        payload = JSON.parse(rawInternal) as DragPayload
      } catch {
        payload = null as any
      }
      if (payload && payload.kind === 'remote-file') {
        try {
          const targetLocalPath = path.join(this.localPath, payload.name)
          if (!this.sftpSession) {
            throw new Error('Not connected')
          }
          if (fsSync.existsSync(targetLocalPath)) {
            const ok = await this.showReplaceConfirm(`Replace existing "${payload.name}"?`)
            if (!ok) {
              return
            }
          }
          const dl = new LocalPathFileDownload(targetLocalPath, payload.mode, payload.size)
          this.trackTransfer(dl, 'download', payload.remotePath, targetLocalPath)
          await this.sftpSession.download(payload.remotePath, dl)
          await this.refreshLocal()
        } catch (e) {
          console.error('[SFTP-UI] Download failed', e)
        }
        return
      }

      if (payload && payload.kind === 'remote-dir') {
        try {
          if (!this.sftpSession) {
            throw new Error('Not connected')
          }
          const targetLocalPath = path.join(this.localPath, payload.name)
          if (fsSync.existsSync(targetLocalPath)) {
            const ok = await this.showReplaceConfirm(`Replace existing folder "${payload.name}"?`)
            if (!ok) {
              return
            }
            await this.deleteLocalPathRecursive(targetLocalPath)
          }
          await this.downloadRemoteDirectoryRecursive(payload.remotePath, targetLocalPath)
          await this.refreshLocal()
        } catch (e) {
          console.error('[SFTP-UI] Download directory failed', e)
        }
        return
      }
    }

    // Drag & drop from OS file manager into the local pane (copy into current local folder)
    const osPaths = this.getDroppedOsPaths(ev)
    if (osPaths.length) {
      try {
        for (const p of osPaths) {
          const baseName = path.basename(p)
          const destPath = path.join(this.localPath, baseName)
          if (fsSync.existsSync(destPath)) {
            const ok = await this.showReplaceConfirm(`Replace existing "${baseName}"?`)
            if (!ok) {
              continue
            }
          }
          await this.copyLocalPathIntoLocalDir(this.localPath, p)
        }
        await this.refreshLocal()
      } catch (e) {
        console.error('[SFTP-UI] Local copy from OS drop failed', e)
      }
      return
    }

    // Fallback: use Tabby's native drag parser, then write files to disk
    try {
      const dirUpload = await (this.platform as any).startUploadFromDragEvent?.(ev, true)
      if (dirUpload) {
        await this.writeDirectoryUploadToLocal(this.localPath, dirUpload)
        await this.refreshLocal()
        return
      }
    } catch (e) {
      console.error('[SFTP-UI] startUploadFromDragEvent (local) failed', e)
    }

    const raw = ev.dataTransfer?.getData('application/x-tabby-sftp-ui')
    if (!raw) {
      return
    }
    let payload: DragPayload
    try {
      payload = JSON.parse(raw) as DragPayload
    } catch {
      return
    }
    if (payload.kind !== 'remote-file' && payload.kind !== 'remote-dir') {
      return
    }
    try {
      if (payload.kind === 'remote-file') {
        const targetLocalPath = path.join(this.localPath, payload.name)
        if (!this.sftpSession) {
          throw new Error('Not connected')
        }
        if (fsSync.existsSync(targetLocalPath)) {
          const ok = await this.showReplaceConfirm(`Replace existing "${payload.name}"?`)
          if (!ok) {
            return
          }
          await this.deleteLocalPathRecursive(targetLocalPath)
        }
        const dl = new LocalPathFileDownload(targetLocalPath, payload.mode, payload.size)
        this.trackTransfer(dl, 'download', payload.remotePath, targetLocalPath)
        await this.sftpSession.download(payload.remotePath, dl)
        await this.refreshLocal()
        return
      }

      // remote-dir -> local-dir (recursive download)
      if (!this.sftpSession) {
        throw new Error('Not connected')
      }
      const targetLocalPath = path.join(this.localPath, payload.name)
      if (fsSync.existsSync(targetLocalPath)) {
        const ok = await this.showReplaceConfirm(`Replace existing folder "${payload.name}"?`)
        if (!ok) {
          return
        }
        await this.deleteLocalPathRecursive(targetLocalPath)
      }
      await this.downloadRemoteDirectoryRecursive(payload.remotePath, targetLocalPath)
      await this.refreshLocal()
    } catch (e) {
      console.error('[SFTP-UI] Download failed', e)
    }
  }

  private async uploadLocalPathToRemote (remoteDir: string, localPath: string): Promise<void> {
    if (!this.sftpSession) {
      return
    }
    const st = await fs.stat(localPath).catch(() => null)
    if (!st) {
      return
    }
    const baseName = path.basename(localPath)
    const remoteTarget = path.posix.join(remoteDir, baseName)

    if (st.isDirectory()) {
      // Ensure destination folder exists, then recursively upload children
      try {
        await this.sftpSession.mkdir(remoteTarget)
      } catch {
        // ignore (might already exist)
      }
      const children = await fs.readdir(localPath)
      for (const child of children) {
        await this.uploadLocalPathToRemote(remoteTarget, path.join(localPath, child))
      }
      return
    }

    const upload = new LocalPathFileUpload(localPath)
    this.trackTransfer(upload, 'upload', remoteTarget, localPath)
    await this.sftpSession.upload(remoteTarget, upload)
  }

  private async copyLocalPathIntoLocalDir (destDir: string, srcPath: string): Promise<void> {
    const st = await fs.stat(srcPath).catch(() => null)
    if (!st) {
      return
    }
    const baseName = path.basename(srcPath)
    const destPath = path.join(destDir, baseName)

    if (st.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true })
      const children = await fs.readdir(srcPath)
      for (const child of children) {
        await this.copyLocalPathIntoLocalDir(destPath, path.join(srcPath, child))
      }
      return
    }

    await fs.copyFile(srcPath, destPath)
  }

  private async uploadDirectoryUploadToRemote (remoteDir: string, dirUpload: any): Promise<void> {
    if (!this.sftpSession) {
      return
    }
    const childrens: any[] = dirUpload?.getChildrens?.() ?? []
    for (const item of childrens) {
      // DirectoryUpload
      if (typeof item?.getChildrens === 'function') {
        const name = item.getName?.() || 'folder'
        const nextRemote = path.posix.join(remoteDir, name)
        try {
          await this.sftpSession.mkdir(nextRemote)
        } catch {
          // ignore (might already exist)
        }
        await this.uploadDirectoryUploadToRemote(nextRemote, item)
        continue
      }

      // FileUpload (including HTMLFileUpload)
      if (typeof item?.read === 'function' && typeof item?.getName === 'function') {
        const fileUpload = item as FileUpload
        const name = fileUpload.getName()
        const targetRemotePath = path.posix.join(remoteDir, name)
        this.trackTransfer(fileUpload as any, 'upload', targetRemotePath, name)
        await this.sftpSession.upload(targetRemotePath, fileUpload as any)
      }
    }
  }

  private async writeDirectoryUploadToLocal (localDir: string, dirUpload: any): Promise<void> {
    const childrens: any[] = dirUpload?.getChildrens?.() ?? []
    for (const item of childrens) {
      if (typeof item?.getChildrens === 'function') {
        const name = item.getName?.() || 'folder'
        const nextLocal = path.join(localDir, name)
        await fs.mkdir(nextLocal, { recursive: true })
        await this.writeDirectoryUploadToLocal(nextLocal, item)
        continue
      }

      if (typeof item?.readAll === 'function' && typeof item?.getName === 'function') {
        const name = item.getName()
        const targetLocal = path.join(localDir, name)
        const buf = await item.readAll()
        await fs.writeFile(targetLocal, Buffer.from(buf))
        try {
          item.close?.()
        } catch {
          // ignore
        }
      }
    }
  }

  private async downloadRemoteDirectoryRecursive (remoteDir: string, localDir: string): Promise<void> {
    if (!this.sftpSession) {
      return
    }
    await fs.mkdir(localDir, { recursive: true })
    const entries = await this.sftpSession.readdir(remoteDir).catch(() => null as any)
    if (!entries) {
      return
    }
    for (const e of entries as SFTPFile[]) {
      const targetLocal = path.join(localDir, e.name)
      if (e.isDirectory) {
        await this.downloadRemoteDirectoryRecursive(e.fullPath, targetLocal)
      } else {
        const dl = new LocalPathFileDownload(targetLocal, e.mode, e.size)
        this.trackTransfer(dl, 'download', e.fullPath, targetLocal)
        await this.sftpSession.download(e.fullPath, dl)
      }
    }
  }

  private getDroppedOsPaths (ev: DragEvent): string[] {
    const dt = ev.dataTransfer
    if (!dt) {
      return []
    }
    const isWin = os.platform() === 'win32'
    const isLocalPath = (p: string): boolean => {
      if (isWin) {
        return /^[A-Za-z]:\\/.test(p) || p.startsWith('\\\\')
      }
      return p.startsWith('/')
    }

    // 1) Electron-style File.path
    const filePaths = Array.from(dt.files ?? [])
      .map(f => (f as any).path as string | undefined)
      .filter((p): p is string => Boolean(p))
    if (filePaths.length) {
      return filePaths
    }

    // 2) Sometimes paths are exposed as URIs
    const uriList = dt.getData('text/uri-list') || ''
    const uris = uriList
      .split(/\r?\n/g)
      .map(x => x.trim())
      .filter(x => x && !x.startsWith('#'))
      .map(x => {
        if (x.startsWith('file://')) {
          try {
            return decodeURIComponent(x.replace(/^file:\/\//, ''))
          } catch {
            return x.replace(/^file:\/\//, '')
          }
        }
        return x
      })
      .filter(x => x && isLocalPath(x))
    if (uris.length) {
      return uris
    }

    // 3) Plain text sometimes contains a local path
    const text = dt.getData('text/plain') || ''
    const textLines = text.split(/\r?\n/g).map(x => x.trim()).filter(Boolean)
    const textPaths = textLines
      .map(x => {
        if (x.startsWith('file://')) {
          try {
            return decodeURIComponent(x.replace(/^file:\/\//, ''))
          } catch {
            return x.replace(/^file:\/\//, '')
          }
        }
        return x
      })
      .filter(x => x && isLocalPath(x))
    return textPaths
  }

  getFilteredLocalEntries (): LocalEntry[] {
    const entriesRef = this.localEntries
    const filter = this.localFilter
    const showHidden = this.showHiddenLocal
    const sortBy = this.localSortBy
    const asc = this.localSortAsc

    if (this.localCache &&
      this.localCache.entriesRef === entriesRef &&
      this.localCache.filter === filter &&
      this.localCache.showHidden === showHidden &&
      this.localCache.sortBy === sortBy &&
      this.localCache.asc === asc) {
      return this.localCache.result
    }

    const term = filter.trim().toLowerCase()
    let entries = entriesRef
    if (!showHidden) {
      entries = entries.filter(e => !e.name.startsWith('.'))
    }
    if (term) {
      entries = entries.filter(e => e.name.toLowerCase().includes(term))
    }
    const result = this.sortLocalEntries(entries.slice())
    this.localCache = { entriesRef, filter, showHidden, sortBy, asc, result }
    return result
  }

  getFilteredRemoteEntries (): SFTPFile[] {
    const entriesRef = this.remoteEntries
    const filter = this.remoteFilter
    const showHidden = this.showHiddenRemote
    const sortBy = this.remoteSortBy
    const asc = this.remoteSortAsc

    if (this.remoteCache &&
      this.remoteCache.entriesRef === entriesRef &&
      this.remoteCache.filter === filter &&
      this.remoteCache.showHidden === showHidden &&
      this.remoteCache.sortBy === sortBy &&
      this.remoteCache.asc === asc) {
      return this.remoteCache.result
    }

    const term = filter.trim().toLowerCase()
    let entries = entriesRef
    if (!showHidden) {
      entries = entries.filter(e => !e.name.startsWith('.'))
    }
    if (term) {
      entries = entries.filter(e => e.name.toLowerCase().includes(term))
    }
    const result = this.sortRemoteEntries(entries.slice())
    this.remoteCache = { entriesRef, filter, showHidden, sortBy, asc, result }
    return result
  }

  private sortLocalEntries (entries: LocalEntry[]): LocalEntry[] {
    const dirFirst = (a: LocalEntry, b: LocalEntry) => Number(b.isDirectory) - Number(a.isDirectory)
    const factor = this.localSortAsc ? 1 : -1
    const field = this.localSortBy
    return entries.sort((a, b) => {
      const d = dirFirst(a, b)
      if (d !== 0) return d
      if (field === 'name') {
        return a.name.localeCompare(b.name) * factor
      }
      if (field === 'size') {
        const av = a.size ?? 0
        const bv = b.size ?? 0
        return (av - bv) * factor
      }
      const av = a.mtimeMs ?? 0
      const bv = b.mtimeMs ?? 0
      return (av - bv) * factor
    })
  }

  private sortRemoteEntries (entries: SFTPFile[]): SFTPFile[] {
    const dirFirst = (a: SFTPFile, b: SFTPFile) => Number(b.isDirectory) - Number(a.isDirectory)
    const factor = this.remoteSortAsc ? 1 : -1
    const field = this.remoteSortBy
    return entries.sort((a, b) => {
      const d = dirFirst(a, b)
      if (d !== 0) return d
      if (field === 'name') {
        return a.name.localeCompare(b.name) * factor
      }
      if (field === 'size') {
        const av = a.size ?? 0
        const bv = b.size ?? 0
        return (av - bv) * factor
      }
      const av = a.modified?.getTime?.() ?? 0
      const bv = b.modified?.getTime?.() ?? 0
      return (av - bv) * factor
    })
  }

  private getLocalMovePayload (ev: DragEvent): string[] | null {
    const raw = ev.dataTransfer?.getData('application/x-tabby-sftp-ui-local-move')
    if (!raw) {
      return null
    }
    try {
      const arr = JSON.parse(raw) as string[]
      if (Array.isArray(arr)) {
        return arr
      }
    } catch {
      // ignore
    }
    return null
  }

  private getRemoteMovePayload (ev: DragEvent): string[] | null {
    const raw = ev.dataTransfer?.getData('application/x-tabby-sftp-ui-remote-move')
    if (!raw) {
      return null
    }
    try {
      const arr = JSON.parse(raw) as string[]
      if (Array.isArray(arr)) {
        return arr
      }
    } catch {
      // ignore
    }
    return null
  }

  formatSize (bytes?: number): string {
    if (bytes === undefined || bytes === null) {
      return ''
    }
    if (bytes === 0) {
      return '0 B'
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex++
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1
    return `${value.toFixed(digits)} ${units[unitIndex]}`
  }

  formatSpeed (bytesPerSecond?: number): string {
    if (bytesPerSecond === undefined || bytesPerSecond === null) {
      return ''
    }
    if (bytesPerSecond === 0) {
      return '0 B/s'
    }
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s']
    let value = bytesPerSecond
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex++
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1
    return `${value.toFixed(digits)} ${units[unitIndex]}`
  }

  getLocalSizeDisplay (e: LocalEntry): string {
    if (!e.isDirectory) {
      return this.formatSize(e.size)
    }
    if (e.size !== undefined) {
      return this.formatSize(e.size)
    }
    if (this.localFolderSizeLoading.has(e.fullPath)) {
      return '…'
    }
    return ''
  }

  getRemoteSizeDisplay (e: SFTPFile): string {
    if (!e.isDirectory) {
      return this.formatSize(e.size)
    }
    const key = e.fullPath
    if ((e as any).dirSize !== undefined) {
      return this.formatSize((e as any).dirSize)
    }
    if (this.remoteFolderSizeLoading.has(key)) {
      return '…'
    }
    return ''
  }

  onLocalEntryDragOver (entry: LocalEntry, ev: DragEvent): void {
    if (!entry.isDirectory) {
      return
    }
    if (!this.getLocalMovePayload(ev)) {
      return
    }
    ev.preventDefault()
  }

  async onLocalEntryDrop (entry: LocalEntry, ev: DragEvent): Promise<void> {
    if (!entry.isDirectory) {
      return
    }
    const sources = this.getLocalMovePayload(ev)
    if (!sources || !sources.length) {
      return
    }
    ev.preventDefault()
    const targetDir = entry.fullPath
    try {
      for (const src of sources) {
        if (!src || src === targetDir) {
          continue
        }
        // avoid moving a directory into its own subtree
        if (targetDir.startsWith(src + path.sep)) {
          continue
        }
        const name = path.basename(src)
        const dst = path.join(targetDir, name)
        if (dst === src) {
          continue
        }
        try {
          await fs.rename(src, dst)
        } catch (e) {
          console.error('[SFTP-UI] Local move failed', e)
        }
      }
      await this.refreshLocal()
    } catch (e) {
      console.error('[SFTP-UI] Local move batch failed', e)
    }
  }

  onRemoteEntryDragOver (entry: SFTPFile, ev: DragEvent): void {
    if (!entry.isDirectory) {
      return
    }
    if (!this.getRemoteMovePayload(ev)) {
      return
    }
    ev.preventDefault()
  }

  async onRemoteEntryDrop (entry: SFTPFile, ev: DragEvent): Promise<void> {
    if (!entry.isDirectory || !this.sftpSession || !this.connected) {
      return
    }
    const sources = this.getRemoteMovePayload(ev)
    if (!sources || !sources.length) {
      return
    }
    ev.preventDefault()
    const targetDir = entry.fullPath
    try {
      for (const src of sources) {
        if (!src || src === targetDir) {
          continue
        }
        // avoid moving a directory into its own subtree
        if (targetDir.startsWith(src + '/')) {
          continue
        }
        const name = src.split('/').filter(Boolean).pop() || ''
        if (!name) {
          continue
        }
        const dst = path.posix.join(targetDir, name)
        if (dst === src) {
          continue
        }
        try {
          await this.sftpSession.rename(src, dst)
        } catch (e) {
          console.error('[SFTP-UI] Remote move failed', e)
        }
      }
      await this.refreshRemote()
    } catch (e) {
      console.error('[SFTP-UI] Remote move batch failed', e)
    }
  }

  getRemoteBreadcrumbs (): Array<{ label: string, path: string }> {
    const parts = this.remotePath.split('/').filter(Boolean)
    const crumbs: Array<{ label: string, path: string }> = []
    let current = '/'
    crumbs.push({ label: '/', path: '/' })
    for (const p of parts) {
      current = current === '/' ? `/${p}` : `${current}/${p}`
      crumbs.push({ label: p, path: current })
    }
    return crumbs
  }

  navigateRemoteBreadcrumb (index: number): void {
    const crumbs = this.getRemoteBreadcrumbs()
    const crumb = crumbs[index]
    if (!crumb) {
      return
    }
    this.remotePath = crumb.path
    this.remotePathInput = this.remotePath
    void this.refreshRemote()
  }

  goToRemotePathInput (): void {
    if (!this.connected) {
      return
    }
    const target = this.normalizeRemotePath(this.remotePathInput || '/')
    this.remotePath = target
    this.remotePathInput = target
    void this.refreshRemote()
  }

  goToLocalPathInput (): void {
    const target = this.normalizeLocalPath(this.localPathInput || this.localPath)
    this.goToLocalPath(target)
  }

  getLocalBreadcrumbs (): Array<{ label: string, path: string }> {
    const currentPath = this.localPath
    const parsed = path.parse(currentPath)
    const root = parsed.root || path.sep
    const withoutRoot = currentPath.slice(root.length)
    const parts = withoutRoot.split(path.sep).filter(Boolean)
    const crumbs: Array<{ label: string, path: string }> = []

    const rootLabel = root.replace(/[\\\/]+$/, '') || root
    crumbs.push({ label: rootLabel, path: root })

    let accum = root
    for (const p of parts) {
      accum = path.join(accum, p)
      crumbs.push({ label: p, path: accum })
    }
    return crumbs
  }

  navigateLocalBreadcrumb (index: number): void {
    const crumbs = this.getLocalBreadcrumbs()
    const crumb = crumbs[index]
    if (!crumb) {
      return
    }
    this.goToLocalPath(crumb.path)
  }

  private goToLocalPath (target: string): void {
    this.localPath = target
    this.localPathInput = target
    void this.refreshLocal()
  }

  onLocalPresetChange (id: string): void {
    if (!id) {
      return
    }
    const preset = this.localPathPresets.find(p => p.id === id)
    if (!preset) {
      return
    }
    this.goToLocalPath(preset.path)
  }

  isCurrentFavorite (): boolean {
    return this.localFavorites.some(f => f.path === this.localPath)
  }

  toggleCurrentFavorite (): void {
    const existingIndex = this.localFavorites.findIndex(f => f.path === this.localPath)
    if (existingIndex >= 0) {
      this.localFavorites.splice(existingIndex, 1)
      this.saveLocalFavorites()
      return
    }
    const label = path.basename(this.localPath) || this.localPath
    const id = `fav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    this.localFavorites.push({ id, label, path: this.localPath })
    this.saveLocalFavorites()
  }

  onLocalFavoriteSelect (id: string): void {
    if (!id) {
      return
    }
    const fav = this.localFavorites.find(f => f.id === id)
    if (!fav) {
      return
    }
    this.goToLocalPath(fav.path)
  }

  onLocalBreadcrumbContextMenu (index: number, event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    const crumbs = this.getLocalBreadcrumbs()
    const crumb = crumbs[index]
    if (!crumb) {
      return
    }

    const menuItems: Array<{ label: string, path: string }> = []
    const isWindows = process.platform === 'win32'
    const isRootCrumb = index === 0

    const basePath = crumb.path

    // Root crumb on Windows: offer other drives as "siblings"
    if (isWindows && isRootCrumb) {
      const drives: string[] = []
      for (let code = 67; code <= 90; code++) { // C..Z
        const letter = String.fromCharCode(code)
        const rootPath = `${letter}:\\`
        try {
          if (fsSync.existsSync(rootPath)) {
            drives.push(rootPath)
          }
        } catch {
          // ignore
        }
      }
      for (const d of drives) {
        menuItems.push({ label: d, path: d })
      }
    } else {
      // For non-root crumbs (or non-Windows), show sibling folders only
      const parentPath = path.dirname(basePath)
      try {
        const parentEntries = fsSync.readdirSync(parentPath)
        for (const name of parentEntries) {
          const full = path.join(parentPath, name)
          try {
            const st = fsSync.statSync(full)
            if (st.isDirectory()) {
              menuItems.push({ label: name, path: full })
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    if (!menuItems.length) {
      return
    }

    this.localMenuItems = menuItems
    this.localMenuVisible = true
    this.localMenuX = event.clientX
    this.localMenuY = event.clientY
  }

  private loadLocalFavorites (): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      const raw = window.localStorage.getItem('tabby-sftp-ui-local-favorites')
      if (!raw) {
        return
      }
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.localFavorites = parsed
          .filter(f => f && typeof f.path === 'string')
          .map(f => ({
            id: String(f.id || `fav-${Math.random().toString(36).slice(2, 8)}`),
            label: String(f.label || path.basename(f.path) || f.path),
            path: String(f.path),
          }))
      }
    } catch {
      // ignore
    }
  }

  private saveLocalFavorites (): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      window.localStorage.setItem('tabby-sftp-ui-local-favorites', JSON.stringify(this.localFavorites))
    } catch {
      // ignore
    }
  }

  onLocalMenuItemClick (item: { label: string, path: string }): void {
    this.localMenuVisible = false
    this.goToLocalPath(item.path)
  }

  private normalizeLocalPath (p: string): string {
    if (!p) {
      return this.localPath
    }
    let result = p.trim()
    // On Windows allow drive letters and backslashes, but normalize to current OS-style
    if (path.win32.isAbsolute(result) || path.posix.isAbsolute(result)) {
      return result
    }
    // relative path from current localPath
    return path.join(this.localPath, result)
  }

  private normalizeRemotePath (p: string): string {
    if (!p) {
      return '/'
    }
    let result = p.trim()
    if (!result.startsWith('/')) {
      result = '/' + result
    }
    // remove duplicate slashes
    result = result.replace(/\/+/g, '/')
    return result
  }

  private getDefaultRemotePath (): string {
    const username = (this.profile && (this.profile.options?.username || this.profile.options?.user)) || ''
    if (username) {
      return `/home/${username}`
    }
    return '/'
  }

  private loadRecentProfiles (): void {
    try {
      const rec = this.profilesService.getRecentProfiles?.()
      if (Array.isArray(rec)) {
        this.recentProfiles = rec
      }
    } catch {
      this.recentProfiles = []
    }
  }

  getProfileLabel (p: any): string {
    if (!p) {
      return ''
    }
    return p.name || p.options?.host || p.id || 'Profile'
  }

  launchProfileFromSFTP (p: any): void {
    try {
      void this.profilesService.launchProfile(p)
    } catch (e) {
      console.error('[SFTP-UI] launchProfile failed', e)
    }
  }

  @HostListener('document:click')
  onDocumentClick (): void {
    this.localMenuVisible = false
  }

  localRename (): void {
    if (this.selectedLocal.length !== 1) {
      return
    }
    const entry = this.selectedLocal[0]
    this.openInputDialog({
      mode: 'local-rename',
      title: 'Rename (local)',
      placeholder: 'New name',
      value: entry.name,
      targetPath: entry.fullPath,
    })
  }

  localDelete (): void {
    if (!this.selectedLocal.length) {
      return
    }
    this.deleteConfirmMode = 'local'
    this.pendingLocalDelete = this.selectedLocal.slice()
    const names = this.pendingLocalDelete.map(e => e.name)
    this.deleteConfirmText = this.buildDeleteConfirmText('local', names)
    this.deleteConfirmVisible = true
  }

  localNewFolder (): void {
    this.openInputDialog({
      mode: 'local-new-folder',
      title: 'New folder (local)',
      placeholder: 'Folder name',
      value: 'New folder',
      targetPath: this.localPath,
    })
  }

  localEditPermissions (): void {
    if (this.selectedLocal.length !== 1 || !this.localActionPerms?.trim()) {
      return
    }
    const entry = this.selectedLocal[0]
    const mode = parseInt(this.localActionPerms.trim(), 8)
    if (Number.isNaN(mode)) {
      console.error('[SFTP-UI] Invalid local permissions value')
      return
    }
    void fs.chmod(entry.fullPath, mode as any)
      .then(() => this.refreshLocal())
      .catch(e => console.error('[SFTP-UI] Local chmod failed', e))
  }

  localShowSize (): void {
    if (this.selectedLocal.length === 1 && this.selectedLocal[0].isDirectory) {
      this.ensureLocalFolderSize(this.selectedLocal[0])
    }
  }

  remoteRename (): void {
    if (this.selectedRemote.length !== 1 || !this.sftpSession) {
      return
    }
    const entry = this.selectedRemote[0]
    this.openInputDialog({
      mode: 'remote-rename',
      title: 'Rename (remote)',
      placeholder: 'New name',
      value: entry.name,
      remotePath: entry.fullPath,
      targetPath: this.remotePath,
    })
  }

  remoteDelete (): void {
    if (!this.selectedRemote.length || !this.sftpSession) {
      return
    }
    this.deleteConfirmMode = 'remote'
    this.pendingRemoteDelete = this.selectedRemote.slice()
    const names = this.pendingRemoteDelete.map(e => e.name)
    this.deleteConfirmText = this.buildDeleteConfirmText('remote', names)
    this.deleteConfirmVisible = true
  }

  remoteNewFolder (): void {
    if (!this.sftpSession) {
      return
    }
    this.openInputDialog({
      mode: 'remote-new-folder',
      title: 'New folder (remote)',
      placeholder: 'Folder name',
      value: 'New folder',
      targetPath: this.remotePath,
    })
  }

  private openInputDialog (opts: {
    mode: NonNullable<SftpManagerTabComponent['inputDialogMode']>
    title: string
    placeholder: string
    value: string
    targetPath: string
    remotePath?: string
  }): void {
    this.inputDialogMode = opts.mode
    this.inputDialogTitle = opts.title
    this.inputDialogPlaceholder = opts.placeholder
    this.inputDialogValue = opts.value
    this.inputDialogTargetPath = opts.targetPath
    this.inputDialogRemotePath = opts.remotePath ?? null
    this.inputDialogVisible = true
  }

  cancelInputDialog (): void {
    this.inputDialogVisible = false
    this.inputDialogMode = null
    this.inputDialogTitle = ''
    this.inputDialogPlaceholder = ''
    this.inputDialogValue = ''
    this.inputDialogTargetPath = null
    this.inputDialogRemotePath = null
  }

  async confirmInputDialog (): Promise<void> {
    if (!this.inputDialogVisible || !this.inputDialogMode) {
      return
    }
    const mode = this.inputDialogMode
    const value = this.inputDialogValue.trim()
    const targetPath = this.inputDialogTargetPath
    const remotePath = this.inputDialogRemotePath
    this.cancelInputDialog()

    if (!value || !targetPath) {
      return
    }

    try {
      if (mode === 'local-new-folder') {
        const dir = targetPath
        const folderPath = path.join(dir, value)
        await fs.mkdir(folderPath, { recursive: true })
        await this.refreshLocal()
        return
      }

      if (mode === 'local-rename') {
        const from = targetPath
        const to = path.join(this.localPath, value)
        if (path.basename(from) === value) {
          return
        }
        await fs.rename(from, to)
        await this.refreshLocal()
        return
      }

      if (mode === 'remote-new-folder') {
        if (!this.sftpSession) {
          return
        }
        const dir = targetPath
        const folderPath = path.posix.join(dir, value)
        await this.sftpSession.mkdir(folderPath)
        await this.refreshRemote()
        return
      }

      if (mode === 'remote-rename') {
        if (!this.sftpSession || !remotePath) {
          return
        }
        const to = path.posix.join(this.remotePath, value)
        if (path.posix.basename(remotePath) === value) {
          return
        }
        await this.sftpSession.rename(remotePath, to)
        await this.refreshRemote()
      }
    } catch (e) {
      console.error('[SFTP-UI] Input dialog action failed', e)
    }
  }

  remoteEditPermissions (): void {
    if (this.selectedRemote.length !== 1 || !this.remoteActionPerms?.trim() || !this.sftpSession) {
      return
    }
    const entry = this.selectedRemote[0]
    const mode = parseInt(this.remoteActionPerms.trim(), 8)
    if (Number.isNaN(mode)) {
      console.error('[SFTP-UI] Invalid remote permissions value')
      return
    }
    void (this.sftpSession as any).chmod(entry.fullPath, mode)
      .then(() => this.refreshRemote())
      .catch((e: any) => console.error('[SFTP-UI] Remote chmod failed', e))
  }

  remoteShowSize (): void {
    if (this.selectedRemote.length === 1 && this.selectedRemote[0].isDirectory) {
      this.ensureRemoteFolderSize(this.selectedRemote[0])
    }
  }

  remoteDownload (): void {
    if (!this.selectedRemote.length || !this.sftpSession) {
      return
    }
    for (const entry of this.selectedRemote) {
      if (entry.isDirectory) {
        continue
      }
      const targetLocalPath = path.join(this.localPath, entry.name)
      const dl = new LocalPathFileDownload(targetLocalPath, entry.mode, entry.size)
      this.trackTransfer(dl, 'download', entry.fullPath, targetLocalPath)
      void this.sftpSession.download(entry.fullPath, dl)
        .then(() => this.refreshLocal())
        .catch(e => console.error('[SFTP-UI] Remote download failed', e))
    }
  }

  ensureLocalFolderSize (entry: LocalEntry): void {
    if (!entry.isDirectory) {
      return
    }
    if (entry.size !== undefined) {
      return
    }
    if (this.localFolderSizeLoading.has(entry.fullPath)) {
      return
    }
    this.localFolderSizeLoading.add(entry.fullPath)
    void this.computeLocalFolderSize(entry.fullPath)
      .then(size => {
        entry.size = size
      })
      .catch(e => {
        console.error('[SFTP-UI] Local folder size failed', e)
      })
      .finally(() => {
        this.localFolderSizeLoading.delete(entry.fullPath)
      })
  }

  ensureRemoteFolderSize (entry: SFTPFile): void {
    if (!entry.isDirectory) {
      return
    }
    const key = entry.fullPath
    if ((entry as any).dirSize !== undefined) {
      return
    }
    if (this.remoteFolderSizeLoading.has(key)) {
      return
    }
    if (!this.sftpSession || !this.connected) {
      return
    }
    this.remoteFolderSizeLoading.add(key)
    void this.computeRemoteFolderSize(key)
      .then(size => {
        ;(entry as any).dirSize = size
      })
      .catch(e => {
        console.error('[SFTP-UI] Remote folder size failed', e)
      })
      .finally(() => {
        this.remoteFolderSizeLoading.delete(key)
      })
  }

  private async computeLocalFolderSize (root: string): Promise<number> {
    let total = 0
    const stack: string[] = [root]
    const maxEntries = 5000
    let visited = 0
    while (stack.length) {
      const dir = stack.pop() as string
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (visited++ > maxEntries) {
          return total
        }
        const full = path.join(dir, name)
        try {
          const st = await fs.stat(full)
          if (st.isDirectory()) {
            stack.push(full)
          } else {
            total += st.size
          }
        } catch {
          // ignore
        }
      }
    }
    return total
  }

  private async computeRemoteFolderSize (root: string): Promise<number> {
    if (!this.sftpSession) {
      return 0
    }
    let total = 0
    const stack: string[] = [root]
    const maxEntries = 5000
    let visited = 0
    while (stack.length) {
      const dir = stack.pop() as string
      let entries: SFTPFile[]
      try {
        entries = await this.sftpSession.readdir(dir)
      } catch {
        continue
      }
      for (const item of entries) {
        if (visited++ > maxEntries) {
          return total
        }
        if (item.isDirectory) {
          stack.push(item.fullPath)
        } else {
          total += item.size
        }
      }
    }
    return total
  }

  onLocalContextMenu (entry: LocalEntry, event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    // TODO: полноценное контекстное меню. Пока все действия — через нижнюю панель.
  }

  onRemoteContextMenu (entry: SFTPFile, event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()

    if (!this.sftpSession) {
      return
    }
    // TODO: полноценное контекстное меню. Пока все действия — через нижнюю панель.
  }

  private trackTransfer (transfer: FileTransfer, direction: 'upload' | 'download', remotePath: string, localPath: string): void {
    this.transfers.push({
      transfer,
      direction,
      name: transfer.getName(),
      remotePath,
      localPath,
    })
  }

  cancelTransfer (entry: { transfer: FileTransfer }): void {
    try {
      if (entry.transfer.isComplete() || entry.transfer.isCancelled()) {
        return
      }
      entry.transfer.cancel?.()
    } catch (e) {
      console.error('[SFTP-UI] Cancel transfer failed', e)
    }
  }

  getTransferProgress (transfer: FileTransfer): number {
    try {
      const total = transfer.getSize?.()
      const done = transfer.getCompletedBytes?.()
      if (typeof total !== 'number' || total <= 0 || typeof done !== 'number' || done < 0) {
        return transfer.isComplete() ? 100 : 0
      }
      const value = (done / total) * 100
      const clamped = Math.max(0, Math.min(100, value))
      return clamped
    } catch {
      return transfer.isComplete() ? 100 : 0
    }
  }

  onKeyDown (event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null
    const isTypingTarget = Boolean(target) && (
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      (target as any)?.isContentEditable
    )

    if (event.key === 'Escape') {
      if (this.inputDialogVisible) {
        event.preventDefault()
        this.cancelInputDialog()
        return
      }
      if (this.deleteConfirmVisible) {
        event.preventDefault()
        this.cancelDelete()
        return
      }
      if (this.replaceConfirmVisible) {
        event.preventDefault()
        this.cancelReplace()
        return
      }
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Don't intercept Delete/Backspace while typing in inputs
      if (isTypingTarget) {
        return
      }
      event.preventDefault()
      if (this.selectedRemote.length) {
        this.remoteDelete()
      } else if (this.selectedLocal.length) {
        this.localDelete()
      }
    }
  }

  override destroy (): void {
    // stop file watchers for opened remote files
    for (const { watcher } of this.openedRemoteFiles.values()) {
      try {
        watcher?.close()
      } catch {
        // ignore
      }
    }
    this.openedRemoteFiles.clear()

    void this.disconnect()
    if (this.transfersTimer !== null) {
      clearInterval(this.transfersTimer)
      this.transfersTimer = null
    }
    super.destroy()
  }

  // Prevent Tabby from restoring SFTP-UI tabs across restarts, since they rely
  // on a live SSH session from a terminal tab.
  // Typинги допускают RecoveryToken | null, нам достаточно всегда возвращать null.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async getRecoveryToken (_options?: any): Promise<null> {
    return null
  }

  async confirmDelete (): Promise<void> {
    if (!this.deleteConfirmVisible) {
      return
    }
    const mode = this.deleteConfirmMode
    this.deleteConfirmVisible = false

    try {
      if (mode === 'local') {
        const toDelete = this.pendingLocalDelete.slice()
        this.pendingLocalDelete = []
        for (const entry of toDelete) {
          await this.deleteLocalEntry(entry)
        }
        await this.refreshLocal()
        this.selectedLocal = []
      } else if (mode === 'remote' && this.sftpSession) {
        const toDelete = this.pendingRemoteDelete.slice()
        this.pendingRemoteDelete = []
        for (const entry of toDelete) {
          await this.deleteRemoteEntry(entry)
        }
        await this.refreshRemote()
        this.selectedRemote = []
      }
    } catch (e) {
      console.error('[SFTP-UI] Delete failed', e)
    } finally {
      this.deleteConfirmMode = null
      this.deleteConfirmText = ''
    }
  }

  cancelDelete (): void {
    this.deleteConfirmVisible = false
    this.deleteConfirmMode = null
    this.deleteConfirmText = ''
    this.pendingLocalDelete = []
    this.pendingRemoteDelete = []
  }

  private async showReplaceConfirm (text: string): Promise<boolean> {
    if (this.replaceConfirmVisible) {
      // Prevent stacking multiple confirmations; choose the latest replacement intent.
      return false
    }
    this.replaceConfirmText = text
    this.replaceConfirmVisible = true
    return new Promise(resolve => {
      this.replaceConfirmResolve = resolve
    })
  }

  async confirmReplace (): Promise<void> {
    if (!this.replaceConfirmVisible) {
      return
    }
    this.replaceConfirmVisible = false
    const resolve = this.replaceConfirmResolve
    this.replaceConfirmResolve = null
    this.replaceConfirmText = ''
    resolve?.(true)
  }

  cancelReplace (): void {
    if (!this.replaceConfirmVisible) {
      return
    }
    this.replaceConfirmVisible = false
    const resolve = this.replaceConfirmResolve
    this.replaceConfirmResolve = null
    this.replaceConfirmText = ''
    resolve?.(false)
  }

  private async deleteLocalEntry (entry: LocalEntry): Promise<void> {
    await this.deleteLocalPathRecursive(entry.fullPath)
  }

  private async deleteRemoteEntry (entry: SFTPFile): Promise<void> {
    if (!this.sftpSession) {
      return
    }
    await this.deleteRemotePathRecursive(entry.fullPath)
  }

  private buildDeleteConfirmText (scope: 'local' | 'remote', names: string[]): string {
    const total = names.length
    const label = scope === 'local' ? 'local' : 'remote'
    if (!total) {
      return `Delete 0 item(s) from ${label}?`
    }
    const maxShown = 5
    const shown = names.slice(0, maxShown)
    const list = shown.join(', ')
    if (total <= maxShown) {
      return `Delete ${total} item(s) from ${label}: ${list}?`
    }
    const rest = total - maxShown
    return `Delete ${total} item(s) from ${label}: ${list} and ${rest} more?`
  }

  private async deleteLocalPathRecursive (target: string): Promise<void> {
    try {
      const st = await fs.stat(target)
      if (!st.isDirectory()) {
        await fs.unlink(target)
        return
      }
    } catch (e) {
      console.error('[SFTP-UI] Local delete failed (stat)', e)
      return
    }

    try {
      const names = await fs.readdir(target)
      for (const name of names) {
        const child = path.join(target, name)
        await this.deleteLocalPathRecursive(child)
      }
      await fs.rmdir(target)
    } catch (e) {
      console.error('[SFTP-UI] Local recursive delete failed', e)
    }
  }

  private async deleteRemotePathRecursive (target: string): Promise<void> {
    if (!this.sftpSession) {
      return
    }
    try {
      const entries = await this.sftpSession.readdir(target).catch(() => null as any)
      if (!entries) {
        // treat as file
        try {
          await this.sftpSession.unlink(target)
        } catch (e) {
          console.error('[SFTP-UI] Remote delete failed', e)
        }
        return
      }
      for (const item of entries as SFTPFile[]) {
        const full = item.fullPath
        if (item.isDirectory) {
          await this.deleteRemotePathRecursive(full)
        } else {
          try {
            await this.sftpSession.unlink(full)
          } catch (e) {
            console.error('[SFTP-UI] Remote unlink failed', e)
          }
        }
      }
      try {
        await this.sftpSession.rmdir(target)
      } catch (e) {
        console.error('[SFTP-UI] Remote rmdir failed', e)
      }
    } catch (e) {
      console.error('[SFTP-UI] Remote recursive delete failed', e)
    }
  }

  private async openRemoteFile (entry: SFTPFile): Promise<void> {
    if (!this.sftpSession || !this.connected || entry.isDirectory) {
      return
    }
    try {
      const tmpRoot = path.join(os.tmpdir(), 'tabby-sftp-ui')
      await fs.mkdir(tmpRoot, { recursive: true })
      const hash = crypto.createHash('sha1').update(entry.fullPath).digest('hex').slice(0, 10)
      const safeName = entry.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      const localPath = path.join(tmpRoot, `${hash}-${safeName}`)

      // если уже есть watcher на этот файл – закроем его и перезапишем
      const existing = this.openedRemoteFiles.get(localPath)
      if (existing?.watcher) {
        try {
          existing.watcher.close()
        } catch {
          // ignore
        }
      }
      if (existing?.debounceTimer != null) {
        try {
          clearTimeout(existing.debounceTimer)
        } catch {
          // ignore
        }
      }

      const dl = new LocalPathFileDownload(localPath, entry.mode, entry.size)
      this.trackTransfer(dl, 'download', entry.fullPath, localPath)
      await this.sftpSession.download(entry.fullPath, dl)

      // настроим наблюдение за изменениями локального файла
      const schedule = () => this.scheduleSyncBackRemoteFile(localPath)
      const watcher = fsSync.watch(localPath, { persistent: false }, (eventType) => {
        // Many editors save atomically (rename) or emit multiple change events.
        if (eventType === 'change' || eventType === 'rename') {
          schedule()
        }
      })
      this.openedRemoteFiles.set(localPath, {
        remotePath: entry.fullPath,
        mode: entry.mode,
        watcher,
        debounceTimer: null,
        syncing: false,
        pending: false,
        lastUploadedSignature: null,
      })

      this.platform.openPath(localPath)
    } catch (e) {
      console.error('[SFTP-UI] Open remote file failed', e)
    }
  }

  private scheduleSyncBackRemoteFile (localPath: string): void {
    const info = this.openedRemoteFiles.get(localPath)
    if (!info) {
      return
    }
    if (info.debounceTimer != null) {
      clearTimeout(info.debounceTimer)
    }
    // Debounce a burst of editor save events
    info.debounceTimer = window.setTimeout(() => {
      info.debounceTimer = null
      void this.syncBackRemoteFile(localPath)
    }, 650)
  }

  private async waitForStableLocalFile (localPath: string): Promise<{ size: number, mtimeMs: number } | null> {
    // Wait until the file stops changing (editors often write in multiple passes)
    let last: { size: number, mtimeMs: number } | null = null
    for (let i = 0; i < 10; i++) {
      const st = await fs.stat(localPath).catch(() => null)
      if (!st || !st.isFile()) {
        return null
      }
      const cur = { size: st.size, mtimeMs: st.mtimeMs }
      if (last && cur.size === last.size && cur.mtimeMs === last.mtimeMs) {
        // stable for one interval
        return cur
      }
      last = cur
      await new Promise(resolve => setTimeout(resolve, 180))
    }
    return last
  }

  private async syncBackRemoteFile (localPath: string): Promise<void> {
    if (!this.sftpSession || !this.connected) {
      return
    }
    const info = this.openedRemoteFiles.get(localPath)
    if (!info) {
      return
    }
    if (info.syncing) {
      info.pending = true
      return
    }
    info.syncing = true
    try {
      const stable = await this.waitForStableLocalFile(localPath)
      if (!stable) {
        return
      }
      const signature = `${stable.size}:${stable.mtimeMs}`
      if (info.lastUploadedSignature === signature) {
        return
      }
      const upload = new LocalPathFileUpload(localPath)
      this.trackTransfer(upload, 'upload', info.remotePath, localPath)
      await this.sftpSession.upload(info.remotePath, upload)
      info.lastUploadedSignature = signature
      await this.refreshRemote()
    } catch (e) {
      console.error('[SFTP-UI] Sync-back remote file failed', e)
    } finally {
      info.syncing = false
      if (info.pending) {
        info.pending = false
        this.scheduleSyncBackRemoteFile(localPath)
      }
    }
  }
}

