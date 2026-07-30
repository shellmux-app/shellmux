import { useState } from 'react'

import { sessionApi } from '../lib/ipc'
import type { Snippet } from '../lib/types'
import { describe, useVault } from '../state/useVault'
import { useWorkspace } from '../state/useWorkspace'

interface Props {
  onClose: () => void
}

const EMPTY: Snippet = { id: '', name: '', body: '', groupId: null, sendNewline: true }

export function SnippetDialog({ onClose }: Props) {
  const { snippets, saveSnippet, deleteSnippet } = useVault()
  const { broadcast, setBroadcast, activeSessionIds } = useWorkspace()
  const [draft, setDraft] = useState<Snippet>(EMPTY)
  const [status, setStatus] = useState<string | null>(null)

  const patch = (next: Partial<Snippet>) => setDraft({ ...draft, ...next })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.name.trim() || !draft.body.trim()) {
      setStatus('cần cả tên và nội dung')
      return
    }
    try {
      await saveSnippet(draft)
      setDraft(EMPTY)
      setStatus(null)
    } catch (err) {
      setStatus(describe(err))
    }
  }

  const run = async (snippet: Snippet) => {
    const targets = activeSessionIds()
    if (targets.length === 0) {
      setStatus('không có session nào đang mở')
      return
    }
    try {
      const sent = await sessionApi.sendSnippet(targets, snippet.id)
      setStatus(`đã gửi tới ${sent}/${targets.length} session`)
    } catch (err) {
      setStatus(describe(err))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Snippets</h2>

        <label className="inline">
          <input
            type="checkbox"
            checked={broadcast}
            onChange={(e) => setBroadcast(e.target.checked)}
          />
          Broadcast — gửi tới mọi session đang mở thay vì chỉ pane đang focus
        </label>

        <ul className="snippet-list">
          {snippets.map((snippet) => (
            <li key={snippet.id}>
              <span className="snippet-name">{snippet.name}</span>
              <code className="snippet-body">{snippet.body.split('\n')[0]}</code>
              <span className="snippet-tools">
                <button className="primary" onClick={() => void run(snippet)}>
                  Run
                </button>
                <button onClick={() => setDraft(snippet)}>✎</button>
                <button onClick={() => void deleteSnippet(snippet.id)}>🗑</button>
              </span>
            </li>
          ))}
          {snippets.length === 0 && <li className="empty">chưa có snippet nào</li>}
        </ul>

        <form onSubmit={submit}>
          <label>
            Tên
            <input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="restart nginx"
            />
          </label>
          <label>
            Nội dung
            <textarea
              rows={4}
              value={draft.body}
              onChange={(e) => patch({ body: e.target.value })}
              placeholder="sudo systemctl restart nginx"
            />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={draft.sendNewline}
              onChange={(e) => patch({ sendNewline: e.target.checked })}
            />
            Tự thêm Enter ở cuối
          </label>

          {status && <p className="hint">{status}</p>}

          <footer className="modal-foot">
            <button type="button" onClick={onClose}>
              Đóng
            </button>
            <button type="submit" className="primary">
              {draft.id ? 'Cập nhật' : 'Thêm'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
