import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { findParentSplit, flattenLeaves, useWorkspace } from './useWorkspace'

function resetStore() {
  useWorkspace.setState({
    tabs: [],
    activeTabId: null,
    sessions: {},
    broadcast: false,
    hostKeyPrompt: null,
    errors: [],
    connectingHostId: null,
    loggingSessions: {},
  })
}

/** Fake invoke: ssh_connect returns a session, other commands return undefined. */
function mockConnect(sessionId: string, label = 'web-01') {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'ssh_connect') {
      return Promise.resolve({ id: sessionId, kind: 'ssh', hostId: 'h1', label })
    }
    return Promise.resolve(undefined)
  })
}

beforeEach(() => {
  invoke.mockReset()
  resetStore()
})

describe('openSsh', () => {
  it('opens a new tab with exactly one terminal pane', async () => {
    mockConnect('s1')

    await useWorkspace.getState().openSsh('h1')

    const { tabs, activeTabId, sessions } = useWorkspace.getState()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].root.kind).toBe('leaf')
    expect(flattenLeaves(tabs[0].root)).toHaveLength(1)
    expect(flattenLeaves(tabs[0].root)[0].view).toBe('terminal')
    expect(activeTabId).toBe(tabs[0].id)
    expect(sessions.s1.closedReason).toBeNull()
  })

  it('does not create a tab when the host key is not yet trusted, and shows the prompt instead', async () => {
    invoke.mockRejectedValue({
      message: 'host key not yet trusted',
      kind: 'hostKeyUnknown',
      data: { host: '10.0.0.5', port: 22, fingerprint: 'SHA256:abc', algo: 'ssh-ed25519' },
    })

    await useWorkspace.getState().openSsh('h1')

    const { tabs, hostKeyPrompt } = useWorkspace.getState()
    expect(tabs).toHaveLength(0)
    expect(hostKeyPrompt).toMatchObject({
      kind: 'unknown',
      hostId: 'h1',
      fingerprint: 'SHA256:abc',
    })
  })

  it('distinguishes a changed key from a new host', async () => {
    invoke.mockRejectedValue({
      message: 'host key has changed',
      kind: 'hostKeyMismatch',
      data: { host: '10.0.0.5', port: 22, expected: 'SHA256:old', actual: 'SHA256:new' },
    })

    await useWorkspace.getState().openSsh('h1')

    expect(useWorkspace.getState().hostKeyPrompt).toMatchObject({
      kind: 'mismatch',
      previous: 'SHA256:old',
      fingerprint: 'SHA256:new',
    })
  })

  it('shows a message for a generic error, not the host key prompt', async () => {
    invoke.mockRejectedValue({ message: 'connection refused', kind: 'generic', data: null })

    await useWorkspace.getState().openSsh('h1')

    expect(useWorkspace.getState().hostKeyPrompt).toBeNull()
    expect(useWorkspace.getState().errors.at(-1)?.message).toBe('connection refused')
  })
})

describe('split panes', () => {
  it('new SFTP pane reuses the exact session of the currently focused pane', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')

    await useWorkspace.getState().splitActive('sftp')

    const tab = useWorkspace.getState().tabs[0]
    const leaves = flattenLeaves(tab.root)
    expect(tab.root.kind).toBe('split')
    expect(leaves).toHaveLength(2)
    expect(leaves[1].view).toBe('sftp')
    // Core point: same session ⇒ SFTP does not open a second SSH connection.
    expect(leaves[1].sessionId).toBe('s1')
    expect(tab.activePaneId).toBe(leaves[1].id)
  })

  it('splitting an already-split pane nests a new split instead of adding a sibling', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().splitActive('sftp') // now split into [terminal, sftp], sftp active

    await useWorkspace.getState().splitActive('terminal')

    const tab = useWorkspace.getState().tabs[0]
    expect(tab.root.kind).toBe('split')
    if (tab.root.kind !== 'split') throw new Error('unreachable')
    // The root still has exactly 2 children — the second one became a nested split.
    expect(tab.root.children).toHaveLength(2)
    expect(tab.root.children[1].kind).toBe('split')
    expect(flattenLeaves(tab.root)).toHaveLength(3)
  })

  it('toggleSplitDirection flips row<->col for the targeted split only', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().splitActive('sftp')
    const tab = useWorkspace.getState().tabs[0]
    if (tab.root.kind !== 'split') throw new Error('expected a split root')
    expect(tab.root.direction).toBe('row')

    useWorkspace.getState().toggleSplitDirection(tab.id, tab.root.id)

    const updated = useWorkspace.getState().tabs[0]
    if (updated.root.kind !== 'split') throw new Error('expected a split root')
    expect(updated.root.direction).toBe('col')
  })

  it('closing one pane of a session still used by another pane does not close the session', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().splitActive('sftp')
    const tab = useWorkspace.getState().tabs[0]
    const sftpPane = flattenLeaves(tab.root)[1]
    invoke.mockClear()

    await useWorkspace.getState().closePane(tab.id, sftpPane.id)

    expect(invoke).not.toHaveBeenCalledWith('session_close', expect.anything())
    const remaining = flattenLeaves(useWorkspace.getState().tabs[0].root)
    expect(remaining).toHaveLength(1)
    // The split collapses back down to a single leaf once only one child is left.
    expect(useWorkspace.getState().tabs[0].root.kind).toBe('leaf')
  })

  it('closing the last pane closes the session and drops the tab', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    const tab = useWorkspace.getState().tabs[0]
    const pane = flattenLeaves(tab.root)[0]
    invoke.mockClear()
    invoke.mockResolvedValue(undefined)

    await useWorkspace.getState().closePane(tab.id, pane.id)

    expect(invoke).toHaveBeenCalledWith('session_close', { sessionId: 's1' })
    expect(useWorkspace.getState().tabs).toHaveLength(0)
    expect(useWorkspace.getState().activeTabId).toBeNull()
  })
})

