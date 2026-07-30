import { invoke } from '@tauri-apps/api/core'

import type {
  Group,
  Host,
  Identity,
  KnownHost,
  RemoteEntry,
  SessionInfo,
  Snippet,
  TunnelSpec,
} from './types'

// ------------------------------------------------------------------ base64
// Byte terminal không phải UTF-8 hợp lệ nên IPC truyền base64 hai chiều.

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
  /** `secret` chỉ đi vào keychain; không có API đọc ngược. */
  saveIdentity: (identity: Identity, secret?: string) =>
    invoke<Identity>('save_identity', { identity, secret: secret ?? null }),
  deleteIdentity: (id: string) => invoke<void>('delete_identity', { id }),

  listHosts: () => invoke<Host[]>('list_hosts'),
  saveHost: (host: Host) => invoke<Host>('save_host', { host }),
  deleteHost: (id: string) => invoke<void>('delete_host', { id }),

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
  /** Kết nối lại tại chỗ: giữ nguyên sessionId nên pane không bị dựng lại. */
  reconnect: (sessionId: string, cols: number, rows: number) =>
    invoke<SessionInfo>('session_reconnect', { sessionId, cols, rows }),
  list: () => invoke<SessionInfo[]>('session_list'),
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
  agentForwardIgnored: number
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
  download: (sessionId: string, remote: string, local: string) =>
    invoke<number>('sftp_download', { sessionId, remote, local }),
  upload: (sessionId: string, local: string, remote: string) =>
    invoke<number>('sftp_upload', { sessionId, local, remote }),
}

// ------------------------------------------------------------------- tunnel

export const tunnelApi = {
  start: (sessionId: string, tunnelId: string) =>
    invoke<number>('tunnel_start', { sessionId, tunnelId }),
  stop: (sessionId: string, tunnelId: string) =>
    invoke<void>('tunnel_stop', { sessionId, tunnelId }),
  active: () => invoke<string[]>('tunnel_active'),
}
