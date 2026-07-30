import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'

import { isTauriRuntime } from '../lib/env'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'shellmux:theme'

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readStored(): ThemeMode {
  const raw = window.localStorage?.getItem(STORAGE_KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  /** Call once when the app starts; returns a cleanup function for the listener. */
  init: () => () => void
}

/**
 * The app chrome's theme. Defaults to the OS setting — if the user already chose light
 * or dark at the OS level, the app shouldn't argue with that choice.
 */
export const useTheme = create<ThemeState>((set, get) => ({
  mode: 'system',
  resolved: 'dark',

  setMode: (mode) => {
    const resolved = mode === 'system' ? systemTheme() : mode
    if (mode === 'system') {
      window.localStorage?.removeItem(STORAGE_KEY)
    } else {
      window.localStorage?.setItem(STORAGE_KEY, mode)
    }
    document.documentElement.dataset.theme = resolved
    set({ mode, resolved })

    // Sync the real window's appearance: the NSVisualEffectView layer reads the app's
    // appearance to pick a light/dark tone. Without syncing, picking "light" in the app
    // while the window stays dark would tint the glass layer the wrong color — opaque
    // instead of translucent. `mode === 'system'` sends `null` so the window follows the
    // OS on its own, exactly like how `systemTheme()` above resolves itself.
    if (isTauriRuntime()) {
      void invoke('set_window_theme', { theme: mode === 'system' ? null : mode }).catch(() => {
        // Cosmetic — does not block the UI if changing the native appearance fails.
      })
    }
  },

  init: () => {
    const mode = readStored()
    get().setMode(mode)

    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (get().mode === 'system') get().setMode('system')
    }
    media?.addEventListener('change', onChange)
    return () => media?.removeEventListener('change', onChange)
  },
}))
