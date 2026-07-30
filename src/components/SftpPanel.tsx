import { useCallback, useEffect, useState } from 'react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'

import { sftpApi } from '../lib/ipc'
import type { RemoteEntry } from '../lib/types'
import { describe } from '../state/useVault'

interface Props {
  sessionId: string
}

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
  if (mode === null) return '—'
  return (mode & 0o777).toString(8).padStart(3, '0')
}

function parentOf(path: string): string {
  if (path === '/' || path === '') return '/'
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  if (cut <= 0) return '/'
  return trimmed.slice(0, cut)
}

/** File browser chạy trên đúng connection SSH của session — không dial lại. */
export function SftpPanel({ sessionId }: Props) {
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(
    async (target: string) => {
      setBusy(true)
      try {
        const canonical = await sftpApi.canonicalize(sessionId, target)
        const list = await sftpApi.list(sessionId, canonical)
        setPath(canonical)
        setEntries(list)
        setStatus(null)
      } catch (e) {
        setStatus(describe(e))
      } finally {
        setBusy(false)
      }
    },
    [sessionId],
  )

  useEffect(() => {
    void refresh('.')
  }, [refresh])

  const enter = (entry: RemoteEntry) => {
    if (entry.isDir) void refresh(entry.path)
    else setSelected(entry.path)
  }

  const download = async (entry: RemoteEntry) => {
    const target = await saveDialog({ defaultPath: entry.name })
    if (!target) return
    setBusy(true)
    try {
      const bytes = await sftpApi.download(sessionId, entry.path, target)
      setStatus(`đã tải ${formatSize(bytes)} → ${target}`)
    } catch (e) {
      setStatus(describe(e))
    } finally {
      setBusy(false)
    }
  }

  const upload = async () => {
    const picked = await openDialog({ multiple: false })
    if (typeof picked !== 'string') return
    const name = picked.split('/').pop() ?? 'upload.bin'
    setBusy(true)
    try {
      const bytes = await sftpApi.upload(sessionId, picked, `${path}/${name}`)
      setStatus(`đã đẩy lên ${formatSize(bytes)}`)
      await refresh(path)
    } catch (e) {
      setStatus(describe(e))
    } finally {
      setBusy(false)
    }
  }

  const mkdir = async () => {
    const name = window.prompt('Tên thư mục mới')
    if (!name) return
    try {
      await sftpApi.mkdir(sessionId, `${path}/${name}`)
      await refresh(path)
    } catch (e) {
      setStatus(describe(e))
    }
  }

  const rename = async (entry: RemoteEntry) => {
    const name = window.prompt('Tên mới', entry.name)
    if (!name || name === entry.name) return
    try {
      await sftpApi.rename(sessionId, entry.path, `${parentOf(entry.path)}/${name}`)
      await refresh(path)
    } catch (e) {
      setStatus(describe(e))
    }
  }

  const remove = async (entry: RemoteEntry) => {
    const ok = window.confirm(`Xoá ${entry.isDir ? 'thư mục' : 'file'} ${entry.name}?`)
    if (!ok) return
    try {
      await sftpApi.remove(sessionId, entry.path, entry.isDir)
      await refresh(path)
    } catch (e) {
      setStatus(describe(e))
    }
  }

  return (
    <div className="sftp">
      <header className="sftp-bar">
        <button onClick={() => void refresh(parentOf(path))} title="Lên một cấp">
          ↑
        </button>
        <input
          className="sftp-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void refresh(path)
          }}
        />
        <button onClick={() => void refresh(path)} disabled={busy}>
          Refresh
        </button>
        <button onClick={() => void mkdir()}>+ Dir</button>
        <button onClick={() => void upload()}>Upload</button>
      </header>

      <div className="sftp-list">
        <table>
          <thead>
            <tr>
              <th>Tên</th>
              <th>Kích thước</th>
              <th>Mode</th>
              <th>Owner</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.path}
                className={selected === entry.path ? 'selected' : undefined}
                onDoubleClick={() => enter(entry)}
                onClick={() => setSelected(entry.path)}
              >
                <td>
                  <span className="sftp-icon">
                    {entry.isDir ? '📁' : entry.isSymlink ? '🔗' : '📄'}
                  </span>
                  {entry.name}
                </td>
                <td>{entry.isDir ? '—' : formatSize(entry.size)}</td>
                <td>{formatMode(entry.permissions)}</td>
                <td>{entry.user ?? '—'}</td>
                <td className="sftp-actions">
                  {!entry.isDir && (
                    <button onClick={() => void download(entry)} title="Tải xuống">
                      ⬇
                    </button>
                  )}
                  <button onClick={() => void rename(entry)} title="Đổi tên">
                    ✎
                  </button>
                  <button onClick={() => void remove(entry)} title="Xoá">
                    🗑
                  </button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && !busy && (
              <tr>
                <td colSpan={5} className="empty">
                  thư mục trống
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {status && <footer className="sftp-status">{status}</footer>}
    </div>
  )
}
