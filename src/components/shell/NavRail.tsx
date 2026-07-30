import { useTheme } from '../../state/useTheme'

export type ScreenId = 'hosts' | 'keychain' | 'snippets' | 'knownHosts'

interface Props {
  active: ScreenId
  onSelect: (screen: ScreenId) => void
  counts: Record<ScreenId, number>
  onImport: () => void
}

/**
 * Nav rail kiểu Termius: mỗi mục là một đích đến, không phải một dialog. Không
 * dùng icon vẽ tay — nhãn chữ đọc được ngay và không cần thêm dependency.
 */
const ITEMS: { id: ScreenId; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'keychain', label: 'Keychain' },
  { id: 'snippets', label: 'Snippets' },
  { id: 'knownHosts', label: 'Known hosts' },
]

export function NavRail({ active, onSelect, counts, onImport }: Props) {
  const { resolved, setMode } = useTheme()

  return (
    <nav className="rail" aria-label="Điều hướng chính">
      <div className="rail-brand">
        <h1>Shellmux</h1>
        <span className="rail-version">0.1.0</span>
      </div>

      <ul className="rail-nav">
        {ITEMS.map((item) => (
          <li key={item.id}>
            <button
              className={`rail-item ${active === item.id ? 'active' : ''}`}
              aria-current={active === item.id ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
            >
              {item.label}
              {counts[item.id] > 0 && <span className="rail-count">{counts[item.id]}</span>}
            </button>
          </li>
        ))}
      </ul>

      <div className="rail-foot">
        <button className="rail-item" onClick={onImport}>
          Import ~/.ssh/config
        </button>
        <button
          className="rail-item"
          onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
        >
          {resolved === 'dark' ? 'Chủ đề sáng' : 'Chủ đề tối'}
        </button>
      </div>
    </nav>
  )
}
