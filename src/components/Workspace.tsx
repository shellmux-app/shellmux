import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  ArrowClockwiseIcon,
  ArrowsDownUpIcon,
  ArrowsLeftRightIcon,
  FolderOpenIcon,
  PlugsIcon,
  RecordIcon,
  SplitHorizontalIcon,
  TerminalIcon,
  XIcon,
} from '@phosphor-icons/react'

import { useVault } from '../state/useVault'
import { useTheme } from '../state/useTheme'
import type { PaneLeaf, PaneNode, Tab, TrackedSession } from '../state/useWorkspace'
import { findParentSplit, useWorkspace } from '../state/useWorkspace'
import { SftpPanel } from './SftpPanel'
import { TerminalView } from './TerminalView'

interface Props {
  onOpenTunnels: (sessionId: string, hostId: string) => void
}

interface PaneProps {
  tab: Tab
  pane: PaneLeaf
  session: TrackedSession | undefined
  themeId: string | null
  onOpenTunnels: (sessionId: string, hostId: string) => void
}

function WorkspacePane({ tab, pane, session, themeId, onOpenTunnels }: PaneProps) {
  const { focusPane, closePane, setPaneView, reconnect, loggingSessions, startLogging, stopLogging } =
    useWorkspace()

  const isActive = pane.id === tab.activePaneId
  const isClosed = Boolean(session?.closedReason) && !session?.reconnecting

  const toggleLogging = async () => {
    if (loggingSessions[pane.sessionId]) {
      await stopLogging(pane.sessionId)
      return
    }
    const label = session?.label ?? 'session'
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, '-')
    const target = await saveDialog({
      defaultPath: `${safeLabel}.log`,
      filters: [{ name: 'Log file', extensions: ['log', 'txt'] }],
    })
    if (target) await startLogging(pane.sessionId, target)
  }

  return (
    <div
      className={`pane ${isActive ? 'active' : ''}`}
      onMouseDown={() => focusPane(tab.id, pane.id)}
    >
      <header className="pane-head">
        <span className="pane-title">
          {session?.label ?? 'session'}
          {session?.reconnecting && <span className="badge">Reconnecting</span>}
          {isClosed && <span className="pane-state">Disconnected</span>}
        </span>

        <span className="pane-tools">
          {isClosed && (
            <button className="btn-primary" onClick={() => void reconnect(pane.sessionId, 80, 24)}>
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
                onClick={() => session.hostId && onOpenTunnels(session.id, session.hostId)}
              >
                <PlugsIcon />
                Tunnel
              </button>
            </>
          )}

          {session && !isClosed && pane.view === 'terminal' && (
            <button
              className={`btn-quiet ${loggingSessions[pane.sessionId] ? 'is-logging' : ''}`}
              aria-pressed={Boolean(loggingSessions[pane.sessionId])}
              title={
                loggingSessions[pane.sessionId]
                  ? `Logging to ${loggingSessions[pane.sessionId]} — click to stop`
                  : 'Log this session to a file'
              }
              onClick={() => void toggleLogging()}
            >
              <RecordIcon weight={loggingSessions[pane.sessionId] ? 'fill' : 'regular'} />
              {loggingSessions[pane.sessionId] ? 'Logging' : 'Log'}
            </button>
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
            themeId={themeId}
            focused={isActive}
            closedReason={session?.closedReason ?? null}
            onReconnect={(cols, rows) => void reconnect(pane.sessionId, cols, rows)}
          />
        ) : (
          <SftpPanel sessionId={pane.sessionId} />
        )}
      </div>
    </div>
  )
}

interface NodeProps {
  tab: Tab
  node: PaneNode
  onOpenTunnels: (sessionId: string, hostId: string) => void
}

/** Renders a split node recursively, or a single pane at a leaf. */
function WorkspaceNode({ tab, node, onOpenTunnels }: NodeProps) {
  const { hosts } = useVault()
  const { resolved } = useTheme()
  const sessions = useWorkspace((s) => s.sessions)

  if (node.kind === 'split') {
    return (
      <div className={`panes ${node.direction}`}>
        {node.children.map((child) => (
          <WorkspaceNode key={child.id} tab={tab} node={child} onOpenTunnels={onOpenTunnels} />
        ))}
      </div>
    )
  }

  const session = sessions[node.sessionId]
  const host = session?.hostId ? hosts.find((h) => h.id === session.hostId) : undefined
  // If the host hasn't picked its own theme, follow the app's theme.
  const themeId = host?.theme ?? (resolved === 'light' ? 'paper' : null)

  return (
    <WorkspacePane tab={tab} pane={node} session={session} themeId={themeId} onOpenTunnels={onOpenTunnels} />
  )
}

/** Tab bar + recursive split-pane grid: any pane can be split again, in either direction. */
export function Workspace({ onOpenTunnels }: Props) {
  const { tabs, activeTabId, splitActive, toggleSplitDirection } = useWorkspace()

  const tab = tabs.find((t) => t.id === activeTabId) ?? null
  const activeSplit = tab ? findParentSplit(tab.root, tab.activePaneId) : null
  const DirectionIcon = activeSplit?.direction === 'row' ? ArrowsDownUpIcon : ArrowsLeftRightIcon

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
          {activeSplit && (
            <button
              className="btn-quiet"
              onClick={() => toggleSplitDirection(tab.id, activeSplit.id)}
            >
              <DirectionIcon />
              {activeSplit.direction === 'row' ? 'Stack vertically' : 'Stack horizontally'}
            </button>
          )}
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

      {tab && <WorkspaceNode tab={tab} node={tab.root} onOpenTunnels={onOpenTunnels} />}
    </section>
  )
}
