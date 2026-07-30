export type AuthKind = 'agent' | 'privateKey' | 'password'

export interface Group {
  id: string
  parentId: string | null
  name: string
  sort: number
}

export interface Identity {
  id: string
  name: string
  authKind: AuthKind
  username: string | null
  privateKeyPath: string | null
  hasSecret: boolean
}

export interface Host {
  id: string
  groupId: string | null
  label: string
  hostname: string
  port: number
  username: string
  identityId: string | null
  jumpHostId: string | null
  theme: string | null
  colorTag: string | null
  notes: string | null
  sort: number
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
