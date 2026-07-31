import { create } from 'zustand'

/**
 * Command history for the Ctrl+R fuzzy search / Ctrl+Space autocomplete
 * overlay. Tracks lines *typed into* a terminal across every session and
 * host, persisted to localStorage so it survives an app restart — the same
 * shape as a shell's own history file, except shared across hosts, which a
 * single remote shell's history never is.
 *
 * Known limitation: this only sees what's typed through Shellmux's own
 * input handling. A command recalled via the *remote* shell's own up-arrow
 * history and then run isn't observed here — there's no reliable way to
 * tell "the remote redrew the prompt with a recalled command" apart from
 * ordinary output without parsing shell-specific escape sequences.
 */

const STORAGE_KEY = 'shellmux:command-history'
const MAX_ENTRIES = 1000

function readStored(): string[] {
  try {
    if (typeof window === 'undefined') return []
    const raw = window.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

function persist(entries: string[]) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Storage full, disabled, or unavailable (e.g. a browser preview outside
    // Tauri) — history just stops persisting across restarts, not fatal.
  }
}

interface HistoryState {
  /** Oldest first, like a shell history file — the search UI reverses it. */
  entries: string[]
  record: (command: string) => void
  clear: () => void
}

export const useHistory = create<HistoryState>((set, get) => ({
  entries: readStored(),

  record: (command) => {
    const trimmed = command.trim()
    if (!trimmed) return
    // Move-to-end-if-duplicate (bash's HISTCONTROL=erasedups) — otherwise
    // "cd .." and "ls" bury everything else within a minute of use.
    const deduped = get().entries.filter((e) => e !== trimmed)
    const next = [...deduped, trimmed].slice(-MAX_ENTRIES)
    set({ entries: next })
    persist(next)
  },

  clear: () => {
    set({ entries: [] })
    persist([])
  },
}))
