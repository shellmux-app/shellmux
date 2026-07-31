import { invoke } from '@tauri-apps/api/core'

import type {
  Group,
  Host,
  Identity,
  KeyInfo,
  KnownHost,
  RemoteEntry,
  SessionInfo,
  Snippet,
  TunnelSpec,
} from './types'

// ------------------------------------------------------------------ base64
// Terminal bytes aren't valid UTF-8, so IPC transfers base64 in both directions.

export function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function decodeBytes(data: string): Uint8Array {
  const binary = atob(data)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

// -------------------------------------------------------------------- vault

export const vaultApi = {
  listGroups: () => invoke<Group[]>('list_groups'),
  saveGroup: (group: Group) => invoke<Group>('save_group', { group }),
  deleteGroup: (id: string) => invoke<void>('delete_group', { id }),

  listIdentities: () => invoke<Identity[]>('list_identities'),
  /** `secret` only ever goes into the keychain; there is no API to read it back. */
  saveIdentity: (identity: Identity, secret?: string) =>
    invoke<Identity>('save_identity', { identity, secret: secret ?? null }),
  deleteIdentity: (id: string) => invoke<void>('delete_identity', { id }),

  listHosts: () => invoke<Host[]>('list_hosts'),
  /**
   * `password` follows the same one-way rule as `secret` above. Omitting it
   * leaves any stored password alone, so editing an unrelated field on a
   * password host doesn't silently clear its credentials.
   */
  saveHost: (host: Host, password?: string) =>
    invoke<Host>('save_host', { host, password: password ?? null }),
  deleteHost: (id: string) => invoke<void>('delete_host', { id }),
  hostHasPassword: (id: string) => invoke<boolean>('host_has_password', { id }),

  listSnippets: () => invoke<Snippet[]>('list_snippets'),
  saveSnippet: (snippet: Snippet) => invoke<Snippet>('save_snippet', { snippet }),
  deleteSnippet: (id: string) => invoke<void>('delete_snippet', { id }),

  listTunnels: () => invoke<TunnelSpec[]>('list_tunnels'),
  saveTunnel: (tunnel: TunnelSpec) => invoke<TunnelSpec>('save_tunnel', { tunnel }),
  deleteTunnel: (id: string) => invoke<void>('delete_tunnel', { id }),

  listKnownHosts: () => invoke<KnownHost[]>('list_known_hosts'),
  getKnownHost: (host: string, port: number) =>
    invoke<KnownHost | null>('get_known_host', { host, port }),
  trustHostKey: (host: string, port: number, algo: string, fingerprint: string) =>
    invoke<void>('trust_host_key', { host, port, algo, fingerprint }),
  forgetHostKey: (host: string, port: number) =>
    invoke<void>('forget_host_key', { host, port }),

  /** Does not include OS-keychain secrets — see `vault/export.rs`. */
  export: (path: string, passphrase: string) =>
    invoke<void>('vault_export', { path, passphrase }),
  import: (path: string, passphrase: string) =>
    invoke<ImportSummary>('vault_import', { path, passphrase }),
}

export interface ImportSummary {
  groups: number
  hosts: number
  identities: number
  snippets: number
  tunnels: number
  knownHosts: number
  /** `host:port` whose pinned key differs from the file's — left untouched. */
  knownHostConflicts: string[]
}

// ---------------------------------------------------------- key inspection

export const keyApi = {
  /** Describes a picked key file. Needs no passphrase and asks for none. */
  inspect: (path: string) => invoke<KeyInfo>('inspect_key', { path }),
  inspectMany: (paths: string[]) => invoke<KeyInfo[]>('inspect_keys', { paths }),
}

// ------------------------------------------------------------------ session

export const sessionApi = {
  connect: (hostId: string, cols: number, rows: number) =>
    invoke<SessionInfo>('ssh_connect', { hostId, cols, rows }),
  openLocal: (cols: number, rows: number, shellPath?: string, cwd?: string) =>
    invoke<SessionInfo>('local_open', {
      cols,
      rows,
      shellPath: shellPath ?? null,
      cwd: cwd ?? null,
    }),
  write: (sessionId: string, bytes: Uint8Array) =>
    invoke<void>('session_write', { sessionId, data: encodeBytes(bytes) }),
  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>('session_resize', { sessionId, cols, rows }),
  close: (sessionId: string) => invoke<void>('session_close', { sessionId }),
  /** Reconnects in place: keeps the same sessionId so the pane isn't rebuilt. */
  reconnect: (sessionId: string, cols: number, rows: number) =>
    invoke<SessionInfo>('session_reconnect', { sessionId, cols, rows }),
  list: () => invoke<SessionInfo[]>('session_list'),
  startLogging: (sessionId: string, path: string) =>
    invoke<void>('session_start_logging', { sessionId, path }),
  stopLogging: (sessionId: string) => invoke<void>('session_stop_logging', { sessionId }),
  sendSnippet: (sessionIds: string[], snippetId: string) =>
    invoke<number>('snippet_send', { sessionIds, snippetId }),
}

// --------------------------------------------------------------------- sftp

// --------------------------------------------------------------- ssh config

export interface ImportReport {
  hosts: number
  identities: number
  jumpsLinked: number
  unresolvedJumps: string[]
  includesSkipped: number
  wildcardBlocks: number
}

export const sshConfigApi = {
  path: () => invoke<string | null>('ssh_config_path'),
  import: (path?: string) =>
    invoke<ImportReport>('import_ssh_config', { path: path ?? null }),
}

export const sftpApi = {
  list: (sessionId: string, path: string) =>
    invoke<RemoteEntry[]>('sftp_list', { sessionId, path }),
  canonicalize: (sessionId: string, path: string) =>
    invoke<string>('sftp_canonicalize', { sessionId, path }),
  mkdir: (sessionId: string, path: string) =>
    invoke<void>('sftp_mkdir', { sessionId, path }),
  rename: (sessionId: string, from: string, to: string) =>
    invoke<void>('sftp_rename', { sessionId, from, to }),
  remove: (sessionId: string, path: string, isDir: boolean) =>
    invoke<void>('sftp_remove', { sessionId, path, isDir }),
  /**
   * Progress arrives separately over the `sftp:transfer` event, keyed by
   * `transferId` — this call's own return/throw is just the final result.
   * `resume: true` continues a same-`transferId` retry from wherever the
   * previous attempt's local/remote file left off, instead of restarting.
   */
  download: (sessionId: string, remote: string, local: string, transferId: string, resume: boolean) =>
    invoke<number>('sftp_download', { sessionId, remote, local, transferId, resume }),
  upload: (sessionId: string, local: string, remote: string, transferId: string, resume: boolean) =>
    invoke<number>('sftp_upload', { sessionId, local, remote, transferId, resume }),
}

/** Progress only — how a transfer *ended* comes from the command's own
 * promise, so there's a single source of truth. See `useTransfers`. */
export interface TransferEvent {
  transferId: string
  bytesDone: number
  bytesTotal: number | null
}

// ------------------------------------------------------------------- tunnel

export const tunnelApi = {
  start: (sessionId: string, tunnelId: string) =>
    invoke<number>('tunnel_start', { sessionId, tunnelId }),
  stop: (sessionId: string, tunnelId: string) =>
    invoke<void>('tunnel_stop', { sessionId, tunnelId }),
  active: () => invoke<string[]>('tunnel_active'),
}
