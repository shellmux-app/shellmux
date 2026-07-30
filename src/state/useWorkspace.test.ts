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
    error: null,
  })
}

/** invoke giả: ssh_connect trả session, các command khác trả undefined. */
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
  it('mở tab mới với đúng một pane terminal', async () => {
    mockConnect('s1')

    await useWorkspace.getState().openSsh('h1')

    const { tabs, activeTabId, sessions } = useWorkspace.getState()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].panes).toHaveLength(1)
    expect(tabs[0].panes[0].view).toBe('terminal')
    expect(activeTabId).toBe(tabs[0].id)
    expect(sessions.s1.closedReason).toBeNull()
  })

  it('không tạo tab khi host key chưa được tin cậy, mà bật prompt', async () => {
    invoke.mockRejectedValue({
      message: 'host key chưa được tin cậy',
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

  it('phân biệt key đổi với host mới', async () => {
    invoke.mockRejectedValue({
      message: 'host key đã thay đổi',
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

  it('lỗi thường thì hiện thông báo, không hiện prompt host key', async () => {
    invoke.mockRejectedValue({ message: 'connection refused', kind: 'generic', data: null })

    await useWorkspace.getState().openSsh('h1')

    expect(useWorkspace.getState().hostKeyPrompt).toBeNull()
    expect(useWorkspace.getState().error).toBe('connection refused')
  })
})

describe('split panes', () => {
  it('pane SFTP mới dùng lại đúng session của pane đang focus', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')

    await useWorkspace.getState().splitActive('sftp')

    const tab = useWorkspace.getState().tabs[0]
    expect(tab.panes).toHaveLength(2)
    expect(tab.panes[1].view).toBe('sftp')
    // Điểm cốt lõi: cùng session ⇒ SFTP không mở connection SSH thứ hai.
    expect(tab.panes[1].sessionId).toBe('s1')
    expect(tab.activePaneId).toBe(tab.panes[1].id)
  })

  it('đóng một pane của session đang được pane khác dùng thì không đóng session', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().splitActive('sftp')
    const tab = useWorkspace.getState().tabs[0]
    invoke.mockClear()

    await useWorkspace.getState().closePane(tab.id, tab.panes[1].id)

    expect(invoke).not.toHaveBeenCalledWith('session_close', expect.anything())
    expect(useWorkspace.getState().tabs[0].panes).toHaveLength(1)
  })

  it('đóng pane cuối cùng thì đóng session và bỏ tab', async () => {
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
  it('mặc định chỉ trả session của pane đang focus', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    mockConnect('s2')
    await useWorkspace.getState().openSsh('h2')

    expect(useWorkspace.getState().activeSessionIds()).toEqual(['s2'])
  })

  it('bật broadcast thì trả mọi session, không trùng lặp', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().splitActive('sftp') // cùng s1
    mockConnect('s2')
    await useWorkspace.getState().openSsh('h2')
    useWorkspace.getState().setBroadcast(true)

    const ids = useWorkspace.getState().activeSessionIds()

    expect(ids.sort()).toEqual(['s1', 's2'])
  })
})

describe('markClosed', () => {
  it('ghi lý do đóng lên session đang theo dõi', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')

    useWorkspace.getState().markClosed('s1', 'exit status 0', 0)

    expect(useWorkspace.getState().sessions.s1.closedReason).toBe('exit status 0')
  })

  it('bỏ qua session không tồn tại thay vì tạo entry rỗng', () => {
    useWorkspace.getState().markClosed('không-có', 'eof', 0)

    expect(useWorkspace.getState().sessions).toEqual({})
  })

  it('bỏ qua event closed đến muộn từ lần kết nối trước', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    await useWorkspace.getState().reconnect('s1', 80, 24)

    // Pump của generation 0 tắt muộn và mới phát event bây giờ.
    useWorkspace.getState().markClosed('s1', 'eof', 0)

    expect(useWorkspace.getState().sessions.s1.closedReason).toBeNull()
  })
})

describe('reconnect', () => {
  it('xoá trạng thái đã đóng và tăng generation', async () => {
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

  it('giữ nguyên session id để pane không phải dựng lại', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    const paneBefore = useWorkspace.getState().tabs[0].panes[0]

    await useWorkspace.getState().reconnect('s1', 80, 24)

    const paneAfter = useWorkspace.getState().tabs[0].panes[0]
    expect(paneAfter.id).toBe(paneBefore.id)
    expect(paneAfter.sessionId).toBe('s1')
  })

  it('báo lỗi và thôi cờ reconnecting khi kết nối lại thất bại', async () => {
    mockConnect('s1')
    await useWorkspace.getState().openSsh('h1')
    invoke.mockRejectedValue({ message: 'connection refused', kind: 'generic', data: null })

    await useWorkspace.getState().reconnect('s1', 80, 24)

    expect(useWorkspace.getState().error).toBe('connection refused')
    expect(useWorkspace.getState().sessions.s1.reconnecting).toBe(false)
  })
})
