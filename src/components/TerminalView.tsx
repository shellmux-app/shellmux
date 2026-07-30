import { useEffect, useRef, useState } from 'react'
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

  // Ref thay vì dependency: terminal chỉ được dựng một lần cho mỗi session, và
  // handler onData phải luôn thấy trạng thái mới nhất mà không phải tạo lại.
  const closedRef = useRef<boolean>(false)
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect
  closedRef.current = closedReason !== null

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

    // WebGL nhanh hơn nhiều nhưng không có trên mọi WebView — fallback im lặng
    // về canvas renderer thay vì làm chết terminal.
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* dùng renderer mặc định */
    }

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const encoder = new TextEncoder()
    const dataSub = term.onData((data) => {
      // Khi session đã chết, phím bất kỳ nghĩa là "kết nối lại" chứ không phải
      // input — giống cách Tabby mời reconnect.
      if (closedRef.current) {
        onReconnectRef.current(term.cols, term.rows)
        return
      }
      void sessionApi.write(sessionId, encoder.encode(data))
    })
    const binarySub = term.onBinary((data) => {
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff
      void sessionApi.write(sessionId, bytes)
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

    // Chờ layout xong mới fit lần đầu, nếu không cols/rows tính trên khung 0px.
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
      `\r\n\x1b[38;5;244m[ session đã đóng: ${closedReason}. ` +
        `Nhấn phím bất kỳ để kết nối lại ]\x1b[0m\r\n`,
    )
  }, [closedReason])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && focused) {
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

  return (
    <div className="term-wrap">
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
            placeholder="Tìm trong buffer"
            aria-label="Từ khoá tìm trong buffer"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="btn-outline"
            aria-label="Kết quả trước"
            onClick={() => searchRef.current?.findPrevious(query)}
          >
            Trước
          </button>
          <button type="submit" className="btn-outline">
            Tiếp
          </button>
          <button
            type="button"
            className="btn-quiet"
            aria-label="Đóng tìm kiếm"
            onClick={() => setSearchOpen(false)}
          >
            Đóng
          </button>
        </form>
      )}
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
