import { useEffect, useState } from 'react'
import {
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'

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
    // Bind to loopback by default — opening it up to the LAN requires a manual edit.
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
        setStatus(`stopped ${spec.name}`)
      } else {
        const port = await tunnelApi.start(sessionId, spec.id)
        setStatus(`${spec.name} is running on port ${port}`)
      }
    } catch (err) {
      setStatus(describe(err))
    }
  }

  const describeSpec = (spec: TunnelSpec) => {
    if (spec.kind === 'dynamic') {
      return `SOCKS5 ${spec.bindAddr}:${spec.bindPort} → destination set per connection`
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
                  {active.includes(spec.id) ? (
                    <>
                      <StopIcon weight="fill" />
                      Stop
                    </>
                  ) : (
                    <>
                      <PlayIcon weight="fill" />
                      Start
                    </>
                  )}
                </button>
                <button className="btn-quiet" onClick={() => setDraft(spec)}>
                  <PencilSimpleIcon />
                  Edit
                </button>
                <button className="btn-quiet" onClick={() => void deleteTunnel(spec.id)}>
                  <TrashIcon />
                  Delete
                </button>
              </span>
            </li>
          ))}
          {mine.length === 0 && <li className="placeholder"><strong>This host has no tunnels yet</strong><p>Add a tunnel in the form below, then click Start when you need it.</p></li>}
        </ul>

        <form onSubmit={submit}>
          <div className="grid-2">
            <label>
              Name
              <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </label>
            <label>
              Type
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
            {/* Dynamic has no fixed destination — each SOCKS connection declares its own destination. */}
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
              <XIcon />
              Close
            </button>
            <button type="submit" className="btn-primary">
              {draft.id ? (
                'Update'
              ) : (
                <>
                  <PlusIcon />
                  Add tunnel
                </>
              )}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
