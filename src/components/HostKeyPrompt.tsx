import { KeyIcon, ShieldWarningIcon } from '@phosphor-icons/react'

import { vaultApi } from '../lib/ipc'
import { useWorkspace } from '../state/useWorkspace'

/**
 * No accept-any: the user must look at the fingerprint and decide for themselves.
 * A *changed* key is shown with more emphasis since it's a sign of a possible MITM attack.
 */
export function HostKeyPrompt() {
  const { hostKeyPrompt, dismissHostKeyPrompt, openSsh } = useWorkspace()
  if (!hostKeyPrompt) return null

  const { host, port, algo, fingerprint, previous, kind, hostId } = hostKeyPrompt
  const mismatch = kind === 'mismatch'

  const trust = async () => {
    await vaultApi.trustHostKey(host, port, algo, fingerprint)
    dismissHostKeyPrompt()
    await openSsh(hostId)
  }

  return (
    <div className="modal-backdrop">
      <div className={`modal ${mismatch ? 'is-danger' : ''}`}>
        <h2>
          {mismatch ? <ShieldWarningIcon color="var(--danger)" /> : <KeyIcon />}
          {mismatch ? 'Host key has CHANGED' : 'Host key not yet trusted'}
        </h2>

        <p>
          {host}:{port}
        </p>

        {mismatch ? (
          <>
            <p className="error">
              The previous key differs from the key the server just presented. The server may
              have been reinstalled, or someone could be intercepting the connection. Only trust
              this if you are certain why the key changed.
            </p>
            <dl className="fingerprint">
              <dt>Saved</dt>
              <dd>
                <code>{previous}</code>
              </dd>
              <dt>Current server</dt>
              <dd>
                <code>{fingerprint}</code>
              </dd>
            </dl>
          </>
        ) : (
          <dl className="fingerprint">
            <dt>Algorithm</dt>
            <dd>
              <code>{algo}</code>
            </dd>
            <dt>Fingerprint</dt>
            <dd>
              <code>{fingerprint}</code>
            </dd>
          </dl>
        )}

        <p className="hint">
          Compare this against the output of <code>ssh-keyscan -t {algo} {host}</code> run from
          a network path you trust.
        </p>

        <footer className="modal-foot">
          <button onClick={dismissHostKeyPrompt}>Cancel connection</button>
          <button
            className={mismatch ? 'btn-danger' : 'btn-primary'}
            onClick={() => void trust()}
          >
            {mismatch ? 'I understand the risk, trust the new key' : 'Trust and connect'}
          </button>
        </footer>
      </div>
    </div>
  )
}
