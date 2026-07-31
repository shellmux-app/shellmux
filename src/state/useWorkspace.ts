import { create } from 'zustand'

import { sessionApi } from '../lib/ipc'
import type {
  HostKeyMismatchData,
  HostKeyUnknownData,
  SessionInfo,
} from '../lib/types'
import { isIpcError } from '../lib/types'
import { describe } from './useVault'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
/** Caps the error toast stack so a burst of failures can't grow it unbounded. */
const MAX_QUEUED_ERRORS = 4

export type PaneView = 'terminal' | 'sftp'
export type SplitDirection = 'row' | 'col'

/** A pane that actually shows a session. Leaves are where `activePaneId` points. */
export interface PaneLeaf {
  kind: 'leaf'
  id: string
  sessionId: string
  view: PaneView
}

/**
 * A pane divided into two or more children — 'row' arranges them side by
 * side, 'col' stacks them top to bottom. Splits nest: splitting a pane
 * that's already inside a split just replaces that leaf with a new split.
 */
export interface PaneSplit {
  kind: 'split'
  id: string
  direction: SplitDirection
  children: PaneNode[]
}

export type PaneNode = PaneLeaf | PaneSplit

export interface Tab {
  id: string
  title: string
  root: PaneNode
  activePaneId: string
}

// --- Pure tree helpers -----------------------------------------------------
// No store coupling: components can use these directly (e.g. to figure out
// which split contains the active pane, for a "stack differently" toggle).

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.kind === 'leaf') return node.id === paneId ? node : null
  for (const child of node.children) {
    const found = findLeaf(child, paneId)
    if (found) return found
  }
  return null
}

export function flattenLeaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === 'leaf') return [node]
  return node.children.flatMap(flattenLeaves)
}

/** The split node whose direct children include this pane, or null if it's the unsplit root. */
export function findParentSplit(node: PaneNode, paneId: string): PaneSplit | null {
  if (node.kind === 'leaf') return null
  if (node.children.some((c) => c.kind === 'leaf' && c.id === paneId)) return node
  for (const child of node.children) {
    const found = findParentSplit(child, paneId)
    if (found) return found
  }
  return null
}

function findSplit(node: PaneNode, splitId: string): PaneSplit | null {
  if (node.kind === 'leaf') return null
  if (node.id === splitId) return node
  for (const child of node.children) {
    const found = findSplit(child, splitId)
    if (found) return found
  }
  return null
}

function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === 'leaf') return fn(node)
  return { ...node, children: node.children.map((c) => mapLeaves(c, fn)) }
}

/** Replaces the leaf `targetId` with a split containing it plus `newLeaf`. */
function splitLeaf(
  node: PaneNode,
  targetId: string,
  newLeaf: PaneLeaf,
  direction: SplitDirection,
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== targetId) return node
    return { kind: 'split', id: uid(), direction, children: [node, newLeaf] }
  }
  return { ...node, children: node.children.map((c) => splitLeaf(c, targetId, newLeaf, direction)) }
}

/** Removes a leaf; a split left with one child collapses into that child. Null if the tree is now empty. */
function removeLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.id === paneId ? null : node
  const children = node.children
    .map((c) => removeLeaf(c, paneId))
    .filter((c): c is PaneNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...node, children }
}

function setSplitDirection(node: PaneNode, splitId: string, direction: SplitDirection): PaneNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) return { ...node, direction }
  return { ...node, children: node.children.map((c) => setSplitDirection(c, splitId, direction)) }
}

export interface TrackedSession extends SessionInfo {
  closedReason: string | null
  /** Incremented on every reconnect; used to ignore late-arriving closed events. */
  generation: number
  reconnecting: boolean
}

export interface HostKeyPrompt {
  hostId: string
  kind: 'unknown' | 'mismatch'
  host: string
  port: number
  algo: string
  fingerprint: string
  previous: string | null
}

export interface WorkspaceError {
  id: string
  message: string
}

interface WorkspaceState {
  tabs: Tab[]
  activeTabId: string | null
  sessions: Record<string, TrackedSession>
  /** When on, snippets are sent to every open pane, not just the active one. */
  broadcast: boolean
  hostKeyPrompt: HostKeyPrompt | null
  /** A stack, not a single slot — two failures close together (e.g. a tab
   * close and a reconnect) would otherwise silently overwrite each other. */
  errors: WorkspaceError[]
  /** Host currently being dialed — lets the UI show a spinner instead of
   * jumping straight from click to either a terminal or an error. */
  connectingHostId: string | null
  /** sessionId -> the file it's currently being logged to. Absent means not logging. */
  loggingSessions: Record<string, string>

