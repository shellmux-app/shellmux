import {
  CertificateIcon,
  KeyIcon,
  LockIcon,
  UsbIcon,
  WarningIcon,
} from '@phosphor-icons/react'

import type { KeyInfo } from '../../lib/types'

/**
 * Renders whatever `inspect_key` worked out about a file. The point is that the
 * user never types any of this: the type, size and fingerprint come from the
 * key itself, and the cases that aren't a usable private key say which file to
 * pick instead rather than failing later with "server rejected key".
 */

interface Props {
  info: KeyInfo | undefined
  /** Compact drops the fingerprint, for tight rows. */
  compact?: boolean
}

/** FIDO2/hardware keys get their own icon — they behave differently enough. */
function iconFor(algorithmId: string) {
  if (algorithmId.startsWith('sk-')) return UsbIcon
  return KeyIcon
}

export function KeyBadge({ info, compact = false }: Props) {
  if (!info) {
    return <span className="key-badge is-muted">Checking…</span>
  }

  switch (info.kind) {
    case 'privateKey': {
      const Icon = iconFor(info.algorithmId)
      return (
        <span className="key-badge">
          <span className="key-badge-type">
            <Icon size={13} />
            {info.label}
          </span>
          {info.encrypted && (
            <span className="key-badge-flag" title="Needs a passphrase to unlock">
              <LockIcon size={12} />
              Passphrase
            </span>
          )}
          {!compact && info.fingerprint && (
            <code className="key-badge-fp" title={info.fingerprint}>
              {info.fingerprint}
            </code>
          )}
          {info.comment && <span className="key-badge-comment">{info.comment}</span>}
          {info.warning && (
            <span className="key-badge-flag is-warn" title={info.warning}>
              <WarningIcon size={12} />
              {compact ? 'Warning' : info.warning}
            </span>
          )}
        </span>
      )
    }

    case 'publicKey':
      return (
        <span className="key-badge is-error">
          <WarningIcon size={13} />
          This is the public key. Pick{' '}
          <code>{info.privateKeyGuess ?? 'the private key'}</code> instead.
        </span>
      )

    case 'certificate':
      return (
        <span className="key-badge is-error">
          <CertificateIcon size={13} />
          This is a certificate ({info.algorithm}). Pick the private key it was issued for.
        </span>
      )

    case 'unsupported':
    case 'notAKey':
    case 'unreadable':
      return (
        <span className="key-badge is-error" title={info.reason}>
          <WarningIcon size={13} />
          {info.reason}
        </span>
      )
  }
}
