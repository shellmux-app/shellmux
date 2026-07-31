import { useEffect, useRef, useState } from 'react'
import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { attachWriter } from '../lib/bus'
import { sessionApi } from '../lib/ipc'
import { themeById } from '../lib/themes'
import { applyToLineBuffer, mayRecordInHistory } from '../lib/lineBuffer'
import { useHistory } from '../state/useHistory'
import { HistorySearch } from './HistorySearch'

interface Props {
  sessionId: string
  themeId: string | null
  focused: boolean
  closedReason: string | null
  onReconnect: (cols: number, rows: number) => void
}

const FONT_STACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
const FONT_SIZE = 13
const SCROLLBACK = 20000

export function TerminalView({
  sessionId,
  themeId,
  focused,
  closedReason,
  onReconnect,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [historySearch, setHistorySearch] = useState<{ initialQuery: string } | null>(null)
  const recordHistory = useHistory((s) => s.record)

  // Ref instead of dependency: the terminal is only built once per session, and
  // the onData handler must always see the latest state without being recreated.
  const closedRef = useRef<boolean>(false)
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect
  closedRef.current = closedReason !== null

  // See `lib/lineBuffer.ts` for what this tracks and its known limitation.
  const lineBufferRef = useRef('')

  useEffect(() => {
    const container = hostRef.current
    if (!container) return

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: FONT_STACK,
      fontSize: FONT_SIZE,
      lineHeight: 1.2,
      scrollback: SCROLLBACK,
      theme: themeById(themeId),
      macOptionIsMeta: true,
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon())

    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(container)

    // WebGL is much faster but isn't available on every WebView — fall back
    // silently to the canvas renderer instead of breaking the terminal.
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* use the default renderer */
    }

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const trackLineBuffer = (data: string) => {
      const result = applyToLineBuffer(lineBufferRef.current, data)
      if (result.kind === 'submit') {
        // Only remember it if the terminal actually displayed it — see
        // `mayRecordInHistory` for why this keeps passwords out of history.
        const buf = term.buffer.active
        const visibleLine = buf.getLine(buf.cursorY)?.translateToString(true) ?? ''
        if (mayRecordInHistory(result.command, visibleLine)) recordHistory(result.command)
        lineBufferRef.current = ''
      } else {
        lineBufferRef.current = result.buffer
      }
    }

    const encoder = new TextEncoder()
    const dataSub = term.onData((data) => {
      // Once the session has died, any keypress means "reconnect" rather than
      // input — similar to how Tabby prompts a reconnect.
      if (closedRef.current) {
        onReconnectRef.current(term.cols, term.rows)
        return
      }
      trackLineBuffer(data)
      void sessionApi.write(sessionId, encoder.encode(data))
    })
    const binarySub = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff
      void sessionApi.write(sessionId, bytes)
    })

    // Must go through xterm's own hook, not a window listener: xterm handles
    // keydown on its hidden textarea and calls preventDefault +
    // stopPropagation, so a window-level listener never sees Ctrl+R — and by
    // then xterm has already sent \x12 to the remote, putting the *server's*
    // shell into reverse-search instead of opening this overlay. Returning
    // false here swallows the key before either happens.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.metaKey || e.altKey) return true
      if (e.key === 'r') {
        setHistorySearch({ initialQuery: lineBufferRef.current })
        return false
      }
      if (e.key === 'f') {
        setSearchOpen(true)
        return false
      }
      return true
    })

    const detach = attachWriter(sessionId, (bytes) => term.write(bytes))

    const syncSize = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      void sessionApi.resize(sessionId, term.cols, term.rows)
    }

    // Wait for layout to settle before the first fit, otherwise cols/rows get computed against a 0px frame.
    const raf = requestAnimationFrame(syncSize)
    const observer = new ResizeObserver(syncSize)
    observer.observe(container)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      detach()
      dataSub.dispose()
      binarySub.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [sessionId, themeId])

  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  useEffect(() => {
    if (!closedReason) return
    termRef.current?.write(
      `\r\n\x1b[38;5;244m[ session closed: ${closedReason}. ` +
        `Press any key to reconnect ]\x1b[0m\r\n`,
    )
  }, [closedReason])

  // Ctrl+F / Ctrl+R are handled inside xterm (see attachCustomKeyEventHandler
  // above). This covers the two cases that never reach it: Cmd+F, which macOS
  // delivers with no `key` for xterm to cancel, and Escape while the search
  // bar has focus rather than the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'f' && focused) {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false)
        searchRef.current?.clearDecorations()
        termRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, searchOpen])

  /** Erases whatever's on the current line (as far as `lineBufferRef` knows
   * about it) and types `command` in its place — mirrors bash's own Ctrl+R:
   * puts the command on the line, doesn't press Enter for you. */
  const applyHistorySelection = (command: string) => {
    const backspaces = '\x7f'.repeat(lineBufferRef.current.length)
    const encoder = new TextEncoder()
    void sessionApi.write(sessionId, encoder.encode(backspaces + command))
    lineBufferRef.current = command
    termRef.current?.focus()
  }

  return (
    <div className="term-wrap">
      {historySearch && (
        <HistorySearch
          initialQuery={historySearch.initialQuery}
          onSelect={applyHistorySelection}
          onClose={() => {
            setHistorySearch(null)
            termRef.current?.focus()
          }}
        />
      )}
      {searchOpen && (
        <form
          className="term-search"
          onSubmit={(e) => {
            e.preventDefault()
            searchRef.current?.findNext(query)
          }}
        >
          <input
            autoFocus
            value={query}
            placeholder="Search in buffer"
            aria-label="Search term for buffer"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="btn-outline"
            aria-label="Previous result"
            title="Previous result"
            onClick={() => searchRef.current?.findPrevious(query)}
          >
            <CaretUpIcon />
          </button>
          <button type="submit" className="btn-outline" aria-label="Next result" title="Next result">
            <CaretDownIcon />
          </button>
          <button
            type="button"
            className="btn-quiet"
            aria-label="Close search"
            title="Close search"
            onClick={() => setSearchOpen(false)}
          >
            <XIcon />
          </button>
        </form>
      )}
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
