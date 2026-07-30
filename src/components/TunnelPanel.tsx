import { useEffect, useState } from 'react'

import { onTunnelState } from '../lib/bus'
import { tunnelApi } from '../lib/ipc'
import type { TunnelKind, TunnelSpec } from '../lib/types'
import { describe, useVault } from '../state/useVault'

interface Props {
  sessionId: string
  hostId: string
  onClose: () => void
}

function emptySpec(hostId: string): TunnelSpec {
  return {
    id: '',
    hostId,
    name: '',
    kind: 'local',
    // Bind loopback theo mặc định — mở ra LAN phải sửa tay.
    bindAddr: '127.0.0.1',
    bindPort: 8080,
    targetHost: '127.0.0.1',
    targetPort: 80,
    autoStart: false,
  }
}

export function TunnelPanel({ sessionId, hostId, onClose }: Props) {
  const { tunnels, saveTunnel, deleteTunnel } = useVault()
  const [draft, setDraft] = useState<TunnelSpec>(emptySpec(hostId))
  const [active, setActive] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)

  const mine = tunnels.filter((t) => t.hostId === hostId)

  useEffect(() => {
    void tunnelApi.active().then(setActive).catch(() => undefined)
    return onTunnelState((event) => {
      setActive((current) =>
        event.active
          ? Array.from(new Set([...current, event.tunnelId]))
          : current.filter((id) => id !== event.tunnelId),
      )
      if (event.message) setStatus(event.message)
    })
  }, [])

  const patch = (next: Partial<TunnelSpec>) => setDraft({ ...draft, ...next })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await saveTunnel({ ...draft, name: draft.name.trim() || `${draft.kind}:${draft.bindPort}` })
      setDraft(emptySpec(hostId))
      setStatus(null)
    } catch (err) {
      setStatus(describe(err))
    }
  }

  const toggle = async (spec: TunnelSpec) => {
    try {
      if (active.includes(spec.id)) {
        await tunnelApi.stop(sessionId, spec.id)
        setStatus(`đã dừng ${spec.name}`)
      } else {
        const port = await tunnelApi.start(sessionId, spec.id)
        setStatus(`${spec.name} đang chạy trên cổng ${port}`)
      }
    } catch (err) {
      setStatus(describe(err))
    }
  }

  const describeSpec = (spec: TunnelSpec) => {
    if (spec.kind === 'dynamic') {
      return `SOCKS5 ${spec.bindAddr}:${spec.bindPort} → đích tuỳ từng kết nối`
    }
    if (spec.kind === 'local') {
      return `${spec.bindAddr}:${spec.bindPort} → ${spec.targetHost}:${spec.targetPort} (remote)`
    }
    return `remote ${spec.bindAddr}:${spec.bindPort} → ${spec.targetHost}:${spec.targetPort} (local)`
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Port forwarding</h2>

        <ul className="rows">
          {mine.map((spec) => (
            <li key={spec.id}>
              <span className={`dot ${active.includes(spec.id) ? 'on' : ''}`} aria-hidden />
              <span className="row-name">{spec.name}</span>
              <code className="row-meta">{describeSpec(spec)}</code>
              <span className="row-tools">
                <button className="btn-primary" onClick={() => void toggle(spec)}>
                  {active.includes(spec.id) ? 'Stop' : 'Start'}
                </button>
                <button className="btn-quiet" onClick={() => setDraft(spec)}>Sửa</button>
                <button className="btn-quiet" onClick={() => void deleteTunnel(spec.id)}>Xoá</button>
              </span>
            </li>
          ))}
          {mine.length === 0 && <li className="placeholder"><strong>Host này chưa có tunnel</strong><p>Thêm một tunnel ở form bên dưới rồi bấm Start khi cần.</p></li>}
        </ul>

        <form onSubmit={submit}>
          <div className="grid-2">
            <label>
              Tên
              <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </label>
            <label>
              Kiểu
              <select
                value={draft.kind}
                onChange={(e) => patch({ kind: e.target.value as TunnelKind })}
              >
                <option value="local">Local (-L)</option>
                <option value="remote">Remote (-R)</option>
                <option value="dynamic">Dynamic, SOCKS5 (-D)</option>
              </select>
            </label>
            <label>
              Bind address
              <input
                value={draft.bindAddr}
                onChange={(e) => patch({ bindAddr: e.target.value })}
              />
            </label>
            <label>
              Bind port
              <input
                type="number"
                min={0}
                max={65535}
                value={draft.bindPort}
                onChange={(e) => patch({ bindPort: Number(e.target.value) || 0 })}
              />
            </label>
            {/* Dynamic không có đích cố định — mỗi kết nối SOCKS tự khai đích. */}
            {draft.kind !== 'dynamic' && (
              <>
                <label>
                  Target host
                  <input
                    value={draft.targetHost}
                    onChange={(e) => patch({ targetHost: e.target.value })}
                  />
                </label>
                <label>
                  Target port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.targetPort}
                    onChange={(e) => patch({ targetPort: Number(e.target.value) || 80 })}
                  />
                </label>
              </>
            )}
          </div>

          {status && <p className="hint">{status}</p>}

          <footer className="modal-foot">
            <button type="button" onClick={onClose}>
              Đóng
            </button>
            <button type="submit" className="btn-primary">
              {draft.id ? 'Cập nhật' : 'Thêm tunnel'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
