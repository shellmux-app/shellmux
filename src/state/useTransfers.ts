import { create } from 'zustand'

import { sftpApi } from '../lib/ipc'
import { describe } from './useVault'

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'queued' | 'active' | 'done' | 'failed'

export interface Transfer {
  id: string
  sessionId: string
  direction: TransferDirection
  /** Filename shown in the queue — not the full path. */
  label: string
  localPath: string
  remotePath: string
  bytesDone: number
  bytesTotal: number | null
  status: TransferStatus
  error: string | null
}

interface TransferProgressEvent {
  transferId: string
  bytesDone: number
  bytesTotal: number | null
}

interface TransfersState {
  items: Transfer[]
  enqueue: (init: {
    id: string
    sessionId: string
    direction: TransferDirection
    label: string
    localPath: string
    remotePath: string
  }) => void
  /** Re-queues a failed transfer. If it made any progress last time, the
   * next attempt resumes from there instead of starting over. */
  retry: (id: string) => void
  remove: (id: string) => void
  clearFinished: () => void
  /** Wired to the `sftp:transfer` event once, in App — see bus.ts. */
  applyProgress: (event: TransferProgressEvent) => void
}

/** Runs the next queued transfer, one at a time — they all share the
 * session's single SFTP channel, so real concurrency would just serialize
 * at the protocol level anyway while making the UI harder to reason about. */
function processNext() {
  const { items } = useTransfers.getState()
  if (items.some((t) => t.status === 'active')) return

  const next = items.find((t) => t.status === 'queued')
  if (!next) return

  useTransfers.setState({
    items: useTransfers.getState().items.map((t) =>
      t.id === next.id ? { ...t, status: 'active', error: null } : t,
    ),
  })

  const resume = next.bytesDone > 0
  const run =
    next.direction === 'download'
      ? sftpApi.download(next.sessionId, next.remotePath, next.localPath, next.id, resume)
      : sftpApi.upload(next.sessionId, next.localPath, next.remotePath, next.id, resume)

  // The command's own settled promise is the single source of truth for how
  // a transfer ended — see `finish`. The `sftp:transfer` event only carries
  // incremental progress, so there's nothing to race against.
  run
    .then((bytes) => finish(next.id, { bytesDone: bytes }))
    .catch((e: unknown) => finish(next.id, { error: describe(e) }))
    .finally(processNext)
}

/** Applies a transfer's terminal state. On failure `bytesDone` is left at
 * whatever the last progress event reported — the furthest point actually
 * reached, which is exactly the offset a resumed retry starts from. */
function finish(id: string, outcome: { bytesDone?: number; error?: string }) {
  useTransfers.setState({
    items: useTransfers.getState().items.map((t) =>
      t.id === id
        ? {
            ...t,
            status: outcome.error ? 'failed' : 'done',
            error: outcome.error ?? null,
            bytesDone: outcome.bytesDone ?? t.bytesDone,
            bytesTotal: outcome.bytesDone ?? t.bytesTotal,
          }
        : t,
    ),
  })
}

export const useTransfers = create<TransfersState>((set, get) => ({
  items: [],

  enqueue: (init) => {
    const transfer: Transfer = {
      ...init,
      bytesDone: 0,
      bytesTotal: null,
      status: 'queued',
      error: null,
    }
    set({ items: [...get().items, transfer] })
    processNext()
  },

  retry: (id) => {
    set({
      items: get().items.map((t) => (t.id === id ? { ...t, status: 'queued', error: null } : t)),
    })
    processNext()
  },

  remove: (id) => set({ items: get().items.filter((t) => t.id !== id) }),

  clearFinished: () => set({ items: get().items.filter((t) => t.status !== 'done') }),

  applyProgress: (event) => {
    set({
      items: get().items.map((t) => {
        // Only update a transfer that's still running: a late event arriving
        // after the command already resolved must not resurrect a finished
        // row or rewind its byte count.
        if (t.id !== event.transferId || t.status !== 'active') return t
        return { ...t, bytesDone: event.bytesDone, bytesTotal: event.bytesTotal }
      }),
    })
  },
}))