describe('closing tabs', () => {
  /** Regression: focus used to move to the last remaining tab whenever a tab
   * closed, so clicking the ✕ on a *background* tab yanked the user out of
   * the session they were actually looking at. */
  it('closing a background tab leaves the user on the tab they were viewing', async () => {
    mockConnect('s1', 'h1')
    await useWorkspace.getState().openSsh('h1')
    mockConnect('s2', 'h2')
    await useWorkspace.getState().openSsh('h2')
    mockConnect('s3', 'h3')
    await useWorkspace.getState().openSsh('h3')

    const [t1, , t3] = useWorkspace.getState().tabs
    useWorkspace.getState().focusTab(t1.id)
    invoke.mockResolvedValue(undefined)

    await useWorkspace.getState().closeTab(t3.id)

    expect(useWorkspace.getState().activeTabId).toBe(t1.id)
    expect(useWorkspace.getState().tabs).toHaveLength(2)
  })

  it('closing the tab in view moves focus to a remaining tab', async () => {
    mockConnect('s1', 'h1')
    await useWorkspace.getState().openSsh('h1')
    mockConnect('s2', 'h2')
    await useWorkspace.getState().openSsh('h2')

    const [t1, t2] = useWorkspace.getState().tabs
    useWorkspace.getState().focusTab(t2.id)
    invoke.mockResolvedValue(undefined)

    await useWorkspace.getState().closeTab(t2.id)

    expect(useWorkspace.getState().activeTabId).toBe(t1.id)
  })

  /** Regression: the pane was removed only *after* awaiting the backend, so a
   * second click during that window found it again and closed an already-gone
   * session — surfacing an error toast for a successful close. */
  it('closing the same pane twice concurrently only closes the session once', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    const tab = useWorkspace.getState().tabs[0]
    const pane = flattenLeaves(tab.root)[0]
    invoke.mockClear()
    invoke.mockResolvedValue(undefined)

    await Promise.all([
      useWorkspace.getState().closePane(tab.id, pane.id),
      useWorkspace.getState().closePane(tab.id, pane.id),
    ])

    const closes = invoke.mock.calls.filter((c) => c[0] === 'session_close')
    expect(closes).toHaveLength(1)
    expect(useWorkspace.getState().errors).toEqual([])
  })
})

describe('findParentSplit', () => {
  it('returns null for the unsplit root — nothing to toggle yet', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    const tab = useWorkspace.getState().tabs[0]

    expect(findParentSplit(tab.root, tab.activePaneId)).toBeNull()
  })

  it('returns the split that directly contains the active pane', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().splitActive('sftp')
    const tab = useWorkspace.getState().tabs[0]

    const split = findParentSplit(tab.root, tab.activePaneId)

    expect(split?.id).toBe(tab.root.id)
  })
})

describe('activeSessionIds', () => {
  it('by default returns only the session of the focused pane', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    mockConnect('s2')
    await useWorkspace.getState().openSsh('h2')

    expect(useWorkspace.getState().activeSessionIds()).toEqual(['s2'])
  })

  it('with broadcast on, returns every session with no duplicates', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().splitActive('sftp') // same s1
    mockConnect('s2')
    await useWorkspace.getState().openSsh('h2')
    useWorkspace.getState().setBroadcast(true)

    const ids = useWorkspace.getState().activeSessionIds()

    expect(ids.sort()).toEqual(['s1', 's2'])
  })
})

describe('markClosed', () => {
  it('records the close reason on the tracked session', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')

    useWorkspace.getState().markClosed('s1', 'exit status 0', 0)

    expect(useWorkspace.getState().sessions.s1.closedReason).toBe('exit status 0')
  })

  it('ignores a nonexistent session instead of creating an empty entry', () => {
    useWorkspace.getState().markClosed('nonexistent', 'eof', 0)

    expect(useWorkspace.getState().sessions).toEqual({})
  })

  it('ignores a closed event arriving late from a previous connection', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().reconnect('s1', 80, 24)

    // Generation 0's pump shut down late and only now fires its event.
    useWorkspace.getState().markClosed('s1', 'eof', 0)

    expect(useWorkspace.getState().sessions.s1.closedReason).toBeNull()
  })
})

describe('reconnect', () => {
  it('clears the closed state and increments the generation', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    useWorkspace.getState().markClosed('s1', 'eof', 0)

    await useWorkspace.getState().reconnect('s1', 120, 40)

    const session = useWorkspace.getState().sessions.s1
    expect(session.closedReason).toBeNull()
    expect(session.generation).toBe(1)
    expect(session.reconnecting).toBe(false)
    expect(invoke).toHaveBeenCalledWith('session_reconnect', {
      sessionId: 's1',
      cols: 120,
      rows: 40,
    })
  })

  it('keeps the same session id so the pane does not have to be rebuilt', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    const paneBefore = flattenLeaves(useWorkspace.getState().tabs[0].root)[0]

    await useWorkspace.getState().reconnect('s1', 80, 24)

    const paneAfter = flattenLeaves(useWorkspace.getState().tabs[0].root)[0]
    expect(paneAfter.id).toBe(paneBefore.id)
    expect(paneAfter.sessionId).toBe('s1')
  })

  it('reports the error and clears the reconnecting flag when reconnecting fails', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    invoke.mockRejectedValue({ message: 'connection refused', kind: 'generic', data: null })

    await useWorkspace.getState().reconnect('s1', 80, 24)

    expect(useWorkspace.getState().errors.at(-1)?.message).toBe('connection refused')
    expect(useWorkspace.getState().sessions.s1.reconnecting).toBe(false)
  })
})
