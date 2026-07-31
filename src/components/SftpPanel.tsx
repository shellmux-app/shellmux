import { useCallback, useEffect, useState } from 'react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CircleNotchIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  FolderPlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'

import { sftpApi } from '../lib/ipc'
import type { RemoteEntry } from '../lib/types'
import { useDialog } from '../state/useDialog'
import { useTransfers } from '../state/useTransfers'
import { describe } from '../state/useVault'
import { TransferQueue } from './TransferQueue'

interface Props {
  sessionId: string
}

interface Status {
  text: string
  isError: boolean
}

const EMPTY_CELL = '-'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

function formatMode(mode: number | null): string {
  if (mode === null) return EMPTY_CELL
  return (mode & 0o777).toString(8).padStart(3, '0')
}

function formatTime(seconds: number | null): string {
  if (!seconds) return EMPTY_CELL
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function parentOf(path: string): string {
  if (path === '/' || path === '') return '/'
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

/** File browser runs over the session's existing SSH connection, without dialing again. */
export function SftpPanel({ sessionId }: Props) {
  const { ask, confirm } = useDialog()
  const [path, setPath] = useState('.')
  const [draftPath, setDraftPath] = useState('.')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [queueOpen, setQueueOpen] = useState(false)
  /** Key of the mutation currently in flight (e.g. `rename:/etc/hosts`), or
   * null. Uploads/downloads go through the transfer queue instead — see
   * `enqueueDownload`/`enqueueUpload` — so only quick metadata ops (mkdir,
   * rename, delete) still block on this. */
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const enqueueTransfer = useTransfers((s) => s.enqueue)
  const transferCount = useTransfers(
    (s) => s.items.filter((t) => t.status === 'active' || t.status === 'queued').length,
  )

  const refresh = useCallback(
    async (target: string) => {
      setLoading(true)
      try {
        const canonical = await sftpApi.canonicalize(sessionId, target)
        const list = await sftpApi.list(sessionId, canonical)
        setPath(canonical)
        setDraftPath(canonical)
        setEntries(list)
        setStatus(null)
      } catch (e) {
        setStatus({ text: describe(e), isError: true })
      } finally {
        setLoading(false)
      }
    },
    [sessionId],
  )

  useEffect(() => {
    void refresh('.')
  }, [refresh])

  /** Run an operation then reload the listing, keeping error handling and the
   * busy indicator in one place. `key` identifies which control shows the spinner. */
  const run = async (key: string, action: () => Promise<string>) => {
    setBusyAction(key)
    try {
      const message = await action()
      setStatus({ text: message, isError: false })
      await refresh(path)
    } catch (e) {
      setStatus({ text: describe(e), isError: true })
    } finally {
      setBusyAction(null)
    }
  }

  const download = async (entry: RemoteEntry) => {
    const target = await saveDialog({ defaultPath: entry.name })
    if (!target) return
    enqueueTransfer({
      id: crypto.randomUUID(),
      sessionId,
      direction: 'download',
      label: entry.name,
      localPath: target,
      remotePath: entry.path,
    })
    setStatus({ text: `Queued download of ${entry.name} — see Transfers`, isError: false })
  }

  const upload = async () => {
    const picked = await openDialog({ multiple: false })
    if (typeof picked !== 'string') return
    const name = picked.split('/').pop() ?? 'upload.bin'
    enqueueTransfer({
      id: crypto.randomUUID(),
      sessionId,
      direction: 'upload',
      label: name,
      localPath: picked,
      remotePath: `${path}/${name}`,
    })
    setStatus({ text: `Queued upload of ${name} — see Transfers`, isError: false })
  }

  const mkdir = async () => {
    const name = await ask({
      title: 'New folder',
      label: 'Folder name',
      placeholder: 'releases',
      hint: `Create inside ${path}`,
      confirmLabel: 'Create',
    })
    if (!name) return
    await run('mkdir', async () => {
      await sftpApi.mkdir(sessionId, `${path}/${name}`)
      return `Created ${name}`
    })
  }

  const rename = async (entry: RemoteEntry) => {
    const name = await ask({
      title: 'Rename',
      label: 'New name',
      value: entry.name,
      confirmLabel: 'Rename',
    })
    if (!name || name === entry.name) return
    await run(`rename:${entry.path}`, async () => {
      await sftpApi.rename(sessionId, entry.path, `${parentOf(entry.path)}/${name}`)
      return `Renamed to ${name}`
    })
  }

  const remove = async (entry: RemoteEntry) => {
    const ok = await confirm({
      title: `Delete ${entry.name}?`,
      body: entry.isDir
        ? 'The folder must be empty before it can be deleted. This action cannot be undone.'
        : 'This action cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    await run(`remove:${entry.path}`, async () => {
      await sftpApi.remove(sessionId, entry.path, entry.isDir)
      return `Deleted ${entry.name}`
    })
  }

  return (
    <div className="sftp">
      <header className="sftp-bar">
        <button
          className="btn-outline"
          onClick={() => void refresh(parentOf(path))}
          disabled={path === '/'}
          title="Go to parent folder"
        >
          <ArrowUpIcon />
          Up
        </button>
        <input
          className="sftp-path"
          value={draftPath}
          aria-label="Remote path"
          onChange={(e) => setDraftPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void refresh(draftPath)
            if (e.key === 'Escape') setDraftPath(path)
          }}
        />
        <button className="btn-outline" onClick={() => void refresh(path)}>
          <ArrowClockwiseIcon />
          Reload
        </button>
        <button className="btn-outline" onClick={() => void mkdir()} disabled={busyAction !== null}>
          {busyAction === 'mkdir' ? <CircleNotchIcon className="spin" /> : <FolderPlusIcon />}
          New folder
        </button>
        <button className="btn-outline" onClick={() => setQueueOpen(true)}>
          <ClockCounterClockwiseIcon />
          Transfers
          {transferCount > 0 && <span className="badge">{transferCount}</span>}
        </button>
        <button className="btn-primary" onClick={() => void upload()}>
          <UploadSimpleIcon />
          Upload
        </button>
      </header>

      {queueOpen && <TransferQueue onClose={() => setQueueOpen(false)} />}

      <div className="sftp-list">
        {loading && entries.length === 0 ? (
          <div className="skeleton-rows" aria-busy="true" aria-label="Loading listing">
            {[72, 54, 63, 45, 58, 40].map((width, i) => (
              <div key={i} className="skeleton-row" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
                <th>Permissions</th>
                <th>Owner</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className={selected === entry.path ? 'selected' : undefined}
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() => {
                    if (entry.isDir) void refresh(entry.path)
                  }}
                >
                  <td>
                    <span className="sftp-name">
                      {entry.isDir && <span className="tag is-dir">dir</span>}
                      {entry.isSymlink && <span className="tag">link</span>}
                      {entry.name}
                    </span>
                  </td>
                  <td className="num">{entry.isDir ? EMPTY_CELL : formatSize(entry.size)}</td>
                  <td className="num">{formatTime(entry.modified)}</td>
                  <td className="num">{formatMode(entry.permissions)}</td>
                  <td>{entry.user ?? EMPTY_CELL}</td>
                  <td className="sftp-actions">
                    <span className="row-actions">
                      {entry.isDir ? (
                        <button className="btn-quiet" onClick={() => void refresh(entry.path)}>
                          <ArrowRightIcon />
                          Open
                        </button>
                      ) : (
                        <button className="btn-quiet" onClick={() => void download(entry)}>
                          <DownloadSimpleIcon />
                          Download
                        </button>
                      )}
                      <button
                        className="btn-quiet"
                        onClick={() => void rename(entry)}
                        disabled={busyAction !== null}
                      >
                        {busyAction === `rename:${entry.path}` ? (
                          <CircleNotchIcon className="spin" />
                        ) : (
                          <PencilSimpleIcon />
                        )}
                        Rename
                      </button>
                      <button
                        className="btn-quiet"
                        onClick={() => void remove(entry)}
                        disabled={busyAction !== null}
                      >
                        {busyAction === `remove:${entry.path}` ? (
                          <CircleNotchIcon className="spin" />
                        ) : (
                          <TrashIcon />
                        )}
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))}

              {entries.length === 0 && !loading && (
                <tr>
                  <td colSpan={6}>
                    <div className="placeholder">
                      <strong>Empty folder</strong>
                      <p>Use the Upload button to push files into {path}.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {status && (
        <footer className={`sftp-status ${status.isError ? 'is-error' : ''}`}>
          {status.text}
        </footer>
      )}
    </div>
  )
}