  openSsh: (hostId: string) => Promise<void>
  openLocal: () => Promise<void>
  splitActive: (view: PaneView, direction?: SplitDirection) => Promise<void>
  toggleSplitDirection: (tabId: string, splitId: string) => void
  setPaneView: (tabId: string, paneId: string, view: PaneView) => void
  focusTab: (tabId: string) => void
  focusPane: (tabId: string, paneId: string) => void
  closePane: (tabId: string, paneId: string) => Promise<void>
  closeTab: (tabId: string) => Promise<void>
  markClosed: (sessionId: string, reason: string, generation: number) => void
  reconnect: (sessionId: string, cols: number, rows: number) => Promise<void>
  dismissHostKeyPrompt: () => void
  setBroadcast: (on: boolean) => void
  dismissError: (id: string) => void
  startLogging: (sessionId: string, path: string) => Promise<void>
  stopLogging: (sessionId: string) => Promise<void>
  activeSessionIds: () => string[]
}

function pushError(errors: WorkspaceError[], message: string): WorkspaceError[] {
  return [...errors, { id: uid(), message }].slice(-MAX_QUEUED_ERRORS)
}

const uid = () => crypto.randomUUID()

function tabForSession(session: SessionInfo, view: PaneView = 'terminal'): Tab {
  const pane: PaneLeaf = { kind: 'leaf', id: uid(), sessionId: session.id, view }
  return {
    id: uid(),
    title: session.label,
    root: pane,
    activePaneId: pane.id,
  }
}

