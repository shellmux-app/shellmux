import { useEffect, useState } from 'react'

import { HostDialog } from './components/HostDialog'
import { HostKeyPrompt } from './components/HostKeyPrompt'
import { HostsScreen } from './components/screens/HostsScreen'
import { KeychainScreen } from './components/screens/KeychainScreen'
import { KnownHostsScreen } from './components/screens/KnownHostsScreen'
import { SnippetsScreen } from './components/screens/SnippetsScreen'
import { NavRail, type ScreenId } from './components/shell/NavRail'
import { TunnelPanel } from './components/TunnelPanel'
import { DialogHost } from './components/ui/DialogHost'
import { Workspace } from './components/Workspace'
import { onSessionClosed, startBus } from './lib/bus'
import { sshConfigApi } from './lib/ipc'
import type { Host } from './lib/types'
import { useDialog } from './state/useDialog'
import { useTheme } from './state/useTheme'
import { describe, useVault } from './state/useVault'
import { useWorkspace } from './state/useWorkspace'

type Overlay =
  | { kind: 'none' }
  | { kind: 'host'; host: Host | null }
  | { kind: 'tunnels'; sessionId: string; hostId: string }

export default function App() {
  const { hosts, identities, snippets, load, error: vaultError } = useVault()
  const initTheme = useTheme((s) => s.init)
  const confirm = useDialog((s) => s.confirm)
  const {
    tabs,
    activeTabId,
    focusTab,
    closeTab,
    openSsh,
    openLocal,
    markClosed,
    error,
    clearError,
  } = useWorkspace()

  const [screen, setScreen] = useState<ScreenId>('hosts')
  /** Đang xem một session, hay đang xem một màn quản lý. */
  const [inSession, setInSession] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' })
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    startBus()
    void load()
    const stopTheme = initTheme()
    const stopBus = onSessionClosed((sessionId, reason, generation) =>
      markClosed(sessionId, reason, generation),
    )
    return () => {
      stopTheme()
      stopBus()
    }
  }, [load, markClosed, initTheme])

  const connect = async (hostId: string) => {
    await openSsh(hostId)
    setInSession(true)
  }

  const openLocalShell = async () => {
    await openLocal()
    setInSession(true)
  }

  const importSshConfig = async () => {
    const path = await sshConfigApi.path().catch(() => null)
    const ok = await confirm({
      title: 'Import từ ~/.ssh/config',
      body: `Đọc ${path ?? '~/.ssh/config'} và tạo host tương ứng. Host đã import trước đó sẽ được cập nhật theo file, không tạo bản sao.`,
      confirmLabel: 'Import',
    })
    if (!ok) return

    try {
      const report = await sshConfigApi.import()
      await load()
      const parts = [`${report.hosts} host`, `${report.identities} key`]
      if (report.jumpsLinked > 0) parts.push(`${report.jumpsLinked} jump host`)
      if (report.unresolvedJumps.length > 0) {
        parts.push(`jump chưa rõ: ${report.unresolvedJumps.join(', ')}`)
      }
      if (report.includesSkipped > 0) parts.push(`${report.includesSkipped} Include bỏ qua`)
      setNote(parts.join(' · '))
      setScreen('hosts')
      setInSession(false)
    } catch (e) {
      setNote(describe(e))
    }
  }

  const goToScreen = (next: ScreenId) => {
    setScreen(next)
    setInSession(false)
  }

  return (
    <div className="app">
      <NavRail
        active={inSession ? ('hosts' as ScreenId) : screen}
        onSelect={goToScreen}
        counts={{
          hosts: hosts.length,
          keychain: identities.length,
          snippets: snippets.length,
          knownHosts: 0,
        }}
        onImport={() => void importSshConfig()}
      />

      <main className="main">
        <nav className="tabstrip">
          <span
            className={`tab ${!inSession ? 'active' : ''}`}
            onClick={() => setInSession(false)}
          >
            Quản lý
          </span>

          {tabs.map((tab) => (
            <span
              key={tab.id}
              className={`tab ${inSession && tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => {
                focusTab(tab.id)
                setInSession(true)
              }}
            >
              {tab.title}
              <button
                className="btn-quiet"
                aria-label={`Đóng ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(tab.id)
                  if (tabs.length <= 1) setInSession(false)
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </nav>

        {inSession ? (
          <Workspace
            onOpenTunnels={(sessionId, hostId) =>
              setOverlay({ kind: 'tunnels', sessionId, hostId })
            }
          />
        ) : screen === 'hosts' ? (
          <HostsScreen
            onConnect={(hostId) => void connect(hostId)}
            onEditHost={(host) => setOverlay({ kind: 'host', host })}
            onOpenLocal={() => void openLocalShell()}
          />
        ) : screen === 'keychain' ? (
          <KeychainScreen />
        ) : screen === 'snippets' ? (
          <SnippetsScreen />
        ) : (
          <KnownHostsScreen />
        )}
      </main>

      {overlay.kind === 'host' && (
        <HostDialog host={overlay.host} onClose={() => setOverlay({ kind: 'none' })} />
      )}
      {overlay.kind === 'tunnels' && (
        <TunnelPanel
          sessionId={overlay.sessionId}
          hostId={overlay.hostId}
          onClose={() => setOverlay({ kind: 'none' })}
        />
      )}

      <HostKeyPrompt />
      <DialogHost />

      {note && (
        <div className="toast" role="status" onClick={() => setNote(null)}>
          <span>{note}</span>
          <span className="toast-dismiss">Bấm để ẩn</span>
        </div>
      )}

      {(error || vaultError) && (
        <div className="toast" role="alert" onClick={clearError}>
          <span>{error ?? vaultError}</span>
          <span className="toast-dismiss">Bấm để ẩn</span>
        </div>
      )}
    </div>
  )
}
