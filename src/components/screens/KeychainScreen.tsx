import { useEffect, useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  FolderOpenIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'

import { keyApi } from '../../lib/ipc'
import type { Identity, KeyInfo } from '../../lib/types'
import { useDialog } from '../../state/useDialog'
import { describe, useVault } from '../../state/useVault'
import { KeyBadge } from '../ui/KeyBadge'

const EMPTY: Identity = {
  id: '',
  name: '',
  privateKeyPath: '',
  hasSecret: false,
}

/** Order groups deliberately: unusable first, since those need action. */
const GROUP_ORDER = ['Needs attention', 'Hardware keys', 'Ed25519', 'RSA', 'ECDSA', 'Other']

function groupFor(info: KeyInfo | undefined): string {
  if (!info) return 'Other'
  if (info.kind !== 'privateKey') return 'Needs attention'
  if (info.warning) return 'Needs attention'
  if (info.algorithmId.startsWith('sk-')) return 'Hardware keys'
  switch (info.algorithmId) {
    case 'ed25519':
      return 'Ed25519'
    case 'rsa':
      return 'RSA'
    case 'ecdsa':
      return 'ECDSA'
    default:
      return 'Other'
  }
}

/**
 * The saved private keys. Everything shown about a key — type, size,
 * fingerprint, whether it's passphrase-protected — is read from the file
 * itself, so the list stays truthful even when a key is moved or replaced
 * outside the app.
 */
export function KeychainScreen() {
  const { identities, hosts, saveIdentity, deleteIdentity } = useVault()
  const { confirm } = useDialog()
  const [draft, setDraft] = useState<Identity>(EMPTY)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<Record<string, KeyInfo>>({})
  const [draftInfo, setDraftInfo] = useState<KeyInfo | undefined>(undefined)

  const patch = (next: Partial<Identity>) => setDraft({ ...draft, ...next })

  const reset = () => {
    setDraft(EMPTY)
    setSecret('')
    setDraftInfo(undefined)
  }

  // Inspect every saved key whenever the list changes. One batched call keeps
  // this to a single round trip no matter how many keys there are.
  useEffect(() => {
    if (identities.length === 0) {
      setInfo({})
      return
    }
    let cancelled = false
    void keyApi
      .inspectMany(identities.map((i) => i.privateKeyPath))
      .then((results) => {
        if (cancelled) return
        setInfo(Object.fromEntries(identities.map((i, n) => [i.id, results[n]])))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [identities])

  const pickKey = async () => {
    const picked = await openDialog({ multiple: false, directory: false })
    if (typeof picked !== 'string') return

    patch({
      privateKeyPath: picked,
      // Offer the filename as the name, but never overwrite one already typed.
      name: draft.name || (picked.split('/').pop() ?? ''),
    })

    // Check it straight away: picking `id_ed25519.pub` by mistake is the most
    // common way to get an unexplained failure much later, at connect time.
    setDraftInfo(await keyApi.inspect(picked).catch(() => undefined))
  }

  /** How many hosts would break if this key went away. */
  const usageOf = (identityId: string) =>
    hosts.filter((h) => h.authKind === 'key' && h.identityId === identityId).length

  const grouped = useMemo(() => {
    const buckets = new Map<string, Identity[]>()
    for (const identity of identities) {
      const group = groupFor(info[identity.id])
      buckets.set(group, [...(buckets.get(group) ?? []), identity])
    }
    return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => ({
      group: g,
      items: buckets.get(g) ?? [],
    }))
  }, [identities, info])

  const remove = async (identity: Identity) => {
    const uses = usageOf(identity.id)
    const ok = await confirm({
      title: `Delete ${identity.name}?`,
      body:
        uses > 0
          ? `${uses} host${uses === 1 ? '' : 's'} sign in with this key and will stop working \
until you pick another one. The key file on disk is not deleted.`
          : 'Removes it from Shellmux only. The key file on disk is not deleted.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) await deleteIdentity(identity.id)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.name.trim()) {
      setError('Give the key a name.')
      return
    }
    if (!draft.privateKeyPath) {
      setError('Choose a private key file.')
      return
    }
    try {
      // An empty secret on a new key means "no passphrase" — send undefined so
      // we don't create a blank keychain entry for it.
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
        <h2 className="section-title">Keys</h2>

        {identities.length === 0 ? (
          <div className="placeholder">
            <strong>No keys yet</strong>
            <p>
              Add one below to reuse it across hosts, or import everything already in
              <code> ~/.ssh/config</code> from the left column.
            </p>
          </div>
        ) : (
          grouped.map(({ group, items }) => (
            <div key={group}>
              <h3 className="section-title">{group}</h3>
              <ul className="rows">
                {items.map((identity) => {
                  const uses = usageOf(identity.id)
                  return (
                    <li key={identity.id}>
                      <span className="row-name">{identity.name}</span>
                      <span className="row-meta">
                        <KeyBadge info={info[identity.id]} />
                      </span>
                      <span className="row-tools">
                        {uses > 0 && (
                          <span className="badge" title="Hosts signing in with this key">
                            {uses} host{uses === 1 ? '' : 's'}
                          </span>
                        )}
                        <button
                          className="btn-quiet"
                          onClick={() => {
                            setDraft(identity)
                            setSecret('')
                            setDraftInfo(info[identity.id])
                          }}
                        >
                          <PencilSimpleIcon />
                          Edit
                        </button>
                        <button className="btn-quiet" onClick={() => void remove(identity)}>
                          <TrashIcon />
                          Delete
                        </button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}

        <h3 className="section-title">{draft.id ? `Edit ${draft.name}` : 'Add a key'}</h3>

        <form onSubmit={submit}>
          <label>
            Private key file
            <span className="file-row">
              <input
                readOnly
                value={draft.privateKeyPath}
                placeholder="~/.ssh/id_ed25519"
                onClick={() => void pickKey()}
              />
              <button type="button" onClick={() => void pickKey()}>
                <FolderOpenIcon />
                Choose…
              </button>
            </span>
            {draftInfo && <KeyBadge info={draftInfo} />}
          </label>

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
              Passphrase
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={
                  draft.hasSecret ? '••• saved, type to replace' : 'only if the key has one'
                }
                autoComplete="off"
              />
            </label>
          </div>

          <p className="hint">
            Passphrases go straight into the OS keychain. No API reads them back out to the UI.
          </p>

          {error && <p className="error">{error}</p>}

          <footer className="modal-foot">
            <button type="button" onClick={reset}>
              <ArrowCounterClockwiseIcon />
              Reset form
            </button>
            <button type="submit" className="btn-primary">
              {draft.id ? <CheckIcon /> : <PlusIcon />}
              {draft.id ? 'Update' : 'Add'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
