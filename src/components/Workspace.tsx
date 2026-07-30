import { useVault } from '../state/useVault'
import { useTheme } from '../state/useTheme'
import { useWorkspace } from '../state/useWorkspace'
import { SftpPanel } from './SftpPanel'
import { TerminalView } from './TerminalView'

interface Props {
  onOpenTunnels: (sessionId: string, hostId: string) => void
}

/** Tab bar + grid pane. Split một cấp: đủ cho 2 tới 4 pane cạnh nhau. */
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

  return (
    <section className="workspace">
      {tab && (
        <div className="pane-toolbar">
          <button className="btn-quiet" onClick={() => void splitActive('terminal')}>
            Chia terminal
          </button>
          <button className="btn-quiet" onClick={() => void splitActive('sftp')}>
            Chia SFTP
          </button>
          <span className="spacer" />
          <button
            className="btn-quiet"
            onClick={() => setDirection(tab.id, tab.direction === 'row' ? 'col' : 'row')}
          >
            {tab.direction === 'row' ? 'Xếp dọc' : 'Xếp ngang'}
          </button>
        </div>
      )}

      {!tab && (
        <div className="placeholder">
          <strong>Session đã đóng hết</strong>
          <p>
            Quay lại tab <span className="kbd">Quản lý</span> để chọn host khác.
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
                      <span className="badge">Đang kết nối lại</span>
                    )}
                    {isClosed && <span className="pane-state">Đã ngắt</span>}
                  </span>

                  <span className="pane-tools">
                    {isClosed && (
                      <button
                        className="btn-primary"
                        onClick={() => void reconnect(pane.sessionId, 80, 24)}
                      >
                        Kết nối lại
                      </button>
                    )}

                    {session?.kind === 'ssh' && (
                      <>
                        <span className="seg">
                          <button
                            className={pane.view === 'terminal' ? 'on' : ''}
                            onClick={() => setPaneView(tab.id, pane.id, 'terminal')}
                          >
                            Terminal
                          </button>
                          <button
                            className={pane.view === 'sftp' ? 'on' : ''}
                            onClick={() => setPaneView(tab.id, pane.id, 'sftp')}
                          >
                            File
                          </button>
                        </span>
                        <button
                          className="btn-quiet"
                          onClick={() =>
                            session.hostId && onOpenTunnels(session.id, session.hostId)
                          }
                        >
                          Tunnel
                        </button>
                      </>
                    )}

                    <button
                      className="btn-quiet"
                      aria-label="Đóng pane"
                      onClick={() => void closePane(tab.id, pane.id)}
                    >
                      ✕
                    </button>
                  </span>
                </header>

                <div className="pane-body">
                  {pane.view === 'terminal' ? (
                    <TerminalView
                      sessionId={pane.sessionId}
                      // Host chưa chọn theme riêng thì đi theo chủ đề của app.
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
