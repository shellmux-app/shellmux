import { useState } from 'react'
import { ArrowClockwiseIcon, CircleNotchIcon, MagnifyingGlassIcon, ProhibitIcon } from '@phosphor-icons/react'

import type { KnownHost } from '../../lib/types'
import { useDialog } from '../../state/useDialog'
import { describe, useVault } from '../../state/useVault'

/**
 * List of trusted host keys. This needs a place to view and revoke entries:
 * when a server is reinstalled, the user must remove the old key themselves
 * and confirm the new one — the app must never silently overwrite it.
 */
export function KnownHostsScreen() {
  const { knownHosts, ready, load, forgetKnownHost } = useVault()
  const { confirm } = useDialog()
  const [needle, setNeedle] = useState('')
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = async () => {
    setReloading(true)
    try {
      await load()
    } finally {
      setReloading(false)
    }
  }

  const forget = async (entry: KnownHost) => {
    const ok = await confirm({
      title: `Revoke trust for ${entry.host}:${entry.port}?`,
      body: 'The next connection to this host will ask you to confirm the fingerprint again.',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (!ok) return
    try {
      await forgetKnownHost(entry.host, entry.port)
      setError(null)
    } catch (e) {
      setError(describe(e))
    }
  }

  const visible = knownHosts.filter((entry) =>
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
        <button className="btn-outline" onClick={() => void reload()} disabled={reloading}>
          {reloading ? <CircleNotchIcon className="spin" /> : <ArrowClockwiseIcon />}
          Reload
        </button>
      </div>

      <div className="screen-body">
        {error && <p className="error">{error}</p>}

        {!ready ? (
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
            <strong>{knownHosts.length === 0 ? 'No trusted hosts yet' : 'No matches'}</strong>
            <p>
              {knownHosts.length === 0
                ? 'The first time you connect to a server, Shellmux will show its fingerprint for you to confirm. Once trusted, it appears here.'
                : 'Try a different search term.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
