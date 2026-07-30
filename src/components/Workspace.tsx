import { useVault } from '../state/useVault'
import { useWorkspace } from '../state/useWorkspace'
import { SftpPanel } from './SftpPanel'
import { TerminalView } from './TerminalView'

interface Props {
  onOpenTunnels: (sessionId: string, hostId: string) => void
}

/** Tab bar + grid pane. Split một cấp: đủ cho 2–4 pane cạnh nhau. */
export function Workspace({ onOpenTunnels }: Props) {
  const { hosts } = useVault()
  const {
    tabs,
    activeTabId,
    sessions,
    focusTab,
    focusPane,
    closeTab,
    closePane,
    splitActive,
    setDirection,
    setPaneView,
    reconnect,
  } = useWorkspace()

  const tab = tabs.find((t) => t.id === activeTabId) ?? null

  return (
    <section className="workspace">
      <nav className="tabbar">
        {tabs.map((entry) => (
          <span
            key={entry.id}
            className={`tab ${entry.id === activeTabId ? 'active' : ''}`}
            onClick={() => focusTab(entry.id)}
          >
            {entry.title}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation()
                void closeTab(entry.id)
              }}
            >
              ✕
            </button>
          </span>
        ))}

        {tab && (
          <span className="tab-tools">
            <button onClick={() => void splitActive('terminal')} title="Split terminal">
              ⊞ Terminal
            </button>
            <button onClick={() => void splitActive('sftp')} title="Split SFTP">
              ⊞ SFTP
            </button>
            <button
              onClick={() => setDirection(tab.id, tab.direction === 'row' ? 'col' : 'row')}
              title="Đổi hướng split"
            >
              {tab.direction === 'row' ? '⇅' : '⇄'}
            </button>
          </span>
        )}
      </nav>

      {!tab && (
        <div className="empty-state">
          <h1>Shellmux</h1>
          <p>Double-click một host ở sidebar để kết nối, hoặc mở một local shell.</p>
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

            return (
              <div
                key={pane.id}
                className={`pane ${isActive ? 'active' : ''}`}
                onMouseDown={() => focusPane(tab.id, pane.id)}
              >
                <header className="pane-head">
                  <span className="pane-title">
                    {session?.label ?? 'session'}
                    {session?.reconnecting && <em> · đang kết nối lại…</em>}
                    {session?.closedReason && !session.reconnecting && (
                      <em> · đã đóng</em>
                    )}
                  </span>
                  <span className="pane-tools">
                    {session?.closedReason && !session.reconnecting && (
                      <button
                        className="primary"
                        onClick={() => void reconnect(pane.sessionId, 80, 24)}
                      >
                        Kết nối lại
                      </button>
                    )}
                    <button
                      className={pane.view === 'terminal' ? 'on' : ''}
                      onClick={() => setPaneView(tab.id, pane.id, 'terminal')}
                    >
                      Term
                    </button>
                    {session?.kind === 'ssh' && (
                      <>
                        <button
                          className={pane.view === 'sftp' ? 'on' : ''}
                          onClick={() => setPaneView(tab.id, pane.id, 'sftp')}
                        >
                          SFTP
                        </button>
                        <button
                          onClick={() =>
                            session.hostId && onOpenTunnels(session.id, session.hostId)
                          }
                        >
                          Tunnels
                        </button>
                      </>
                    )}
                    <button onClick={() => void closePane(tab.id, pane.id)}>✕</button>
                  </span>
                </header>

                <div className="pane-body">
                  {pane.view === 'terminal' ? (
                    <TerminalView
                      sessionId={pane.sessionId}
                      themeId={host?.theme ?? null}
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
