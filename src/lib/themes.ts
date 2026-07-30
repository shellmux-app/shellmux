import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  id: string
  name: string
  xterm: ITheme
}

/// Shellmux's default theme — background matches the tone of the app chrome.
const shellmuxDark: ITheme = {
  background: '#12141a',
  foreground: '#d6dae3',
  cursor: '#5eead4',
  cursorAccent: '#12141a',
  selectionBackground: '#2c3a45',
  black: '#12141a',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#5eead4',
  white: '#d6dae3',
  brightBlack: '#4b5563',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#99f6e4',
  brightWhite: '#f8fafc',
}

const nord: ITheme = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#88c0d0',
  selectionBackground: '#434c5e',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#bf616a',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4',
}

const solarizedDark: ITheme = {
  background: '#002b36',
  foreground: '#93a1a1',
  cursor: '#93a1a1',
  selectionBackground: '#073642',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
}

const paper: ITheme = {
  background: '#fbfbf9',
  foreground: '#2f3337',
  cursor: '#0f766e',
  selectionBackground: '#d9e2e8',
  black: '#2f3337',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#a21caf',
  cyan: '#0f766e',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#c026d3',
  brightCyan: '#0d9488',
  brightWhite: '#f9fafb',
}

export const THEMES: TerminalTheme[] = [
  { id: 'shellmux-dark', name: 'Shellmux Dark', xterm: shellmuxDark },
  { id: 'nord', name: 'Nord', xterm: nord },
  { id: 'solarized-dark', name: 'Solarized Dark', xterm: solarizedDark },
  { id: 'paper', name: 'Paper (light)', xterm: paper },
]

export function themeById(id: string | null | undefined): ITheme {
  return THEMES.find((t) => t.id === id)?.xterm ?? shellmuxDark
}
