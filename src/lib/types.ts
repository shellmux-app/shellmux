/// How a host authenticates. Lives on the host, not on a shared credential:
/// a password belongs to one account on one machine, a key is reused across many.
export type AuthKind = 'agent' | 'password' | 'key'

export interface Group {
  id: string
  parentId: string | null
  name: string
  sort: number
}

/// A reusable private key. Carries no username on purpose — the same key is
/// normally used with different accounts on different hosts.
export interface Identity {
  id: string
  name: string
  privateKeyPath: string
  /** A passphrase for this key is in the OS keychain. Never the value itself. */
  hasSecret: boolean
}

export interface Host {
  id: string
  groupId: string | null
  label: string
  hostname: string
  port: number
  username: string
  authKind: AuthKind
  /** Which saved key to use. Only meaningful when `authKind` is `key`. */
  identityId: string | null
  jumpHostId: string | null
  theme: string | null
  colorTag: string | null
  notes: string | null
  sort: number
  /** Forward this host's own auth (system agent, or this host's own key) to it. */
  agentForward: boolean
}

/// What `inspect_key` made of a file — the app works this out itself rather
/// than asking the user to declare the key type.
export type KeyInfo =
  | ({ kind: 'privateKey' } & PrivateKeyInfo)
  | { kind: 'publicKey'; algorithm: string; comment: string | null; privateKeyGuess: string | null }
  | { kind: 'certificate'; algorithm: string; keyId: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'notAKey'; reason: string }
  | { kind: 'unreadable'; reason: string }

export interface PrivateKeyInfo {
  /** Ready to display: `Ed25519`, `RSA 4096`, `ECDSA P-256`. */
  label: string
  /** Stable and lowercase, for grouping and icons — not for display. */
  algorithmId: string
  bits: number | null
  /** OpenSSH's own format, e.g. `SHA256:Ll1t…`. */
  fingerprint: string | null
  comment: string | null
  encrypted: boolean
  format: string
  warning: string | null
}

export interface Snippet {
  id: string
  name: string
  body: string
  groupId: string | null
  sendNewline: boolean
}

export type TunnelKind = 'local' | 'remote' | 'dynamic'

export interface TunnelSpec {
  id: string
  hostId: string
  name: string
  kind: TunnelKind
  bindAddr: string
  bindPort: number
  targetHost: string
  targetPort: number
  autoStart: boolean
}

export interface KnownHost {
  host: string
  port: number
  algo: string
  fingerprint: string
  addedAt: number
}

export type SessionKind = 'ssh' | 'local'

export interface SessionInfo {
  id: string
  kind: SessionKind
  hostId: string | null
  label: string
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number
  permissions: number | null
  modified: number | null
  user: string | null
  group: string | null
}

/// Error from Rust: `kind` tells the UI which modal to show instead of just printing text.
export type IpcErrorKind = 'hostKeyUnknown' | 'hostKeyMismatch' | 'auth' | 'generic'

export interface HostKeyUnknownData {
  host: string
  port: number
  fingerprint: string
  algo: string
}

export interface HostKeyMismatchData {
  host: string
  port: number
  expected: string
  actual: string
}

export interface IpcError {
  message: string
  kind: IpcErrorKind
  data: HostKeyUnknownData | HostKeyMismatchData | null
}

export function isIpcError(e: unknown): e is IpcError {
  return typeof e === 'object' && e !== null && 'message' in e && 'kind' in e
}
