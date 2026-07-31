import { useEffect, useMemo, useRef, useState } from 'react'
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react'

import { type FuzzyMatch, fuzzyFilter } from '../lib/fuzzy'
import { useHistory } from '../state/useHistory'

interface Props {
  /** Pre-fills the search with whatever's already typed on the current line
   * — this is what makes Ctrl+Space feel like "autocomplete" rather than a
   * separate history browser: it opens already filtered to what you typed. */
  initialQuery: string
  onSelect: (command: string) => void
  onClose: () => void
}

function highlighted(match: FuzzyMatch) {
  if (match.positions.length === 0) return match.text
  const marked = new Set(match.positions)
  return match.text.split('').map((char, i) =>
    marked.has(i) ? (
      <mark key={i}>{char}</mark>
    ) : (
      <span key={i}>{char}</span>
    ),
  )
}

/**
 * Ctrl+R / Ctrl+Space overlay: fuzzy-searches command history (see
 * `useHistory`) and types the chosen command onto the terminal's current
 * line — same as bash's own Ctrl+R, it doesn't press Enter for you.
 */
export function HistorySearch({ initialQuery, onSelect, onClose }: Props) {
  const entries = useHistory((s) => s.entries)
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const results = useMemo(() => {
    // Most-recent-first browsing order; fuzzyFilter re-ranks once there's a query.
    const mostRecentFirst = [...entries].reverse()
    return fuzzyFilter(query, mostRecentFirst, 50)
  }, [entries, query])

  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const pick = (text: string) => {
    onSelect(text)
    onClose()
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="dialog history-search"
        role="dialog"
        aria-modal="true"
        aria-label="Command history search"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSelected((s) => Math.min(s + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSelected((s) => Math.max(s - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (results[selected]) pick(results[selected].text)
          }
        }}
      >
        <label className="field">
          <span className="field-label">
            <ClockCounterClockwiseIcon size={13} /> Command history
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to fuzzy-search…"
            aria-label="Search command history"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <ul className="history-results">
          {results.length === 0 && <li className="history-empty">No matching commands yet</li>}
          {results.map((match, i) => (
            <li
              key={`${match.text}-${i}`}
              className={i === selected ? 'active' : ''}
              onMouseEnter={() => setSelected(i)}
              onClick={() => pick(match.text)}
            >
              {highlighted(match)}
            </li>
          ))}
        </ul>

        <footer className="history-hint">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> navigate
          </span>
          <span>
            <span className="kbd">Enter</span> use
          </span>
          <span>
            <span className="kbd">Esc</span> cancel
          </span>
        </footer>
      </div>
    </div>
  )
}
