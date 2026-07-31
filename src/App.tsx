import { useEffect, useState } from 'react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { IconContext, SidebarSimpleIcon, XIcon } from '@phosphor-icons/react'

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
import { onSessionClosed, onTransferProgress, startBus } from './lib/bus'
import { sshConfigApi, vaultApi } from './lib/ipc'
import type { Host } from './lib/types'
import { useDialog } from './state/useDialog'
import { useTheme } from './state/useTheme'
import { useTransfers } from './state/useTransfers'
import { describe, useVault } from './state/useVault'
import { useWorkspace } from './state/useWorkspace'

type Overlay =
  | { kind: 'none' }
  | { kind: 'host'; host: Host | null }
  | { kind: 'tunnels'; sessionId: string; hostId: string }

export default function App() {
  const {
    hosts,
    identities,
    snippets,
    knownHosts,
    load,
    error: vaultError,
    dismissError: dismissVaultError,
  } = useVault()
  const initTheme = useTheme((s) => s.init)
  const { ask, confirm } = useDialog()
  const {
    tabs,
    activeTabId,
    focusTab,
    closeTab,
    openSsh,
    openLocal,
    markClosed,
    errors: workspaceErrors,
    dismissError,
  } = useWorkspace()

  const [screen, setScreen] = useState<ScreenId>('hosts')
  /** Whether a session is focused, versus one of the management screens. */
  const [inSession, setInSession] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' })
  const [note, setNote] = useState<string | null>(null)
  const applyTransferProgress = useTransfers((s) => s.applyProgress)

  useEffect(() => {
    startBus()
    void load()
    const stopTheme = initTheme()
    const stopBus = onSessionClosed((sessionId, reason, generation) =>
      markClosed(sessionId, reason, generation),
    )
    const stopTransfers = onTransferProgress(applyTransferProgress)
    return () => {
      stopTheme()
      stopBus()
      stopTransfers()
    }
  }, [load, markClosed, initTheme, applyTransferProgress])

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
      title: 'Import from ~/.ssh/config',
      body: `Read ${path ?? '~/.ssh/config'} and create matching hosts. Hosts imported before will be updated in place, not duplicated.`,
      confirmLabel: 'Import',
    })
    if (!ok) return

    try {
      const report = await sshConfigApi.import()
      await load()
      const parts = [`${report.hosts} hosts`, `${report.identities} keys`]
      if (report.jumpsLinked > 0) parts.push(`${report.jumpsLinked} jump hosts linked`)
      if (report.unresolvedJumps.length > 0) {
        parts.push(`unresolved jumps: ${report.unresolvedJumps.join(', ')}`)
      }
      if (report.includesSkipped > 0) parts.push(`${report.includesSkipped} includes skipped`)
      setNote(parts.join(' · '))
      setScreen('hosts')
      setInSession(false)
    } catch (e) {
      setNote(describe(e))
    }
  }

  const exportVault = async () => {
    const target = await saveDialog({
      defaultPath: 'shellmux-vault.smx',
      filters: [{ name: 'Shellmux vault export', extensions: ['smx'] }],
    })
    if (!target) return

    const passphrase = await ask({
      title: 'Export vault',
      label: 'Passphrase for this file',
      hint: "Protects the file at rest. You'll need it to import it again — Shellmux doesn't store it anywhere.",
      confirmLabel: 'Export',
      masked: true,
    })
    if (!passphrase) return

    try {
      await vaultApi.export(target, passphrase)
      setNote(
        `Exported to ${target}. Passwords and key passphrases stay in the OS keychain and were not included.`,
      )
    } catch (e) {
      setNote(describe(e))
    }
  }

  const importVault = async () => {
    const source = await openDialog({
      multiple: false,
      filters: [{ name: 'Shellmux vault export', extensions: ['smx'] }],
    })
    if (typeof source !== 'string') return

    const passphrase = await ask({
      title: 'Import vault',
      label: 'Passphrase',
      confirmLabel: 'Import',
      masked: true,
    })
    if (!passphrase) return

    try {
      const summary = await vaultApi.import(source, passphrase)
      await load()
      const parts = [
        `Imported ${summary.hosts} hosts, ${summary.groups} groups, ${summary.identities} keys, ` +
          `${summary.snippets} snippets, ${summary.tunnels} tunnels. Existing records sharing an ` +
          'id were updated in place, not duplicated.',
      ]
      // Never quietly swallowed: a differing fingerprint means either the
      // host legitimately changed keys or the file is trying to re-pin it.
      if (summary.knownHostConflicts.length > 0) {
        parts.push(
          `Kept your existing trusted key for ${summary.knownHostConflicts.join(', ')} — the ` +
            'file lists a different fingerprint. Verify before trusting it.',
        )
      }
      setNote(parts.join(' '))
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
    <IconContext.Provider value={{ size: 16, weight: 'regular', color: 'currentColor' }}>
      <div className="app">
        <NavRail
          active={inSession ? ('hosts' as ScreenId) : screen}
          onSelect={goToScreen}
          counts={{
            hosts: hosts.length,
            keychain: identities.length,
            snippets: snippets.length,
            knownHosts: knownHosts.length,
          }}
          onImport={() => void importSshConfig()}
          onExportVault={() => void exportVault()}
          onImportVault={() => void importVault()}
        />

        <main className="main">
          {/* Empty space after the last tab is the only safe drag handle here —
              individual tabs stay clickable since they're more specific targets. */}
          <nav className="tabstrip" data-tauri-drag-region>
            <span
              className={`tab ${!inSession ? 'active' : ''}`}
              onClick={() => setInSession(false)}
            >
              <SidebarSimpleIcon />
              Manage
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
                  aria-label={`Close ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeTab(tab.id)
                    if (tabs.length <= 1) setInSession(false)
                  }}
                >
                  <XIcon />
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
          <HostDialog
            host={overlay.host}
            onClose={() => setOverlay({ kind: 'none' })}
            onConnect={(hostId) => {
              setOverlay({ kind: 'none' })
              void connect(hostId)
            }}
          />
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

        <div className="toast-stack">
          {note && (
            <div className="toast" role="status" onClick={() => setNote(null)}>
              <span>{note}</span>
              <span className="toast-dismiss">Click to dismiss</span>
            </div>
          )}

          {vaultError && (
            <div className="toast" role="alert" onClick={dismissVaultError}>
              <span>{vaultError}</span>
              <span className="toast-dismiss">Click to dismiss</span>
            </div>
          )}

          {workspaceErrors.map((e) => (
            <div key={e.id} className="toast" role="alert" onClick={() => dismissError(e.id)}>
              <span>{e.message}</span>
              <span className="toast-dismiss">Click to dismiss</span>
            </div>
          ))}
        </div>
      </div>
    </IconContext.Provider>
  )
}
