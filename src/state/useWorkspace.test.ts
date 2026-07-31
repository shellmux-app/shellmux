import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { useWorkspace } from './useWorkspace'

function resetStore() {
  useWorkspace.setState({
    tabs: [],
    activeTabId: null,
    sessions: {},
    broadcast: false,
    hostKeyPrompt: null,
    errors: [],
    connectingHostId: null,
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
    expect(tabs[0].panes).toHaveLength(1)
    expect(tabs[0].panes[0].view).toBe('terminal')
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
    expect(tab.panes).toHaveLength(2)
    expect(tab.panes[1].view).toBe('sftp')
    // Core point: same session ⇒ SFTP does not open a second SSH connection.
    expect(tab.panes[1].sessionId).toBe('s1')
    expect(tab.activePaneId).toBe(tab.panes[1].id)
  })

  it('closing one pane of a session still used by another pane does not close the session', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().splitActive('sftp')
    const tab = useWorkspace.getState().tabs[0]
    invoke.mockClear()

    await useWorkspace.getState().closePane(tab.id, tab.panes[1].id)

    expect(invoke).not.toHaveBeenCalledWith('session_close', expect.anything())
    expect(useWorkspace.getState().tabs[0].panes).toHaveLength(1)
  })

  it('closing the last pane closes the session and drops the tab', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    const tab = useWorkspace.getState().tabs[0]
    invoke.mockClear()
    invoke.mockResolvedValue(undefined)

    await useWorkspace.getState().closePane(tab.id, tab.panes[0].id)

    expect(invoke).toHaveBeenCalledWith('session_close', { sessionId: 's1' })
    expect(useWorkspace.getState().tabs).toHaveLength(0)
    expect(useWorkspace.getState().activeTabId).toBeNull()
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
    const paneBefore = useWorkspace.getState().tabs[0].panes[0]

    await useWorkspace.getState().reconnect('s1', 80, 24)

    const paneAfter = useWorkspace.getState().tabs[0].panes[0]
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
