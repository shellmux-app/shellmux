import { useCallback, useEffect, useState } from 'react'

import { vaultApi } from '../../lib/ipc'
import type { KnownHost } from '../../lib/types'
import { useDialog } from '../../state/useDialog'
import { describe } from '../../state/useVault'

/**
 * Danh sách host key đã tin cậy. Cần một chỗ để xem và thu hồi: khi server bị
 * cài lại, người dùng phải tự gỡ key cũ rồi xác nhận key mới, chứ app không
 * được im lặng ghi đè.
 */
export function KnownHostsScreen() {
  const { confirm } = useDialog()
  const [items, setItems] = useState<KnownHost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [needle, setNeedle] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await vaultApi.listKnownHosts())
      setError(null)
    } catch (e) {
      setError(describe(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const forget = async (entry: KnownHost) => {
    const ok = await confirm({
      title: `Thu hồi tin cậy ${entry.host}:${entry.port}?`,
      body: 'Lần kết nối tới đây tiếp theo sẽ hỏi lại fingerprint để bạn xác nhận.',
      confirmLabel: 'Thu hồi',
      danger: true,
    })
    if (!ok) return
    try {
      await vaultApi.forgetHostKey(entry.host, entry.port)
      await load()
    } catch (e) {
      setError(describe(e))
    }
  }

  const visible = items.filter((entry) =>
    `${entry.host} ${entry.fingerprint} ${entry.algo}`
      .toLowerCase()
      .includes(needle.toLowerCase()),
  )

  return (
    <div className="screen">
      <div className="screen-bar">
        <div className="screen-search">
          <input
            value={needle}
            placeholder="Tìm theo host hoặc fingerprint"
            aria-label="Tìm known host"
            onChange={(e) => setNeedle(e.target.value)}
          />
        </div>
        <button className="btn-outline" onClick={() => void load()}>
          Tải lại
        </button>
      </div>

      <div className="screen-body">
        {error && <p className="error">{error}</p>}

        {loading ? (
          <div className="skeleton-rows">
            {[70, 58, 64, 46].map((width, i) => (
              <div key={i} className="skeleton-row" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : visible.length > 0 ? (
          <ul className="rows">
            {visible.map((entry) => (
              <li key={`${entry.host}:${entry.port}`}>
                <span className="row-name">
                  {entry.host}
                  {entry.port !== 22 ? `:${entry.port}` : ''}
                </span>
                <span className="badge">{entry.algo}</span>
                <code className="row-meta">{entry.fingerprint}</code>
                <span className="row-tools">
                  <button className="btn-quiet" onClick={() => void forget(entry)}>
                    Thu hồi
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="placeholder">
            <strong>{items.length === 0 ? 'Chưa tin cậy host nào' : 'Không khớp kết quả'}</strong>
            <p>
              {items.length === 0
                ? 'Lần đầu kết nối tới một máy chủ, Shellmux sẽ hiện fingerprint để bạn xác nhận. Sau khi tin cậy, nó xuất hiện ở đây.'
                : 'Thử từ khoá khác.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
