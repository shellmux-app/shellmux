import { useEffect, useState } from 'react'

import { HostDialog } from './components/HostDialog'
import { HostKeyPrompt } from './components/HostKeyPrompt'
import { IdentityDialog } from './components/IdentityDialog'
import { Sidebar } from './components/Sidebar'
import { SnippetDialog } from './components/SnippetDialog'
import { TunnelPanel } from './components/TunnelPanel'
import { Workspace } from './components/Workspace'
import { onSessionClosed, startBus } from './lib/bus'
import type { Host } from './lib/types'
import { useVault } from './state/useVault'
import { useWorkspace } from './state/useWorkspace'

type Overlay =
  | { kind: 'none' }
  | { kind: 'host'; host: Host | null }
  | { kind: 'identities' }
  | { kind: 'snippets' }
  | { kind: 'tunnels'; sessionId: string; hostId: string }

export default function App() {
  const load = useVault((s) => s.load)
  const vaultError = useVault((s) => s.error)
  const { openSsh, openLocal, markClosed, error, clearError } = useWorkspace()
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' })

  useEffect(() => {
    startBus()
    void load()
    return onSessionClosed((sessionId, reason, generation) =>
      markClosed(sessionId, reason, generation),
    )
  }, [load, markClosed])

  const close = () => setOverlay({ kind: 'none' })

  return (
    <div className="app">
      <Sidebar
        onConnect={(hostId) => void openSsh(hostId)}
        onEditHost={(host) => setOverlay({ kind: 'host', host })}
        onManageIdentities={() => setOverlay({ kind: 'identities' })}
        onManageSnippets={() => setOverlay({ kind: 'snippets' })}
        onOpenLocal={() => void openLocal()}
      />

      <Workspace
        onOpenTunnels={(sessionId, hostId) =>
          setOverlay({ kind: 'tunnels', sessionId, hostId })
        }
      />

      {overlay.kind === 'host' && <HostDialog host={overlay.host} onClose={close} />}
      {overlay.kind === 'identities' && <IdentityDialog onClose={close} />}
      {overlay.kind === 'snippets' && <SnippetDialog onClose={close} />}
      {overlay.kind === 'tunnels' && (
        <TunnelPanel
          sessionId={overlay.sessionId}
          hostId={overlay.hostId}
          onClose={close}
        />
      )}

      <HostKeyPrompt />

      {(error || vaultError) && (
        <div className="toast" onClick={clearError}>
          {error ?? vaultError}
          <span className="toast-hint">bấm để ẩn</span>
        </div>
      )}
    </div>
  )
}
