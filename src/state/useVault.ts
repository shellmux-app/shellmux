import { create } from 'zustand'

import { vaultApi } from '../lib/ipc'
import type { Group, Host, Identity, KnownHost, Snippet, TunnelSpec } from '../lib/types'

/** Replace/insert one item and return a new array — never mutate the old one. */
function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id)
  if (index === -1) return [...list, item]
  return [...list.slice(0, index), item, ...list.slice(index + 1)]
}

function without<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((entry) => entry.id !== id)
}

interface VaultState {
  groups: Group[]
  hosts: Host[]
  identities: Identity[]
  snippets: Snippet[]
  tunnels: TunnelSpec[]
  knownHosts: KnownHost[]
  ready: boolean
  error: string | null

  load: () => Promise<void>
  saveGroup: (group: Group) => Promise<Group>
  deleteGroup: (id: string) => Promise<void>
  saveHost: (host: Host, password?: string) => Promise<Host>
  deleteHost: (id: string) => Promise<void>
  saveIdentity: (identity: Identity, secret?: string) => Promise<Identity>
  deleteIdentity: (id: string) => Promise<void>
  saveSnippet: (snippet: Snippet) => Promise<Snippet>
  deleteSnippet: (id: string) => Promise<void>
  saveTunnel: (tunnel: TunnelSpec) => Promise<TunnelSpec>
  deleteTunnel: (id: string) => Promise<void>
  forgetKnownHost: (host: string, port: number) => Promise<void>
  dismissError: () => void
}

export const useVault = create<VaultState>((set, get) => ({
  groups: [],
  hosts: [],
  identities: [],
  snippets: [],
  tunnels: [],
  knownHosts: [],
  ready: false,
  error: null,

  load: async () => {
    try {
      const [groups, hosts, identities, snippets, tunnels, knownHosts] = await Promise.all([
        vaultApi.listGroups(),
        vaultApi.listHosts(),
        vaultApi.listIdentities(),
        vaultApi.listSnippets(),
        vaultApi.listTunnels(),
        vaultApi.listKnownHosts(),
      ])
      set({ groups, hosts, identities, snippets, tunnels, knownHosts, ready: true, error: null })
    } catch (e) {
      set({ ready: true, error: describe(e) })
    }
  },

  saveGroup: async (group) => {
    const saved = await vaultApi.saveGroup(group)
    set({ groups: upsert(get().groups, saved) })
    return saved
  },

  deleteGroup: async (id) => {
    await vaultApi.deleteGroup(id)
    // SQLite sets group_id to NULL for hosts in the deleted group, so mirror that here.
    set({
      groups: without(get().groups, id),
      hosts: get().hosts.map((h) => (h.groupId === id ? { ...h, groupId: null } : h)),
    })
  },

  saveHost: async (host, password) => {
    const saved = await vaultApi.saveHost(host, password)
    set({ hosts: upsert(get().hosts, saved) })
    return saved
  },

  deleteHost: async (id) => {
    await vaultApi.deleteHost(id)
    set({ hosts: without(get().hosts, id) })
  },

  saveIdentity: async (identity, secret) => {
    const saved = await vaultApi.saveIdentity(identity, secret)
    set({ identities: upsert(get().identities, saved) })
    return saved
  },

  deleteIdentity: async (id) => {
    await vaultApi.deleteIdentity(id)
    set({
      identities: without(get().identities, id),
      hosts: get().hosts.map((h) => (h.identityId === id ? { ...h, identityId: null } : h)),
    })
  },

  saveSnippet: async (snippet) => {
    const saved = await vaultApi.saveSnippet(snippet)
    set({ snippets: upsert(get().snippets, saved) })
    return saved
  },

  deleteSnippet: async (id) => {
    await vaultApi.deleteSnippet(id)
    set({ snippets: without(get().snippets, id) })
  },

  saveTunnel: async (tunnel) => {
    const saved = await vaultApi.saveTunnel(tunnel)
    set({ tunnels: upsert(get().tunnels, saved) })
    return saved
  },

  deleteTunnel: async (id) => {
    await vaultApi.deleteTunnel(id)
    set({ tunnels: without(get().tunnels, id) })
  },

  forgetKnownHost: async (host, port) => {
    await vaultApi.forgetHostKey(host, port)
    set({
      knownHosts: get().knownHosts.filter((k) => !(k.host === host && k.port === port)),
    })
  },

  dismissError: () => set({ error: null }),
}))

export function describe(e: unknown): string {
  if (typeof e === 'string') return e
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message)
  }
  return 'Unknown error'
}
