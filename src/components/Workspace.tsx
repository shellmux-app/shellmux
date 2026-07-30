import {
  ArrowClockwiseIcon,
  ArrowsDownUpIcon,
  ArrowsLeftRightIcon,
  FolderOpenIcon,
  PlugsIcon,
  SplitHorizontalIcon,
  TerminalIcon,
  XIcon,
} from '@phosphor-icons/react'

import { useVault } from '../state/useVault'
import { useTheme } from '../state/useTheme'
import { useWorkspace } from '../state/useWorkspace'
import { SftpPanel } from './SftpPanel'
import { TerminalView } from './TerminalView'

interface Props {
  onOpenTunnels: (sessionId: string, hostId: string) => void
}

/** Tab bar + grid pane. Single-level split: enough for 2 to 4 panes side by side. */
export function Workspace({ onOpenTunnels }: Props) {
  const { hosts } = useVault()
  const { resolved } = useTheme()
  const {
    tabs,
    activeTabId,
    sessions,
    focusPane,
    closePane,
    splitActive,
    setDirection,
    setPaneView,
    reconnect,
  } = useWorkspace()

  const tab = tabs.find((t) => t.id === activeTabId) ?? null
  const DirectionIcon = tab?.direction === 'row' ? ArrowsDownUpIcon : ArrowsLeftRightIcon

  return (
    <section className="workspace">
      {tab && (
        <div className="pane-toolbar">
          <button className="btn-quiet" onClick={() => void splitActive('terminal')}>
            <SplitHorizontalIcon />
            Split terminal
          </button>
          <button className="btn-quiet" onClick={() => void splitActive('sftp')}>
            <SplitHorizontalIcon />
            Split SFTP
          </button>
          <span className="spacer" />
          <button
            className="btn-quiet"
            onClick={() => setDirection(tab.id, tab.direction === 'row' ? 'col' : 'row')}
          >
            <DirectionIcon />
            {tab.direction === 'row' ? 'Stack vertically' : 'Stack horizontally'}
          </button>
        </div>
      )}

      {!tab && (
        <div className="placeholder">
          <strong>All sessions closed</strong>
          <p>
            Go back to the <span className="kbd">Manage</span> tab to pick another host.
          </p>
        </div>
      )}

      {tab && (
        <div className={`panes ${tab.direction}`}>
          {tab.panes.map((pane) => {
            const session = sessions[pane.sessionId]
            const host = session?.hostId
              ? hosts.find((h) => h.id === session.hostId)
              : undefined
            const isActive = pane.id === tab.activePaneId
            const isClosed = Boolean(session?.closedReason) && !session?.reconnecting

            return (
              <div
                key={pane.id}
                className={`pane ${isActive ? 'active' : ''}`}
                onMouseDown={() => focusPane(tab.id, pane.id)}
              >
                <header className="pane-head">
                  <span className="pane-title">
                    {session?.label ?? 'session'}
                    {session?.reconnecting && (
                      <span className="badge">Reconnecting</span>
                    )}
                    {isClosed && <span className="pane-state">Disconnected</span>}
                  </span>

                  <span className="pane-tools">
                    {isClosed && (
                      <button
                        className="btn-primary"
                        onClick={() => void reconnect(pane.sessionId, 80, 24)}
                      >
                        <ArrowClockwiseIcon />
                        Reconnect
                      </button>
                    )}

                    {session?.kind === 'ssh' && (
                      <>
                        <span className="seg">
                          <button
                            className={pane.view === 'terminal' ? 'on' : ''}
                            onClick={() => setPaneView(tab.id, pane.id, 'terminal')}
                          >
                            <TerminalIcon size={14} />
                            Terminal
                          </button>
                          <button
                            className={pane.view === 'sftp' ? 'on' : ''}
                            onClick={() => setPaneView(tab.id, pane.id, 'sftp')}
                          >
                            <FolderOpenIcon size={14} />
                            File
                          </button>
                        </span>
                        <button
                          className="btn-quiet"
                          onClick={() =>
                            session.hostId && onOpenTunnels(session.id, session.hostId)
                          }
                        >
                          <PlugsIcon />
                          Tunnel
                        </button>
                      </>
                    )}

                    <button
                      className="btn-quiet"
                      aria-label="Close pane"
                      onClick={() => void closePane(tab.id, pane.id)}
                    >
                      <XIcon />
                    </button>
                  </span>
                </header>

                <div className="pane-body">
                  {pane.view === 'terminal' ? (
                    <TerminalView
                      sessionId={pane.sessionId}
                      // If the host hasn't picked its own theme, follow the app's theme.
                      themeId={host?.theme ?? (resolved === 'light' ? 'paper' : null)}
                      focused={isActive}
                      closedReason={session?.closedReason ?? null}
                      onReconnect={(cols, rows) =>
                        void reconnect(pane.sessionId, cols, rows)
                      }
                    />
                  ) : (
                    <SftpPanel sessionId={pane.sessionId} />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
