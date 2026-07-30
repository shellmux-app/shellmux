import { useCallback, useEffect, useState } from 'react'
import { ArrowClockwiseIcon, MagnifyingGlassIcon, ProhibitIcon } from '@phosphor-icons/react'

import { vaultApi } from '../../lib/ipc'
import type { KnownHost } from '../../lib/types'
import { useDialog } from '../../state/useDialog'
import { describe } from '../../state/useVault'

/**
 * List of trusted host keys. This needs a place to view and revoke entries:
 * when a server is reinstalled, the user must remove the old key themselves
 * and confirm the new one — the app must never silently overwrite it.
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
      title: `Revoke trust for ${entry.host}:${entry.port}?`,
      body: 'The next connection to this host will ask you to confirm the fingerprint again.',
      confirmLabel: 'Revoke',
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
        <div className="screen-search standalone">
          <MagnifyingGlassIcon className="screen-search-icon" aria-hidden />
          <input
            value={needle}
            placeholder="Search by host or fingerprint"
            aria-label="Search known hosts"
            onChange={(e) => setNeedle(e.target.value)}
          />
        </div>
        <button className="btn-outline" onClick={() => void load()}>
          <ArrowClockwiseIcon />
          Reload
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
                    <ProhibitIcon />
                    Revoke
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="placeholder">
            <strong>{items.length === 0 ? 'No trusted hosts yet' : 'No matches'}</strong>
            <p>
              {items.length === 0
                ? 'The first time you connect to a server, Shellmux will show its fingerprint for you to confirm. Once trusted, it appears here.'
                : 'Try a different search term.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
