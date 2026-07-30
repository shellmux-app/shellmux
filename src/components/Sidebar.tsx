import { useMemo, useState } from 'react'

import { sshConfigApi } from '../lib/ipc'
import type { Group, Host } from '../lib/types'
import { describe, useVault } from '../state/useVault'

interface Props {
  onConnect: (hostId: string) => void
  onEditHost: (host: Host | null) => void
  onManageIdentities: () => void
  onManageSnippets: () => void
  onOpenLocal: () => void
}

function matches(host: Host, needle: string): boolean {
  if (!needle) return true
  const hay = `${host.label} ${host.hostname} ${host.username} ${host.notes ?? ''}`
  return hay.toLowerCase().includes(needle.toLowerCase())
}

export function Sidebar({
  onConnect,
  onEditHost,
  onManageIdentities,
  onManageSnippets,
  onOpenLocal,
}: Props) {
  const { groups, hosts, saveGroup, deleteGroup, deleteHost, load } = useVault()
  const [needle, setNeedle] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)

  /** Import ~/.ssh/config — chạy lại được nhiều lần, host cũ sẽ được cập nhật. */
  const importSshConfig = async () => {
    const path = await sshConfigApi.path().catch(() => null)
    const ok = window.confirm(
      `Import host từ ${path ?? '~/.ssh/config'}?\n\n` +
        'Host đã import trước đó sẽ được cập nhật theo file, không tạo bản sao.',
    )
    if (!ok) return

    setImporting(true)
    try {
      const report = await sshConfigApi.import()
      await load()

      const parts = [`${report.hosts} host`, `${report.identities} key`]
      if (report.jumpsLinked > 0) parts.push(`${report.jumpsLinked} jump host`)
      if (report.unresolvedJumps.length > 0) {
        parts.push(`bỏ qua jump không rõ: ${report.unresolvedJumps.join(', ')}`)
      }
      if (report.includesSkipped > 0) {
        parts.push(`${report.includesSkipped} chỉ thị Include chưa hỗ trợ`)
      }
      if (report.agentForwardIgnored > 0) {
        parts.push(`${report.agentForwardIgnored} host dùng ForwardAgent (chưa hỗ trợ)`)
      }
      setImportNote(parts.join(' · '))
    } catch (e) {
      setImportNote(describe(e))
    } finally {
      setImporting(false)
    }
  }

  const visible = useMemo(() => hosts.filter((h) => matches(h, needle)), [hosts, needle])

  const byGroup = useMemo(() => {
    const map = new Map<string | null, Host[]>()
    visible.forEach((host) => {
      const key = host.groupId
      map.set(key, [...(map.get(key) ?? []), host])
    })
    return map
  }, [visible])

  const childrenOf = (parentId: string | null): Group[] =>
    groups.filter((g) => g.parentId === parentId)

  const addGroup = async (parentId: string | null) => {
    const name = window.prompt('Tên nhóm mới')
    if (!name) return
    await saveGroup({ id: '', parentId, name, sort: 0 })
  }

  const removeGroup = async (group: Group) => {
    const ok = window.confirm(
      `Xoá nhóm "${group.name}"? Host bên trong sẽ chuyển về mục Chưa phân nhóm.`,
    )
    if (ok) await deleteGroup(group.id)
  }

  const removeHost = async (host: Host) => {
    if (window.confirm(`Xoá host "${host.label}"?`)) await deleteHost(host.id)
  }

  const renderHost = (host: Host) => (
    <li key={host.id} className="host-row">
      <button className="host-main" onDoubleClick={() => onConnect(host.id)}>
        {host.colorTag && (
          <span className="host-dot" style={{ background: host.colorTag }} aria-hidden />
        )}
        <span className="host-label">{host.label}</span>
        <span className="host-addr">
          {host.username}@{host.hostname}
          {host.port !== 22 ? `:${host.port}` : ''}
        </span>
      </button>
      <span className="host-tools">
        <button title="Kết nối" onClick={() => onConnect(host.id)}>
          ⏎
        </button>
        <button title="Sửa" onClick={() => onEditHost(host)}>
          ✎
        </button>
        <button title="Xoá" onClick={() => void removeHost(host)}>
          🗑
        </button>
      </span>
    </li>
  )

  const renderGroup = (group: Group, depth: number) => {
    const inner = byGroup.get(group.id) ?? []
    const subGroups = childrenOf(group.id)
    const isCollapsed = collapsed[group.id] ?? false
    const hidden = needle !== '' && inner.length === 0 && subGroups.length === 0

    if (hidden) return null

    return (
      <li key={group.id} className="group" style={{ paddingLeft: depth * 10 }}>
        <div className="group-head">
          <button
            className="group-toggle"
            onClick={() => setCollapsed({ ...collapsed, [group.id]: !isCollapsed })}
          >
            {isCollapsed ? '▸' : '▾'} {group.name}
          </button>
          <span className="group-tools">
            <button title="Thêm nhóm con" onClick={() => void addGroup(group.id)}>
              +
            </button>
            <button title="Xoá nhóm" onClick={() => void removeGroup(group)}>
              🗑
            </button>
          </span>
        </div>
        {!isCollapsed && (
          <ul className="group-body">
            {subGroups.map((child) => renderGroup(child, depth + 1))}
            {inner.map(renderHost)}
          </ul>
        )}
      </li>
    )
  }

  const ungrouped = byGroup.get(null) ?? []

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <input
          className="search"
          placeholder="Tìm host…"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
        />
      </div>

      <div className="sidebar-actions">
        <button onClick={() => onEditHost(null)}>+ Host</button>
        <button onClick={() => void addGroup(null)}>+ Nhóm</button>
        <button onClick={onOpenLocal}>Local shell</button>
      </div>

      <ul className="tree">
        {childrenOf(null).map((group) => renderGroup(group, 0))}
        {ungrouped.length > 0 && (
          <li className="group">
            <div className="group-head">
              <span className="group-toggle">Chưa phân nhóm</span>
            </div>
            <ul className="group-body">{ungrouped.map(renderHost)}</ul>
          </li>
        )}
        {hosts.length === 0 && (
          <li className="empty">Chưa có host nào — bấm “+ Host” để thêm.</li>
        )}
      </ul>

      {importNote && (
        <p className="import-note" onClick={() => setImportNote(null)}>
          {importNote}
        </p>
      )}

      <div className="sidebar-foot">
        <button onClick={onManageIdentities}>Identities</button>
        <button onClick={onManageSnippets}>Snippets</button>
        <button
          onClick={() => void importSshConfig()}
          disabled={importing}
          title="Nạp host từ ~/.ssh/config"
        >
          {importing ? '…' : 'Import'}
        </button>
      </div>
    </aside>
  )
}
