import { useMemo, useState } from 'react'
import {
  CircleNotchIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlugIcon,
  PlusIcon,
  TerminalIcon,
  TrashIcon,
} from '@phosphor-icons/react'

import { badgeColor, badgeText } from '../../lib/badge'
import type { Group, Host } from '../../lib/types'
import { useDialog } from '../../state/useDialog'
import { useVault } from '../../state/useVault'
import { useWorkspace } from '../../state/useWorkspace'

interface Props {
  onConnect: (hostId: string) => void
  onEditHost: (host: Host | null) => void
  onOpenLocal: () => void
}

function matches(host: Host, needle: string): boolean {
  if (!needle) return true
  const hay = `${host.label} ${host.hostname} ${host.username} ${host.notes ?? ''}`
  return hay.toLowerCase().includes(needle.toLowerCase())
}

/**
 * Hosts screen laid out like Termius: a search box with a Connect button, then
 * two card grids for Groups and Hosts. Selecting a group filters down to that
 * group instead of opening a nested tree — with a few hundred hosts, filtering
 * is faster than expanding branch by branch.
 */
export function HostsScreen({ onConnect, onEditHost, onOpenLocal }: Props) {
  const { groups, hosts, saveGroup, deleteGroup, deleteHost } = useVault()
  const connectingHostId = useWorkspace((s) => s.connectingHostId)
  const { ask, confirm } = useDialog()
  const [needle, setNeedle] = useState('')
  const [groupId, setGroupId] = useState<string | null>(null)

  const currentGroup = groups.find((g) => g.id === groupId) ?? null

  const visible = useMemo(() => {
    const scoped = groupId === null ? hosts : hosts.filter((h) => h.groupId === groupId)
    return scoped.filter((h) => matches(h, needle))
  }, [hosts, groupId, needle])

  const groupCards = useMemo(() => {
    if (groupId !== null || needle !== '') return []
    return groups
      .filter((g) => g.parentId === null)
      .map((group) => ({
        group,
        count: hosts.filter((h) => h.groupId === group.id).length,
      }))
  }, [groups, hosts, groupId, needle])

  /** Enter in the search box: connect immediately if exactly one result remains. */
  const connectFirst = () => {
    if (visible.length > 0) onConnect(visible[0].id)
  }

  const addGroup = async () => {
    const name = await ask({
      title: 'New group',
      label: 'Group name',
      placeholder: 'Production',
      confirmLabel: 'Create group',
    })
    if (name) await saveGroup({ id: '', parentId: null, name, sort: 0 })
  }

  const removeGroup = async (group: Group) => {
    const ok = await confirm({
      title: `Delete group ${group.name}?`,
      body: 'Hosts inside it are not deleted; they move to the ungrouped section.',
      confirmLabel: 'Delete group',
      danger: true,
    })
    if (ok) {
      await deleteGroup(group.id)
      if (groupId === group.id) setGroupId(null)
    }
  }

  const removeHost = async (host: Host) => {
    const ok = await confirm({
      title: `Delete ${host.label}?`,
      body: `Delete the connection configuration for ${host.username}@${host.hostname}. The server itself is not affected.`,
      confirmLabel: 'Delete host',
      danger: true,
    })
    if (ok) await deleteHost(host.id)
  }

  return (
    <div className="screen">
      <div className="screen-bar">
        <div className="screen-search">
          <MagnifyingGlassIcon className="screen-search-icon" aria-hidden />
          <input
            value={needle}
            placeholder="Search hosts, IP, or user"
            aria-label="Search hosts"
            onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') connectFirst()
              if (e.key === 'Escape') setNeedle('')
            }}
          />
          <button
            className="btn-primary"
            onClick={connectFirst}
            disabled={visible.length === 0 || connectingHostId !== null}
          >
            {connectingHostId !== null ? (
              <CircleNotchIcon className="spin" />
            ) : (
              <PlugIcon />
            )}
            {connectingHostId !== null ? 'Connecting…' : 'Connect'}
          </button>
        </div>

        <button className="btn-outline" onClick={() => onEditHost(null)}>
          <PlusIcon />
          New host
        </button>
        <button className="btn-outline" onClick={() => void addGroup()}>
          <FolderPlusIcon />
          New group
        </button>
        <button className="btn-outline" onClick={onOpenLocal}>
          <TerminalIcon />
          Local shell
        </button>
      </div>

      <div className="screen-body">
        {currentGroup && (
          <div className="crumb">
            <button className="btn-quiet" onClick={() => setGroupId(null)}>
              All hosts
            </button>
            <span>/</span>
            <strong>{currentGroup.name}</strong>
          </div>
        )}

        {groupCards.length > 0 && (
          <>
            <h2 className="section-title">Groups</h2>
            <div className="card-grid">
              {groupCards.map(({ group, count }) => (
                <div key={group.id} className="card">
                  <span
                    className="badge-square"
                    style={{ '--badge': badgeColor(group.id) } as React.CSSProperties}
                    aria-hidden
                  >
                    {badgeText(group.name)}
                  </span>
                  <button
                    className="card-text"
                    onClick={() => setGroupId(group.id)}
                    title={`View hosts in group ${group.name}`}
                  >
                    <span className="card-title">{group.name}</span>
                    <span className="card-sub">
                      {count} host{count === 1 ? '' : 's'}
                    </span>
                  </button>
                  <span className="card-actions">
                    <button className="btn-quiet" onClick={() => void removeGroup(group)}>
                      <TrashIcon />
                      Delete
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <h2 className="section-title">
          {currentGroup ? `Hosts in ${currentGroup.name}` : 'Hosts'}
        </h2>

        {visible.length > 0 ? (
          <div className="card-grid">
            {visible.map((host) => (
              <div key={host.id} className="card">
                <span
                  className="badge-square"
                  style={
                    { '--badge': host.colorTag ?? badgeColor(host.id) } as React.CSSProperties
                  }
                  aria-hidden
                >
                  {badgeText(host.label)}
                </span>
                <button
                  className="card-text"
                  onClick={() => onConnect(host.id)}
                  disabled={connectingHostId === host.id}
                  title={`Connect to ${host.username}@${host.hostname}`}
                >
                  <span className="card-title">{host.label}</span>
                  <span className="card-sub">
                    {connectingHostId === host.id ? (
                      <>
                        <CircleNotchIcon className="spin" size={11} />
                        Connecting…
                      </>
                    ) : (
                      <>
                        ssh, {host.username}
                        {host.jumpHostId ? ', via jump host' : ''}
                      </>
                    )}
                  </span>
                </button>
                <span className="card-actions">
                  <button className="btn-quiet" onClick={() => onEditHost(host)}>
                    <PencilSimpleIcon />
                    Edit
                  </button>
                  <button className="btn-quiet" onClick={() => void removeHost(host)}>
                    <TrashIcon />
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : hosts.length === 0 ? (
          <div className="placeholder">
            <strong>No hosts yet</strong>
            <p>
              Add one manually, or import every host you've already configured in
              <code> ~/.ssh/config</code> using the Import item in the left column.
            </p>
            <button className="btn-primary" onClick={() => onEditHost(null)}>
              <PlusIcon />
              Add your first host
            </button>
          </div>
        ) : (
          <div className="placeholder">
            <strong>No hosts match</strong>
            <p>Try a different search term, or clear the search box to see all hosts again.</p>
          </div>
        )}
      </div>
    </div>
  )
}
