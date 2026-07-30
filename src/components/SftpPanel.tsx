import { useCallback, useEffect, useState } from 'react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  DownloadSimpleIcon,
  FolderPlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'

import { sftpApi } from '../lib/ipc'
import type { RemoteEntry } from '../lib/types'
import { useDialog } from '../state/useDialog'
import { describe } from '../state/useVault'

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

  /** Run an operation then reload the listing, keeping error handling in one place. */
  const run = async (action: () => Promise<string>) => {
    try {
      const message = await action()
      setStatus({ text: message, isError: false })
      await refresh(path)
    } catch (e) {
      setStatus({ text: describe(e), isError: true })
    }
  }

  const download = async (entry: RemoteEntry) => {
    const target = await saveDialog({ defaultPath: entry.name })
    if (!target) return
    setLoading(true)
    try {
      const bytes = await sftpApi.download(sessionId, entry.path, target)
      setStatus({ text: `Downloaded ${formatSize(bytes)} to ${target}`, isError: false })
    } catch (e) {
      setStatus({ text: describe(e), isError: true })
    } finally {
      setLoading(false)
    }
  }

  const upload = async () => {
    const picked = await openDialog({ multiple: false })
    if (typeof picked !== 'string') return
    const name = picked.split('/').pop() ?? 'upload.bin'
    await run(async () => {
      const bytes = await sftpApi.upload(sessionId, picked, `${path}/${name}`)
      return `Uploaded ${name} (${formatSize(bytes)})`
    })
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
    await run(async () => {
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
    await run(async () => {
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
    await run(async () => {
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
        <button className="btn-outline" onClick={() => void mkdir()}>
          <FolderPlusIcon />
          New folder
        </button>
        <button className="btn-primary" onClick={() => void upload()}>
          <UploadSimpleIcon />
          Upload
        </button>
      </header>

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
                      <button className="btn-quiet" onClick={() => void rename(entry)}>
                        <PencilSimpleIcon />
                        Rename
                      </button>
                      <button className="btn-quiet" onClick={() => void remove(entry)}>
                        <TrashIcon />
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
