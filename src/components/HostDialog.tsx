import { useState } from 'react'
import {
  CaretRightIcon,
  CheckIcon,
  DesktopTowerIcon,
  FolderIcon,
  GlobeIcon,
  KeyIcon,
  PlugIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  XIcon,
} from '@phosphor-icons/react'

import { badgeColor, badgeText, PALETTE } from '../lib/badge'
import { THEMES } from '../lib/themes'
import type { Host } from '../lib/types'
import { useDialog } from '../state/useDialog'
import { describe, useVault } from '../state/useVault'

interface Props {
  host: Host | null
  onClose: () => void
  /** Called with the saved host's id after the Connect button saves it. */
  onConnect?: (hostId: string) => void
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

export function HostDialog({ host, onClose, onConnect }: Props) {
  const { groups, hosts, identities, saveGroup, saveHost } = useVault()
  const { ask } = useDialog()
  const [draft, setDraft] = useState<Host>(host ?? EMPTY)
  const [error, setError] = useState<string | null>(null)

  // A host can't be its own jump host.
  const jumpCandidates = hosts.filter((h) => h.id !== draft.id)

  const autoColor = badgeColor(draft.id || draft.label || draft.hostname || 'new-host')
  const autoInitials = badgeText(draft.label || draft.hostname || '?')
  const isCustomColor =
    draft.colorTag !== null &&
    !PALETTE.some((hex) => hex.toLowerCase() === draft.colorTag?.toLowerCase())

  const patch = (next: Partial<Host>) => setDraft({ ...draft, ...next })

  const addGroup = async () => {
    const name = await ask({
      title: 'New group',
      label: 'Group name',
      placeholder: 'Production',
      confirmLabel: 'Create group',
    })
    if (!name) return
    const saved = await saveGroup({ id: '', parentId: null, name, sort: 0 })
    patch({ groupId: saved.id })
  }

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!draft.hostname.trim() || !draft.username.trim()) {
      setError('Hostname and username are required.')
      return
    }

    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    const shouldConnect = submitter?.value === 'connect'

    try {
      const saved = await saveHost({
        ...draft,
        label: draft.label.trim() || draft.hostname.trim(),
      })
      if (shouldConnect) onConnect?.(saved.id)
      onClose()
    } catch (err) {
      setError(describe(err))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>
          <DesktopTowerIcon />
          {host ? 'Edit Host' : 'New Host'}
        </h2>

        <div className="dialog-section">
          <h3 className="dialog-section-title">
            <GlobeIcon />
            Address
          </h3>

          <label>
            Name
            <input
              autoFocus
              value={draft.label}
              onChange={(e) => patch({ label: e.target.value })}
              placeholder={draft.hostname || 'web-01'}
            />
          </label>

          <div className="color-picker">
            <button
              type="button"
              className={`color-swatch ${draft.colorTag === null ? 'selected' : ''}`}
              style={{ '--swatch': autoColor } as React.CSSProperties}
              onClick={() => patch({ colorTag: null })}
              aria-label="Automatic color, matches the badge on the host card"
              title="Automatic — matches the badge on the host card"
            >
              {autoInitials}
            </button>
            {PALETTE.map((hex) => (
              <button
                key={hex}
                type="button"
                className={`color-swatch ${draft.colorTag?.toLowerCase() === hex.toLowerCase() ? 'selected' : ''}`}
                style={{ '--swatch': hex } as React.CSSProperties}
                onClick={() => patch({ colorTag: hex })}
                aria-label={`Color ${hex}`}
                title={hex}
              />
            ))}
            <input
              type="color"
              className={`color-swatch custom ${isCustomColor ? 'selected' : ''}`}
              value={draft.colorTag ?? autoColor}
              onChange={(e) => patch({ colorTag: e.target.value })}
              aria-label="Custom color"
              title="Custom color"
            />
          </div>

          <div className="field-row">
            <label>
              Hostname / IP
              <input
                value={draft.hostname}
                onChange={(e) => patch({ hostname: e.target.value })}
                placeholder="10.0.0.5"
                required
              />
            </label>
            <label className="narrow">
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) => patch({ port: Number(e.target.value) || 22 })}
              />
            </label>
          </div>
        </div>

        <div className="dialog-section">
          <h3 className="dialog-section-title">
            <FolderIcon />
            Group
          </h3>
          <div className="group-row">
            <label>
              Parent group
              <select
                value={draft.groupId ?? ''}
                onChange={(e) => patch({ groupId: e.target.value || null })}
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn-outline" onClick={() => void addGroup()}>
              <PlusIcon />
              New
            </button>
          </div>
        </div>

        <div className="dialog-section">
          <h3 className="dialog-section-title">
            <KeyIcon />
            Connection
          </h3>
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
              <option value="">Use ssh-agent</option>
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
              <option value="">Connect directly</option>
              {jumpCandidates.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <details className="dialog-advanced">
          <summary>
            <CaretRightIcon className="caret" />
            <SlidersHorizontalIcon />
            Advanced
          </summary>
          <div className="dialog-section">
            <label>
              Theme
              <select
                value={draft.theme ?? ''}
                onChange={(e) => patch({ theme: e.target.value || null })}
              >
                <option value="">Follow app theme</option>
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Notes
              <textarea
                rows={3}
                value={draft.notes ?? ''}
                onChange={(e) => patch({ notes: e.target.value || null })}
              />
            </label>
          </div>
        </details>

        {error && <p className="error">{error}</p>}

        <footer className="modal-foot">
          <button type="button" onClick={onClose}>
            <XIcon />
            Cancel
          </button>
          <button type="submit" name="intent" value="save" className="btn-outline">
            <CheckIcon />
            Save
          </button>
          <button type="submit" name="intent" value="connect" className="btn-primary">
            <PlugIcon />
            Connect
          </button>
        </footer>
      </form>
    </div>
  )
}
