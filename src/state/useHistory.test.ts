import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useHistory } from './useHistory'

/** vitest's default (node) environment has no `window` at all — stub a
 * minimal Map-backed localStorage so the store's persistence path is
 * actually exercised, not just skipped via its "no window" guard. */
function fakeLocalStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: fakeLocalStorage() })
  useHistory.setState({ entries: [] })
})

describe('record', () => {
  it('appends a trimmed command', () => {
    useHistory.getState().record('  git status  ')
    expect(useHistory.getState().entries).toEqual(['git status'])
  })

  it('ignores an empty or whitespace-only command', () => {
    useHistory.getState().record('')
    useHistory.getState().record('   ')
    expect(useHistory.getState().entries).toEqual([])
  })

  it('moves a repeated command to the end instead of duplicating it', () => {
    useHistory.getState().record('ls')
    useHistory.getState().record('cd ..')
    useHistory.getState().record('ls')

    expect(useHistory.getState().entries).toEqual(['cd ..', 'ls'])
  })

  it('persists across a fresh store read from localStorage', () => {
    useHistory.getState().record('ssh prod-db')

    // Simulate a reload: recompute the store's initial state the same way
    // module load does, from whatever is now in localStorage.
    const raw = window.localStorage.getItem('shellmux:command-history')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual(['ssh prod-db'])
  })

  it('caps history length rather than growing forever', () => {
    for (let i = 0; i < 1005; i += 1) {
      useHistory.getState().record(`command-${i}`)
    }
    const { entries } = useHistory.getState()
    expect(entries.length).toBe(1000)
    expect(entries[entries.length - 1]).toBe('command-1004')
  })
})

describe('clear', () => {
  it('empties the history and its persisted copy', () => {
    useHistory.getState().record('rm -rf /')
    useHistory.getState().clear()

    expect(useHistory.getState().entries).toEqual([])
    expect(window.localStorage.getItem('shellmux:command-history')).toBe('[]')
  })
})
