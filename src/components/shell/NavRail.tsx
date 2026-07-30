import {
  DownloadSimpleIcon,
  FingerprintIcon,
  HouseIcon,
  KeyIcon,
  MoonIcon,
  SunIcon,
  TerminalWindowIcon,
  type Icon,
} from '@phosphor-icons/react'

import { useTheme } from '../../state/useTheme'

export type ScreenId = 'hosts' | 'keychain' | 'snippets' | 'knownHosts'

interface Props {
  active: ScreenId
  onSelect: (screen: ScreenId) => void
  counts: Record<ScreenId, number>
  onImport: () => void
}

const ITEMS: { id: ScreenId; label: string; icon: Icon }[] = [
  { id: 'hosts', label: 'Hosts', icon: HouseIcon },
  { id: 'keychain', label: 'Keychain', icon: KeyIcon },
  { id: 'snippets', label: 'Snippets', icon: TerminalWindowIcon },
  { id: 'knownHosts', label: 'Known hosts', icon: FingerprintIcon },
]

/** Termius-style nav rail: each item is a destination, not a dialog. */
export function NavRail({ active, onSelect, counts, onImport }: Props) {
  const { resolved, setMode } = useTheme()
  const ThemeIcon = resolved === 'dark' ? SunIcon : MoonIcon

  return (
    <nav className="rail" aria-label="Main navigation">
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
              <item.icon size={18} />
              {item.label}
              {counts[item.id] > 0 && <span className="rail-count">{counts[item.id]}</span>}
            </button>
          </li>
        ))}
      </ul>

      <div className="rail-foot">
        <button className="rail-item" onClick={onImport}>
          <DownloadSimpleIcon size={18} />
          Import ~/.ssh/config
        </button>
        <button
          className="rail-item"
          onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
        >
          <ThemeIcon size={18} />
          {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
      </div>
    </nav>
  )
}
