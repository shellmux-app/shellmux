import { useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  FolderOpenIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'

import type { AuthKind, Identity } from '../../lib/types'
import { describe, useVault } from '../../state/useVault'

const EMPTY: Identity = {
  id: '',
  name: '',
  authKind: 'agent',
  username: null,
  privateKeyPath: null,
  hasSecret: false,
}

const KIND_LABEL: Record<AuthKind, string> = {
  agent: 'ssh-agent',
  privateKey: 'Private key',
  password: 'Password',
}

export function KeychainScreen() {
  const { identities, saveIdentity, deleteIdentity } = useVault()
  const [draft, setDraft] = useState<Identity>(EMPTY)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)

  const patch = (next: Partial<Identity>) => setDraft({ ...draft, ...next })

  const reset = () => {
    setDraft(EMPTY)
    setSecret('')
  }

  const pickKey = async () => {
    const picked = await openDialog({ multiple: false, directory: false })
    if (typeof picked === 'string') patch({ privateKeyPath: picked })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.name.trim()) {
      setError('identity needs a name')
      return
    }
    if (draft.authKind === 'privateKey' && !draft.privateKeyPath) {
      setError('select a private key file')
      return
    }
    try {
      // empty secret + new identity ⇒ send undefined so we don't create an empty keychain entry.
      await saveIdentity(draft, secret ? secret : undefined)
      reset()
      setError(null)
    } catch (err) {
      setError(describe(err))
    }
  }

  return (
    <div className="screen">
      <div className="screen-body">
        <h2 className="section-title">Identities</h2>

        <ul className="rows">
          {identities.map((identity) => (
            <li key={identity.id}>
              <span className="row-name">{identity.name}</span>
              <span className="badge">{KIND_LABEL[identity.authKind]}</span>
              <span className="row-meta">
                {identity.privateKeyPath ?? (identity.hasSecret ? 'Secret saved in keychain' : 'No secret needed')}
              </span>
              <span className="row-tools">
                <button
                  className="btn-quiet"
                  onClick={() => {
                    setDraft(identity)
                    setSecret('')
                  }}
                >
                  <PencilSimpleIcon />
                  Edit
                </button>
                <button className="btn-quiet" onClick={() => void deleteIdentity(identity.id)}>
                  <TrashIcon />
                  Delete
                </button>
              </span>
            </li>
          ))}
          {identities.length === 0 && (
            <li className="placeholder">
              <strong>No identities yet</strong>
              <p>Add an identity in the form below to reuse it across multiple hosts.</p>
            </li>
          )}
        </ul>

        <form onSubmit={submit}>
          <div className="grid-2">
            <label>
              Name
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="deploy key"
              />
            </label>
            <label>
              Auth type
              <select
                value={draft.authKind}
                onChange={(e) => patch({ authKind: e.target.value as AuthKind })}
              >
                <option value="agent">ssh-agent</option>
                <option value="privateKey">Private key</option>
                <option value="password">Password</option>
              </select>
            </label>
            <label>
              Username (overrides the host's)
              <input
                value={draft.username ?? ''}
                onChange={(e) => patch({ username: e.target.value || null })}
                placeholder="optional"
              />
            </label>
            {draft.authKind === 'privateKey' && (
              <label>
                Private key
                <span className="file-row">
                  <input readOnly value={draft.privateKeyPath ?? ''} placeholder="~/.ssh/id_ed25519" />
                  <button type="button" onClick={() => void pickKey()}>
                    <FolderOpenIcon />
                    Choose…
                  </button>
                </span>
              </label>
            )}
            {draft.authKind !== 'agent' && (
              <label>
                {draft.authKind === 'password' ? 'Password' : 'Passphrase'}
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={draft.hasSecret ? '••• saved, type to replace' : 'saved to keychain'}
                />
              </label>
            )}
          </div>

          <p className="hint">
            Secrets go straight into the OS keychain. No API reads them back out to the UI.
          </p>

          {error && <p className="error">{error}</p>}

          <footer className="modal-foot">
            <button type="button" onClick={reset}>
              <ArrowCounterClockwiseIcon />
              Reset form
            </button>
            <button type="submit" className="btn-primary">
              {draft.id ? (
                <CheckIcon />
              ) : (
                <PlusIcon />
              )}
              {draft.id ? 'Update' : 'Add'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
