import { create } from 'zustand'

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
  /** Gọi một lần lúc app khởi động; trả về hàm dọn listener. */
  init: () => () => void
}

/**
 * Chủ đề của chrome app. Mặc định theo hệ điều hành — người dùng đã chọn sáng
 * hay tối ở cấp OS thì app không nên tranh luận lại.
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
