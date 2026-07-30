import { useState } from 'react'

import { THEMES } from '../lib/themes'
import type { Host } from '../lib/types'
import { describe, useVault } from '../state/useVault'

interface Props {
  host: Host | null
  onClose: () => void
}

const EMPTY: Host = {
  id: '',
  groupId: null,
  label: '',
  hostname: '',
  port: 22,
  username: '',
  identityId: null,
  jumpHostId: null,
  theme: null,
  colorTag: null,
  notes: null,
  sort: 0,
}

export function HostDialog({ host, onClose }: Props) {
  const { groups, hosts, identities, saveHost } = useVault()
  const [draft, setDraft] = useState<Host>(host ?? EMPTY)
  const [error, setError] = useState<string | null>(null)

  // Không cho một host tự làm jump host của chính nó.
  const jumpCandidates = hosts.filter((h) => h.id !== draft.id)

  const patch = (next: Partial<Host>) => setDraft({ ...draft, ...next })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.hostname.trim() || !draft.username.trim()) {
      setError('hostname và username là bắt buộc')
      return
    }
    try {
      await saveHost({
        ...draft,
        label: draft.label.trim() || draft.hostname.trim(),
      })
      onClose()
    } catch (err) {
      setError(describe(err))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{host ? 'Sửa host' : 'Host mới'}</h2>

        <div className="grid-2">
          <label>
            Tên hiển thị
            <input
              value={draft.label}
              onChange={(e) => patch({ label: e.target.value })}
              placeholder="web-01"
            />
          </label>
          <label>
            Nhóm
            <select
              value={draft.groupId ?? ''}
              onChange={(e) => patch({ groupId: e.target.value || null })}
            >
              <option value="">— không —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Hostname / IP
            <input
              value={draft.hostname}
              onChange={(e) => patch({ hostname: e.target.value })}
              placeholder="10.0.0.5"
              required
            />
          </label>
          <label>
            Port
            <input
              type="number"
              min={1}
              max={65535}
              value={draft.port}
              onChange={(e) => patch({ port: Number(e.target.value) || 22 })}
            />
          </label>
          <label>
            Username
            <input
              value={draft.username}
              onChange={(e) => patch({ username: e.target.value })}
              placeholder="root"
              required
            />
          </label>
          <label>
            Identity
            <select
              value={draft.identityId ?? ''}
              onChange={(e) => patch({ identityId: e.target.value || null })}
            >
              <option value="">— ssh-agent —</option>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.authKind})
                </option>
              ))}
            </select>
          </label>
          <label>
            Jump host (ProxyJump)
            <select
              value={draft.jumpHostId ?? ''}
              onChange={(e) => patch({ jumpHostId: e.target.value || null })}
            >
              <option value="">— trực tiếp —</option>
              {jumpCandidates.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Theme
            <select
              value={draft.theme ?? ''}
              onChange={(e) => patch({ theme: e.target.value || null })}
            >
              <option value="">— mặc định —</option>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Màu nhãn
            <input
              type="color"
              value={draft.colorTag ?? '#5eead4'}
              onChange={(e) => patch({ colorTag: e.target.value })}
            />
          </label>
        </div>

        <label>
          Ghi chú
          <textarea
            rows={3}
            value={draft.notes ?? ''}
            onChange={(e) => patch({ notes: e.target.value || null })}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <footer className="modal-foot">
          <button type="button" onClick={onClose}>
            Huỷ
          </button>
          <button type="submit" className="primary">
            Lưu
          </button>
        </footer>
      </form>
    </div>
  )
}
