import { beforeEach, describe, expect, it, vi } from 'vitest'

// Captures the callback each `listen(event, cb)` call registers, so tests can
// fire it directly instead of needing a real Tauri IPC bridge.
const listeners = new Map<string, (event: { payload: unknown }) => void>()
const listen = vi.fn((event: string, cb: (event: { payload: unknown }) => void) => {
  listeners.set(event, cb)
  return Promise.resolve(() => listeners.delete(event))
})
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: Parameters<typeof listen>) => listen(...args) }))
vi.mock('./env', () => ({ isTauriRuntime: () => true }))

// Each test file gets a fresh module registry so `startBus`'s `started` guard
// doesn't leak between tests.
async function freshBus() {
  vi.resetModules()
  listeners.clear()
  return import('./bus')
}

beforeEach(() => {
  listen.mockClear()
})

describe('startBus', () => {
  it('registers exactly one listener per event, even if called more than once', async () => {
    const { startBus } = await freshBus()

    startBus()
    startBus()

    const events = listen.mock.calls.map((call) => call[0])
    expect(events).toEqual(['session:data', 'session:closed', 'tunnel:state', 'sftp:transfer'])
  })
})

describe('attachWriter', () => {
  it('routes decoded bytes to the writer registered for that session id, not others', async () => {
    const { startBus, attachWriter } = await freshBus()
    startBus()

    const receivedA: Uint8Array[] = []
    const receivedB: Uint8Array[] = []
    attachWriter('s1', (bytes) => receivedA.push(bytes))
    attachWriter('s2', (bytes) => receivedB.push(bytes))

    listeners.get('session:data')?.({ payload: { sessionId: 's1', data: 'aGVsbG8=' } })

    expect(receivedA).toHaveLength(1)
    expect(new TextDecoder().decode(receivedA[0])).toBe('hello')
    expect(receivedB).toHaveLength(0)
  })

  it('detaching stops delivery to that writer', async () => {
    const { startBus, attachWriter } = await freshBus()
    startBus()

    const received: Uint8Array[] = []
    const detach = attachWriter('s1', (bytes) => received.push(bytes))
    detach()

    listeners.get('session:data')?.({ payload: { sessionId: 's1', data: 'aGVsbG8=' } })

    expect(received).toHaveLength(0)
  })

  it('a stale detach does not remove a newer writer registered under the same id', async () => {
    const { startBus, attachWriter } = await freshBus()
    startBus()

    const receivedFirst: Uint8Array[] = []
    const receivedSecond: Uint8Array[] = []
    const detachFirst = attachWriter('s1', (bytes) => receivedFirst.push(bytes))
    attachWriter('s1', (bytes) => receivedSecond.push(bytes)) // e.g. remount without detaching first

    detachFirst()
    listeners.get('session:data')?.({ payload: { sessionId: 's1', data: 'aGVsbG8=' } })

    expect(receivedFirst).toHaveLength(0)
    expect(receivedSecond).toHaveLength(1)
  })
})

describe('onSessionClosed', () => {
  it('notifies every registered handler with the event fields', async () => {
    const { startBus, onSessionClosed } = await freshBus()
    startBus()

    const seen: Array<[string, string, number]> = []
    onSessionClosed((sessionId, reason, generation) => seen.push([sessionId, reason, generation]))

    listeners.get('session:closed')?.({
      payload: { sessionId: 's1', reason: 'eof', generation: 2 },
    })

    expect(seen).toEqual([['s1', 'eof', 2]])
  })

  it('unsubscribing stops further notifications', async () => {
    const { startBus, onSessionClosed } = await freshBus()
    startBus()

    const seen: string[] = []
    const unsubscribe = onSessionClosed((sessionId) => seen.push(sessionId))
    unsubscribe()

    listeners.get('session:closed')?.({
      payload: { sessionId: 's1', reason: 'eof', generation: 0 },
    })

    expect(seen).toEqual([])
  })
})

describe('onTunnelState', () => {
  it('notifies every registered handler with the tunnel event', async () => {
    const { startBus, onTunnelState } = await freshBus()
    startBus()

    const seen: unknown[] = []
    onTunnelState((event) => seen.push(event))

    const payload = { tunnelId: 't1', sessionId: 's1', active: true, message: null }
    listeners.get('tunnel:state')?.({ payload })

    expect(seen).toEqual([payload])
  })
})

describe('onTransferProgress', () => {
  it('notifies every registered handler with the transfer event', async () => {
    const { startBus, onTransferProgress } = await freshBus()
    startBus()

    const seen: unknown[] = []
    onTransferProgress((event) => seen.push(event))

    const payload = {
      transferId: 'tr1',
      bytesDone: 512,
      bytesTotal: 1024,
    }
    listeners.get('sftp:transfer')?.({ payload })

    expect(seen).toEqual([payload])
  })

  it('unsubscribing stops further notifications', async () => {
    const { startBus, onTransferProgress } = await freshBus()
    startBus()

    const seen: unknown[] = []
    const unsubscribe = onTransferProgress((event) => seen.push(event))
    unsubscribe()

    listeners.get('sftp:transfer')?.({
      payload: { transferId: 'tr1', bytesDone: 0, bytesTotal: null },
    })

    expect(seen).toEqual([])
  })
})
