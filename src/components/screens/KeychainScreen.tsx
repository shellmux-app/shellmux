import { useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

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
      setError('cần đặt tên cho identity')
      return
    }
    if (draft.authKind === 'privateKey' && !draft.privateKeyPath) {
      setError('chọn file private key')
      return
    }
    try {
      // secret rỗng + identity mới ⇒ gửi undefined để không tạo entry keychain trống.
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
                {identity.privateKeyPath ?? (identity.hasSecret ? 'Secret đã lưu trong keychain' : 'Không cần secret')}
              </span>
              <span className="row-tools">
                <button
                  onClick={() => {
                    setDraft(identity)
                    setSecret('')
                  }}
                 className="btn-quiet">
                  Sửa
                </button>
                <button className="btn-quiet" onClick={() => void deleteIdentity(identity.id)}>Xoá</button>
              </span>
            </li>
          ))}
          {identities.length === 0 && <li className="empty">chưa có identity nào</li>}
        </ul>

        <form onSubmit={submit}>
          <div className="grid-2">
            <label>
              Tên
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="deploy key"
              />
            </label>
            <label>
              Kiểu xác thực
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
              Username (ghi đè của host)
              <input
                value={draft.username ?? ''}
                onChange={(e) => patch({ username: e.target.value || null })}
                placeholder="tuỳ chọn"
              />
            </label>
            {draft.authKind === 'privateKey' && (
              <label>
                Private key
                <span className="file-row">
                  <input readOnly value={draft.privateKeyPath ?? ''} placeholder="~/.ssh/id_ed25519" />
                  <button type="button" onClick={() => void pickKey()}>
                    Chọn…
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
                  placeholder={draft.hasSecret ? '••• đã lưu, nhập để thay' : 'lưu vào keychain'}
                />
              </label>
            )}
          </div>

          <p className="hint">
            Secret đi thẳng vào OS keychain. Không có API nào đọc ngược ra giao diện.
          </p>

          {error && <p className="error">{error}</p>}

          <footer className="modal-foot">
            <button type="button" onClick={reset}>
              Làm mới form
            </button>
            <button type="submit" className="btn-primary">
              {draft.id ? 'Cập nhật' : 'Thêm'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
