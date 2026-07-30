import { useCallback, useEffect, useState } from 'react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'

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

/** File browser chạy trên đúng connection SSH của session, không dial lại. */
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

  /** Chạy một thao tác rồi tải lại danh sách, gom xử lý lỗi về một chỗ. */
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
      setStatus({ text: `Đã tải ${formatSize(bytes)} về ${target}`, isError: false })
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
      return `Đã đẩy lên ${name} (${formatSize(bytes)})`
    })
  }

  const mkdir = async () => {
    const name = await ask({
      title: 'Thư mục mới',
      label: 'Tên thư mục',
      placeholder: 'releases',
      hint: `Tạo trong ${path}`,
      confirmLabel: 'Tạo',
    })
    if (!name) return
    await run(async () => {
      await sftpApi.mkdir(sessionId, `${path}/${name}`)
      return `Đã tạo ${name}`
    })
  }

  const rename = async (entry: RemoteEntry) => {
    const name = await ask({
      title: 'Đổi tên',
      label: 'Tên mới',
      value: entry.name,
      confirmLabel: 'Đổi tên',
    })
    if (!name || name === entry.name) return
    await run(async () => {
      await sftpApi.rename(sessionId, entry.path, `${parentOf(entry.path)}/${name}`)
      return `Đã đổi thành ${name}`
    })
  }

  const remove = async (entry: RemoteEntry) => {
    const ok = await confirm({
      title: `Xoá ${entry.name}?`,
      body: entry.isDir
        ? 'Thư mục phải rỗng mới xoá được. Hành động này không hoàn tác được.'
        : 'Hành động này không hoàn tác được.',
      confirmLabel: 'Xoá',
      danger: true,
    })
    if (!ok) return
    await run(async () => {
      await sftpApi.remove(sessionId, entry.path, entry.isDir)
      return `Đã xoá ${entry.name}`
    })
  }

  return (
    <div className="sftp">
      <header className="sftp-bar">
        <button
          className="btn-outline"
          onClick={() => void refresh(parentOf(path))}
          disabled={path === '/'}
          title="Lên thư mục cha"
        >
          Lên
        </button>
        <input
          className="sftp-path"
          value={draftPath}
          aria-label="Đường dẫn remote"
          onChange={(e) => setDraftPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void refresh(draftPath)
            if (e.key === 'Escape') setDraftPath(path)
          }}
        />
        <button className="btn-outline" onClick={() => void refresh(path)}>
          Tải lại
        </button>
        <button className="btn-outline" onClick={() => void mkdir()}>
          Thư mục mới
        </button>
        <button className="btn-primary" onClick={() => void upload()}>
          Tải lên
        </button>
      </header>

      <div className="sftp-list">
        {loading && entries.length === 0 ? (
          <div className="skeleton-rows" aria-busy="true" aria-label="Đang tải danh sách">
            {[72, 54, 63, 45, 58, 40].map((width, i) => (
              <div key={i} className="skeleton-row" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tên</th>
                <th>Kích thước</th>
                <th>Sửa lần cuối</th>
                <th>Quyền</th>
                <th>Chủ sở hữu</th>
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
                          Mở
                        </button>
                      ) : (
                        <button className="btn-quiet" onClick={() => void download(entry)}>
                          Tải về
                        </button>
                      )}
                      <button className="btn-quiet" onClick={() => void rename(entry)}>
                        Đổi tên
                      </button>
                      <button className="btn-quiet" onClick={() => void remove(entry)}>
                        Xoá
                      </button>
                    </span>
                  </td>
                </tr>
              ))}

              {entries.length === 0 && !loading && (
                <tr>
                  <td colSpan={6}>
                    <div className="placeholder">
                      <strong>Thư mục rỗng</strong>
                      <p>Dùng nút Tải lên để đẩy file vào {path}.</p>
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
