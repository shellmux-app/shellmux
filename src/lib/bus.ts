import { listen } from '@tauri-apps/api/event'

import { decodeBytes } from './ipc'

interface DataEvent {
  sessionId: string
  data: string
}

interface ClosedEvent {
  sessionId: string
  reason: string
  /** Pump cũ có thể phát event muộn sau khi đã reconnect — xem store. */
  generation: number
}

interface TunnelEvent {
  tunnelId: string
  sessionId: string
  active: boolean
  message: string | null
}

type Writer = (bytes: Uint8Array) => void
type CloseHandler = (sessionId: string, reason: string, generation: number) => void
type TunnelHandler = (event: TunnelEvent) => void

/**
 * Một listener duy nhất cho toàn app rồi route theo sessionId. Mỗi terminal tự
 * đăng ký writer của nó — nếu để từng component gọi `listen` thì N tab sẽ tạo
 * N listener và mỗi byte phải đi qua tất cả.
 */
const writers = new Map<string, Writer>()
const closeHandlers = new Set<CloseHandler>()
const tunnelHandlers = new Set<TunnelHandler>()

let started = false

export function startBus(): void {
  if (started) return
  started = true

  void listen<DataEvent>('session:data', (event) => {
    const writer = writers.get(event.payload.sessionId)
    if (writer) writer(decodeBytes(event.payload.data))
  })

  void listen<ClosedEvent>('session:closed', (event) => {
    const { sessionId, reason, generation } = event.payload
    closeHandlers.forEach((handler) => handler(sessionId, reason, generation))
  })

  void listen<TunnelEvent>('tunnel:state', (event) => {
    tunnelHandlers.forEach((handler) => handler(event.payload))
  })
}

export function attachWriter(sessionId: string, writer: Writer): () => void {
  writers.set(sessionId, writer)
  return () => {
    if (writers.get(sessionId) === writer) writers.delete(sessionId)
  }
}

export function onSessionClosed(handler: CloseHandler): () => void {
  closeHandlers.add(handler)
  return () => closeHandlers.delete(handler)
}

export function onTunnelState(handler: TunnelHandler): () => void {
  tunnelHandlers.add(handler)
  return () => tunnelHandlers.delete(handler)
}
