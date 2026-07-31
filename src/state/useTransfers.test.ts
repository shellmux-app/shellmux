import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { useTransfers } from './useTransfers'

function resetStore() {
  useTransfers.setState({ items: [] })
}

function enqueueDownload(id: string) {
  useTransfers.getState().enqueue({
    id,
    sessionId: 's1',
    direction: 'download',
    label: `${id}.bin`,
    localPath: `/local/${id}.bin`,
    remotePath: `/remote/${id}.bin`,
  })
}

/** Lets every pending promise callback run — the queue advances through
 * `.then`/`.catch`/`.finally`, so tests have to drain the microtask queue
 * before asserting on what ran next. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(0)
  resetStore()
})

describe('enqueue', () => {
  it('adds a queued transfer and immediately starts it, since nothing else is running', () => {
    enqueueDownload('t1')

    expect(useTransfers.getState().items).toHaveLength(1)
    expect(useTransfers.getState().items[0].status).toBe('active')
  })

  it('calls sftp_download with resume=false for a brand new transfer', () => {
    enqueueDownload('t1')

    expect(invoke).toHaveBeenCalledWith('sftp_download', {
      sessionId: 's1',
      remote: '/remote/t1.bin',
      local: '/local/t1.bin',
      transferId: 't1',
      resume: false,
    })
  })

  it('queues a second transfer behind the first instead of running both at once', () => {
    invoke.mockReturnValue(new Promise(() => {})) // never settles: t1 stays active
    enqueueDownload('t1')
    enqueueDownload('t2')

    const items = useTransfers.getState().items
    expect(items.find((t) => t.id === 't1')?.status).toBe('active')
    expect(items.find((t) => t.id === 't2')?.status).toBe('queued')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

describe('completion', () => {
  it('marks a transfer done from the resolved command, with no progress event needed', async () => {
    invoke.mockResolvedValue(4096)
    enqueueDownload('t1')
    await flush()

    const t = useTransfers.getState().items[0]
    expect(t.status).toBe('done')
    expect(t.bytesDone).toBe(4096)
    expect(t.bytesTotal).toBe(4096)
  })

  it('marks a transfer failed from the rejected command, keeping partial progress', async () => {
    let reject!: (e: unknown) => void
    invoke.mockReturnValue(new Promise((_, r) => (reject = r)))
    enqueueDownload('t1')

    // 300 bytes made it before the connection dropped.
    useTransfers.getState().applyProgress({ transferId: 't1', bytesDone: 300, bytesTotal: 1000 })
    reject({ message: 'connection reset', kind: 'generic', data: null })
    await flush()

    const t = useTransfers.getState().items[0]
    expect(t.status).toBe('failed')
    expect(t.error).toBe('connection reset')
    // Kept, because it's exactly the offset a resumed retry starts from.
    expect(t.bytesDone).toBe(300)
  })

  /**
   * Regression: terminal state used to come from a `finished` event while the
   * queue advanced on the settled promise. If the promise settled first, the
   * transfer was still 'active', so the queue bailed and never restarted —
   * a permanent stall. The command's promise is now the only source of truth.
   */
  it('advances the queue on the resolved command even if no event ever arrives', async () => {
    enqueueDownload('t1')
    enqueueDownload('t2')

    await flush()

    // Both ran to completion without a single progress event being delivered.
    expect(useTransfers.getState().items.map((t) => t.status)).toEqual(['done', 'done'])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  /**
   * Regression: a command can fail *before* any transfer starts (the SFTP
   * channel won't open on a dropped session), so no progress event is ever
   * emitted. That used to leave the row 'active' forever and block the queue.
   */
  it('advances the queue when a command fails before emitting any progress', async () => {
    invoke.mockRejectedValue({ message: 'session does not exist', kind: 'generic', data: null })
    enqueueDownload('t1')
    enqueueDownload('t2')

    await flush()

    const items = useTransfers.getState().items
    expect(items.find((t) => t.id === 't1')?.status).toBe('failed')
    expect(items.find((t) => t.id === 't1')?.bytesDone).toBe(0)
    expect(items.find((t) => t.id === 't2')?.status).toBe('failed')
  })
})

describe('applyProgress', () => {
  it('updates bytesDone/bytesTotal while a transfer is running', () => {
    invoke.mockReturnValue(new Promise(() => {}))
    enqueueDownload('t1')

    useTransfers.getState().applyProgress({ transferId: 't1', bytesDone: 500, bytesTotal: 1000 })

    const t = useTransfers.getState().items[0]
    expect(t.bytesDone).toBe(500)
    expect(t.bytesTotal).toBe(1000)
    expect(t.status).toBe('active')
  })

  it('ignores a late event for a transfer that already finished', async () => {
    invoke.mockResolvedValue(1000)
    enqueueDownload('t1')
    await flush()

    // A straggler event lands after the command already resolved.
    useTransfers.getState().applyProgress({ transferId: 't1', bytesDone: 700, bytesTotal: 1000 })

    const t = useTransfers.getState().items[0]
    expect(t.status).toBe('done')
    expect(t.bytesDone).toBe(1000) // not rewound to 700
  })

  it('ignores progress for an id that is not in the queue', () => {
    invoke.mockReturnValue(new Promise(() => {}))
    enqueueDownload('t1')
    const before = useTransfers.getState().items

    useTransfers.getState().applyProgress({ transferId: 'nope', bytesDone: 1, bytesTotal: 1 })

    expect(useTransfers.getState().items).toEqual(before)
  })
})

describe('retry', () => {
  it('resumes a failed transfer that made partial progress', async () => {
    let reject!: (e: unknown) => void
    invoke.mockReturnValue(new Promise((_, r) => (reject = r)))
    enqueueDownload('t1')
    useTransfers.getState().applyProgress({ transferId: 't1', bytesDone: 400, bytesTotal: 1000 })
    reject({ message: 'network error', kind: 'generic', data: null })
    await flush()
    invoke.mockClear()
    invoke.mockReturnValue(new Promise(() => {}))

    useTransfers.getState().retry('t1')

    expect(useTransfers.getState().items[0].status).toBe('active')
    expect(invoke).toHaveBeenCalledWith(
      'sftp_download',
      expect.objectContaining({ transferId: 't1', resume: true }),
    )
  })

  it('does not resume a transfer that failed before any progress was made', async () => {
    invoke.mockRejectedValue({ message: 'could not connect', kind: 'generic', data: null })
    enqueueDownload('t1')
    await flush()
    invoke.mockClear()
    invoke.mockReturnValue(new Promise(() => {}))

    useTransfers.getState().retry('t1')

    expect(invoke).toHaveBeenCalledWith('sftp_download', expect.objectContaining({ resume: false }))
  })
})

describe('remove / clearFinished', () => {
  it('remove drops a transfer regardless of its status', () => {
    invoke.mockReturnValue(new Promise(() => {}))
    enqueueDownload('t1')
    useTransfers.getState().remove('t1')
    expect(useTransfers.getState().items).toEqual([])
  })

  it('clearFinished drops only done transfers, keeping active/queued/failed', async () => {
    invoke.mockResolvedValue(1)
    enqueueDownload('t1')
    await flush()
    invoke.mockReturnValue(new Promise(() => {}))
    enqueueDownload('t2')
    enqueueDownload('t3')

    useTransfers.getState().clearFinished()

    expect(useTransfers.getState().items.map((t) => t.id)).toEqual(['t2', 't3'])
  })
})
