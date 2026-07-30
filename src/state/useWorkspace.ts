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

export type PaneView = 'terminal' | 'sftp'

export interface Pane {
  id: string
  sessionId: string
  view: PaneView
}

export interface Tab {
  id: string
  title: string
  /** Split một cấp: 'row' là chia dọc theo chiều ngang, 'col' là xếp trên dưới. */
  direction: 'row' | 'col'
  panes: Pane[]
  activePaneId: string
}

export interface TrackedSession extends SessionInfo {
  closedReason: string | null
  /** Tăng mỗi lần reconnect; dùng để bỏ qua event closed đến muộn. */
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

interface WorkspaceState {
  tabs: Tab[]
  activeTabId: string | null
  sessions: Record<string, TrackedSession>
  /** Bật thì snippet gửi tới mọi pane đang mở, không chỉ pane active. */
  broadcast: boolean
  hostKeyPrompt: HostKeyPrompt | null
  error: string | null

  openSsh: (hostId: string) => Promise<void>
  openLocal: () => Promise<void>
  splitActive: (view: PaneView) => Promise<void>
  setDirection: (tabId: string, direction: 'row' | 'col') => void
  setPaneView: (tabId: string, paneId: string, view: PaneView) => void
  focusTab: (tabId: string) => void
  focusPane: (tabId: string, paneId: string) => void
  closePane: (tabId: string, paneId: string) => Promise<void>
  closeTab: (tabId: string) => Promise<void>
  markClosed: (sessionId: string, reason: string, generation: number) => void
  reconnect: (sessionId: string, cols: number, rows: number) => Promise<void>
  dismissHostKeyPrompt: () => void
  setBroadcast: (on: boolean) => void
  clearError: () => void
  activeSessionIds: () => string[]
}

const uid = () => crypto.randomUUID()

function tabForSession(session: SessionInfo, view: PaneView = 'terminal'): Tab {
  const pane: Pane = { id: uid(), sessionId: session.id, view }
  return {
    id: uid(),
    title: session.label,
    direction: 'row',
    panes: [pane],
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
  error: null,

  openSsh: async (hostId) => {
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
        error: null,
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
      set({ error: describe(e) })
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
        error: null,
      })
    } catch (e) {
      set({ error: describe(e) })
    }
  },

  /**
   * Split tab hiện tại. Pane mới dùng *cùng* session — với SFTP thì đó là điểm
   * chính: file browser chạy trên đúng connection của terminal, không mở
   * connection thứ hai.
   */
  splitActive: async (view) => {
    const { tabs, activeTabId } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    const current = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0]
    if (!current) return

    const pane: Pane = { id: uid(), sessionId: current.sessionId, view }
    const next: Tab = {
      ...tab,
      panes: [...tab.panes, pane],
      activePaneId: pane.id,
    }
    set({ tabs: replaceTab(tabs, next) })
  },

  setDirection: (tabId, direction) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    set({ tabs: replaceTab(get().tabs, { ...tab, direction }) })
  },

  setPaneView: (tabId, paneId, view) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const next: Tab = {
      ...tab,
      panes: tab.panes.map((p) => (p.id === paneId ? { ...p, view } : p)),
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

    const pane = tab.panes.find((p) => p.id === paneId)
    if (!pane) return

    const remaining = tab.panes.filter((p) => p.id !== paneId)
    // Session chỉ được đóng khi không còn pane nào của bất kỳ tab nào dùng nó.
    const stillUsed = get()
      .tabs.flatMap((t) => (t.id === tabId ? remaining : t.panes))
      .some((p) => p.sessionId === pane.sessionId)

    if (!stillUsed) {
      try {
        await sessionApi.close(pane.sessionId)
      } catch (e) {
        set({ error: describe(e) })
      }
    }

    if (remaining.length === 0) {
      const tabs = get().tabs.filter((t) => t.id !== tabId)
      set({
        tabs,
        activeTabId: tabs.length > 0 ? tabs[tabs.length - 1].id : null,
      })
      return
    }

    set({
      tabs: replaceTab(get().tabs, {
        ...tab,
        panes: remaining,
        activePaneId: remaining[remaining.length - 1].id,
      }),
    })
  },

  closeTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    for (const pane of [...tab.panes]) {
      await get().closePane(tabId, pane.id)
    }
  },

  markClosed: (sessionId, reason, generation) => {
    const existing = get().sessions[sessionId]
    if (!existing) return
    // Pump của lần kết nối trước tắt muộn hơn lần reconnect mới — event của nó
    // mang generation cũ và phải bị bỏ qua, nếu không session vừa sống lại sẽ
    // bị đánh dấu là đã chết.
    if (generation < existing.generation) return
    set({
      sessions: {
        ...get().sessions,
        [sessionId]: { ...existing, closedReason: reason, reconnecting: false },
      },
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
        error: null,
      })
    } catch (e) {
      const current = get().sessions[sessionId]
      set({
        error: describe(e),
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
  clearError: () => set({ error: null }),

  activeSessionIds: () => {
    const { tabs, activeTabId, broadcast } = get()
    if (broadcast) {
      return Array.from(
        new Set(tabs.flatMap((tab) => tab.panes.map((pane) => pane.sessionId))),
      )
    }
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return []
    const pane = tab.panes.find((p) => p.id === tab.activePaneId)
    return pane ? [pane.sessionId] : []
  },
}))
