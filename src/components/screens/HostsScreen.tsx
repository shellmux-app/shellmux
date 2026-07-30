import { useMemo, useState } from 'react'

import { badgeColor, badgeText } from '../../lib/badge'
import type { Group, Host } from '../../lib/types'
import { useDialog } from '../../state/useDialog'
import { useVault } from '../../state/useVault'

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
 * Màn Hosts theo bố cục Termius: ô tìm kiếm có nút Connect, rồi hai lưới card
 * Groups và Hosts. Chọn một group là lọc xuống group đó thay vì mở cây lồng nhau
 * — với vài trăm host thì lọc nhanh hơn là bấm mở từng nhánh.
 */
export function HostsScreen({ onConnect, onEditHost, onOpenLocal }: Props) {
  const { groups, hosts, saveGroup, deleteGroup, deleteHost } = useVault()
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

  /** Enter trong ô tìm kiếm: nối luôn nếu chỉ còn đúng một kết quả. */
  const connectFirst = () => {
    if (visible.length > 0) onConnect(visible[0].id)
  }

  const addGroup = async () => {
    const name = await ask({
      title: 'Nhóm mới',
      label: 'Tên nhóm',
      placeholder: 'Production',
      confirmLabel: 'Tạo nhóm',
    })
    if (name) await saveGroup({ id: '', parentId: null, name, sort: 0 })
  }

  const removeGroup = async (group: Group) => {
    const ok = await confirm({
      title: `Xoá nhóm ${group.name}?`,
      body: 'Host bên trong không bị xoá, chúng chuyển về mục chưa phân nhóm.',
      confirmLabel: 'Xoá nhóm',
      danger: true,
    })
    if (ok) {
      await deleteGroup(group.id)
      if (groupId === group.id) setGroupId(null)
    }
  }

  const removeHost = async (host: Host) => {
    const ok = await confirm({
      title: `Xoá ${host.label}?`,
      body: `Xoá cấu hình kết nối tới ${host.username}@${host.hostname}. Máy chủ không bị ảnh hưởng.`,
      confirmLabel: 'Xoá host',
      danger: true,
    })
    if (ok) await deleteHost(host.id)
  }

  return (
    <div className="screen">
      <div className="screen-bar">
        <div className="screen-search">
          <input
            value={needle}
            placeholder="Tìm host, IP hoặc user"
            aria-label="Tìm host"
            onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') connectFirst()
              if (e.key === 'Escape') setNeedle('')
            }}
          />
          <button
            className="btn-primary"
            onClick={connectFirst}
            disabled={visible.length === 0}
          >
            Connect
          </button>
        </div>

        <button className="btn-outline" onClick={() => onEditHost(null)}>
          Host mới
        </button>
        <button className="btn-outline" onClick={() => void addGroup()}>
          Nhóm mới
        </button>
        <button className="btn-outline" onClick={onOpenLocal}>
          Shell local
        </button>
      </div>

      <div className="screen-body">
        {currentGroup && (
          <div className="crumb">
            <button className="btn-quiet" onClick={() => setGroupId(null)}>
              Tất cả host
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
                  <button className="card-text" onClick={() => setGroupId(group.id)}>
                    <span className="card-title">{group.name}</span>
                    <span className="card-sub">
                      {count} host{count === 1 ? '' : 's'}
                    </span>
                  </button>
                  <span className="card-actions">
                    <button className="btn-quiet" onClick={() => void removeGroup(group)}>
                      Xoá
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <h2 className="section-title">
          {currentGroup ? `Hosts trong ${currentGroup.name}` : 'Hosts'}
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
                  title={`Kết nối tới ${host.username}@${host.hostname}`}
                >
                  <span className="card-title">{host.label}</span>
                  <span className="card-sub">
                    ssh, {host.username}
                    {host.jumpHostId ? ', qua jump host' : ''}
                  </span>
                </button>
                <span className="card-actions">
                  <button className="btn-quiet" onClick={() => onEditHost(host)}>
                    Sửa
                  </button>
                  <button className="btn-quiet" onClick={() => void removeHost(host)}>
                    Xoá
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : hosts.length === 0 ? (
          <div className="placeholder">
            <strong>Chưa có host nào</strong>
            <p>
              Thêm thủ công, hoặc nạp sẵn toàn bộ host bạn đã cấu hình trong
              <code> ~/.ssh/config</code> bằng mục Import ở cột bên trái.
            </p>
            <button className="btn-primary" onClick={() => onEditHost(null)}>
              Thêm host đầu tiên
            </button>
          </div>
        ) : (
          <div className="placeholder">
            <strong>Không khớp host nào</strong>
            <p>Thử từ khoá khác, hoặc xoá ô tìm kiếm để xem lại tất cả.</p>
          </div>
        )}
      </div>
    </div>
  )
}
