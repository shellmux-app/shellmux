import { useEffect, useState } from 'react'
import {
  CaretRightIcon,
  CheckIcon,
  DesktopTowerIcon,
  EyeIcon,
  EyeSlashIcon,
  FolderIcon,
  GlobeIcon,
  KeyIcon,
  PlugIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  TerminalWindowIcon,
  XIcon,
} from '@phosphor-icons/react'

import { badgeColor, badgeText, PALETTE } from '../lib/badge'
import { keyApi, vaultApi } from '../lib/ipc'
import { THEMES } from '../lib/themes'
import type { AuthKind, Host, KeyInfo } from '../lib/types'
import { useDialog } from '../state/useDialog'
import { describe, useVault } from '../state/useVault'
import { KeyBadge } from './ui/KeyBadge'

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
  authKind: 'agent',
  identityId: null,
  jumpHostId: null,
  theme: null,
  colorTag: null,
  notes: null,
  sort: 0,
  agentForward: false,
}

const AUTH_CHOICES: { id: AuthKind; label: string; hint: string }[] = [
  { id: 'agent', label: 'SSH agent', hint: 'Use whichever key your running ssh-agent holds' },
  { id: 'key', label: 'Private key', hint: 'Use one saved key from the Keychain' },
  { id: 'password', label: 'Password', hint: 'Stored in the macOS keychain, per host' },
]

export function HostDialog({ host, onClose, onConnect }: Props) {
  const { groups, hosts, identities, saveGroup, saveHost } = useVault()
  const { ask } = useDialog()
  const [draft, setDraft] = useState<Host>(host ?? EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  /** Whether a password is already saved — the value itself is never readable. */
  const [passwordSaved, setPasswordSaved] = useState(false)
  const [keyInfo, setKeyInfo] = useState<KeyInfo | undefined>(undefined)

  const selectedKey = identities.find((i) => i.id === draft.identityId) ?? null

  useEffect(() => {
    if (!host?.id) return
    void vaultApi.hostHasPassword(host.id).then(setPasswordSaved).catch(() => undefined)
  }, [host?.id])

  // Describe the chosen key so the user can confirm it's the right one before
  // saving, rather than finding out at connect time.
  useEffect(() => {
    if (!selectedKey) {
      setKeyInfo(undefined)
      return
    }
    let cancelled = false
    void keyApi
      .inspect(selectedKey.privateKeyPath)
      .then((info) => {
        if (!cancelled) setKeyInfo(info)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [selectedKey])

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
    if (draft.authKind === 'key' && !draft.identityId) {
      setError('Pick which key to use, or switch to SSH agent.')
      return
    }
    if (draft.authKind === 'password' && !password && !passwordSaved) {
      setError('Enter a password, or switch to another sign-in method.')
      return
    }

    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    const shouldConnect = submitter?.value === 'connect'

    try {
      const saved = await saveHost(
        {
          ...draft,
          label: draft.label.trim() || draft.hostname.trim(),
          // Leave a stale key reference out of the record entirely.
          identityId: draft.authKind === 'key' ? draft.identityId : null,
          // A password has nothing to forward.
          agentForward: draft.authKind === 'password' ? false : draft.agentForward,
        },
        // Undefined leaves any stored password untouched.
        draft.authKind === 'password' && password ? password : undefined,
      )
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
            Sign in
          </h3>
          <label>
            Username
            <input
              value={draft.username}
              onChange={(e) => patch({ username: e.target.value })}
              placeholder="root"
              required
            />
            <span className="field-hint">
              Case-sensitive. Cloud images differ: <code>ubuntu</code>, <code>ec2-user</code>,{' '}
              <code>root</code>.
            </span>
          </label>

          {/* Segmented rather than a dropdown: there are only three, and each
              needs its own follow-up field right underneath. */}
          <div className="segmented" role="group" aria-label="Authentication method">
            {AUTH_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className={draft.authKind === choice.id ? 'active' : ''}
                aria-pressed={draft.authKind === choice.id}
                title={choice.hint}
                onClick={() => patch({ authKind: choice.id })}
              >
                {choice.label}
              </button>
            ))}
          </div>

          {draft.authKind === 'agent' && (
            <p className="field-hint">
              <TerminalWindowIcon size={13} /> Offers the keys already loaded in your ssh-agent
              — the same ones plain <code>ssh</code> would try.
            </p>
          )}

          {draft.authKind === 'key' && (
            <label>
              Key
              <select
                value={draft.identityId ?? ''}
                onChange={(e) => patch({ identityId: e.target.value || null })}
              >
                <option value="">Choose a key…</option>
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              {identities.length === 0 ? (
                <span className="field-hint">
                  No keys saved yet — add one in Keychain, or import <code>~/.ssh/config</code>.
                </span>
              ) : (
                selectedKey && <KeyBadge info={keyInfo} />
              )}
            </label>
          )}

          {draft.authKind === 'password' && (
            <label>
              Password
              <span className="file-row">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={passwordSaved ? '••••••••  saved — type to replace' : ''}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeSlashIcon /> : <EyeIcon />}
                </button>
              </span>
              <span className="field-hint">
                Goes straight into the macOS keychain. Nothing reads it back out to this window.
              </span>
            </label>
          )}

          {draft.authKind !== 'password' && (
            <label className="inline">
              <input
                type="checkbox"
                checked={draft.agentForward}
                onChange={(e) => patch({ agentForward: e.target.checked })}
              />
              Forward this to the host — lets it use{' '}
              {draft.authKind === 'agent' ? 'your ssh-agent' : 'this key'} to hop onward
            </label>
          )}

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