function replaceTab(tabs: Tab[], next: Tab): Tab[] {
  return tabs.map((tab) => (tab.id === next.id ? next : tab))
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  sessions: {},
  broadcast: false,
  hostKeyPrompt: null,
  errors: [],
  connectingHostId: null,
  loggingSessions: {},

  openSsh: async (hostId) => {
    set({ connectingHostId: hostId })
    try {
      const session = await sessionApi.connect(hostId, DEFAULT_COLS, DEFAULT_ROWS)
      const tab = tabForSession(session)
      set({
        tabs: [...get().tabs, tab],
        activeTabId: tab.id,
        sessions: {
          ...get().sessions,
          [session.id]: {
            ...session,
            closedReason: null,
            generation: 0,
            reconnecting: false,
          },
        },
      })
    } catch (e) {
      if (isIpcError(e) && e.kind === 'hostKeyUnknown' && e.data) {
        const data = e.data as HostKeyUnknownData
        set({
          hostKeyPrompt: {
            hostId,
            kind: 'unknown',
            host: data.host,
            port: data.port,
            algo: data.algo,
            fingerprint: data.fingerprint,
            previous: null,
          },
        })
        return
      }
      if (isIpcError(e) && e.kind === 'hostKeyMismatch' && e.data) {
        const data = e.data as HostKeyMismatchData
        set({
          hostKeyPrompt: {
            hostId,
            kind: 'mismatch',
            host: data.host,
            port: data.port,
            algo: 'unknown',
            fingerprint: data.actual,
            previous: data.expected,
          },
        })
        return
      }
      set({ errors: pushError(get().errors, describe(e)) })
    } finally {
      set({ connectingHostId: null })
    }
  },

  openLocal: async () => {
    try {
      const session = await sessionApi.openLocal(DEFAULT_COLS, DEFAULT_ROWS)
      const tab = tabForSession(session)
      set({
        tabs: [...get().tabs, tab],
        activeTabId: tab.id,
        sessions: {
          ...get().sessions,
          [session.id]: {
            ...session,
            closedReason: null,
            generation: 0,
            reconnecting: false,
          },
        },
      })
    } catch (e) {
      set({ errors: pushError(get().errors, describe(e)) })
    }
  },

  /**
   * Split the current tab. The new pane uses the *same* session — for SFTP this is the
   * whole point: the file browser runs on the exact same connection as the terminal,
   * without opening a second connection.
   */
  splitActive: async (view, direction = 'row') => {
    const { tabs, activeTabId } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    const current = findLeaf(tab.root, tab.activePaneId)
    if (!current) return

    const pane: PaneLeaf = { kind: 'leaf', id: uid(), sessionId: current.sessionId, view }
    const next: Tab = {
      ...tab,
      root: splitLeaf(tab.root, current.id, pane, direction),
      activePaneId: pane.id,
    }
    set({ tabs: replaceTab(tabs, next) })
  },

  /** Flips row↔col for the split node identified by `splitId`. */
  toggleSplitDirection: (tabId, splitId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const split = findSplit(tab.root, splitId)
    if (!split) return
    const flipped: SplitDirection = split.direction === 'row' ? 'col' : 'row'
    set({
      tabs: replaceTab(get().tabs, { ...tab, root: setSplitDirection(tab.root, splitId, flipped) }),
    })
  },

  setPaneView: (tabId, paneId, view) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const next: Tab = {
      ...tab,
      root: mapLeaves(tab.root, (leaf) => (leaf.id === paneId ? { ...leaf, view } : leaf)),
    }
    set({ tabs: replaceTab(get().tabs, next) })
  },

  focusTab: (tabId) => set({ activeTabId: tabId }),

  focusPane: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    set({
      activeTabId: tabId,
      tabs: replaceTab(get().tabs, { ...tab, activePaneId: paneId }),
    })
  },

  closePane: async (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return

    const pane = findLeaf(tab.root, paneId)
    if (!pane) return

    const nextRoot = removeLeaf(tab.root, paneId)
    // A session is only closed once no pane in any tab is using it anymore.
    const stillUsed = get()
      .tabs.flatMap((t) => {
        if (t.id !== tabId) return flattenLeaves(t.root)
        return nextRoot ? flattenLeaves(nextRoot) : []
      })
      .some((p) => p.sessionId === pane.sessionId)

    // Drop the pane from the tree *before* awaiting the backend. Closing is
    // async, and both the pane ✕ and the tab ✕ can be clicked again while it
    // is in flight — if the pane were still in the tree, the second call
    // would find it and close an already-closed session, surfacing an
    // "session does not exist" toast for what was a successful close.
    if (!nextRoot) {
      const tabs = get().tabs.filter((t) => t.id !== tabId)
      // Only move focus when the tab that just closed was the one on screen.
      // Closing a *background* tab (its ✕ in the tabstrip) must leave the
      // user where they were rather than yanking them to another session.
      const wasActive = get().activeTabId === tabId
      set({
        tabs,
        activeTabId: wasActive
          ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null)
          : get().activeTabId,
      })
    } else {
      const leaves = flattenLeaves(nextRoot)
      set({
        tabs: replaceTab(get().tabs, {
          ...tab,
          root: nextRoot,
          activePaneId: leaves.some((l) => l.id === tab.activePaneId)
            ? tab.activePaneId
            : leaves[leaves.length - 1].id,
        }),
      })
    }

    if (!stillUsed) {
      try {
        await sessionApi.close(pane.sessionId)
      } catch (e) {
        set({ errors: pushError(get().errors, describe(e)) })
      }
    }
  },

  closeTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    for (const pane of flattenLeaves(tab.root)) {
      await get().closePane(tabId, pane.id)
    }
  },

  markClosed: (sessionId, reason, generation) => {
    const existing = get().sessions[sessionId]
    if (!existing) return
    // The previous connection's pump shuts down later than the new reconnect — its event
    // carries the old generation and must be ignored, otherwise the session that just
    // came back to life would get marked as dead.
    if (generation < existing.generation) return
    const { [sessionId]: _wasLogging, ...loggingSessions } = get().loggingSessions
    set({
      sessions: {
        ...get().sessions,
        [sessionId]: { ...existing, closedReason: reason, reconnecting: false },
      },
      loggingSessions,
    })
  },

  reconnect: async (sessionId, cols, rows) => {
    const existing = get().sessions[sessionId]
    if (!existing || existing.reconnecting) return

    set({
      sessions: {
        ...get().sessions,
        [sessionId]: { ...existing, reconnecting: true },
      },
    })

    try {
      await sessionApi.reconnect(sessionId, cols, rows)
      const current = get().sessions[sessionId]
      if (!current) return
      // The old pump — and whatever log file it had open — is gone; the new
      // one starts fresh with logging off, so the UI shouldn't claim otherwise.
      const { [sessionId]: _wasLogging, ...loggingSessions } = get().loggingSessions
      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...current,
            closedReason: null,
            reconnecting: false,
            generation: current.generation + 1,
          },
        },
        loggingSessions,
      })
    } catch (e) {
      const current = get().sessions[sessionId]
      set({
        errors: pushError(get().errors, describe(e)),
        sessions: current
          ? {
              ...get().sessions,
              [sessionId]: { ...current, reconnecting: false },
            }
          : get().sessions,
      })
    }
  },

  dismissHostKeyPrompt: () => set({ hostKeyPrompt: null }),
  setBroadcast: (on) => set({ broadcast: on }),
  dismissError: (id) => set({ errors: get().errors.filter((e) => e.id !== id) }),

  startLogging: async (sessionId, path) => {
    try {
      await sessionApi.startLogging(sessionId, path)
      set({ loggingSessions: { ...get().loggingSessions, [sessionId]: path } })
    } catch (e) {
      set({ errors: pushError(get().errors, describe(e)) })
    }
  },

  stopLogging: async (sessionId) => {
    try {
      await sessionApi.stopLogging(sessionId)
    } catch (e) {
      set({ errors: pushError(get().errors, describe(e)) })
    } finally {
      // Clear the UI's idea of "logging" either way — if the session is
      // already gone, there's nothing left to tell it to stop.
      const { [sessionId]: _removed, ...rest } = get().loggingSessions
      set({ loggingSessions: rest })
    }
  },

  activeSessionIds: () => {
    const { tabs, activeTabId, broadcast } = get()
    if (broadcast) {
      return Array.from(
        new Set(tabs.flatMap((tab) => flattenLeaves(tab.root).map((pane) => pane.sessionId))),
      )
    }
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return []
    const pane = findLeaf(tab.root, tab.activePaneId)
    return pane ? [pane.sessionId] : []
  },
}))
