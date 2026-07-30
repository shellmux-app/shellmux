import { useState } from 'react'

import { sessionApi } from '../../lib/ipc'
import type { Snippet } from '../../lib/types'
import { describe, useVault } from '../../state/useVault'
import { useWorkspace } from '../../state/useWorkspace'

const EMPTY: Snippet = { id: '', name: '', body: '', groupId: null, sendNewline: true }

export function SnippetsScreen() {
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
    <div className="screen">
      <div className="screen-body">
        <h2 className="section-title">Snippets</h2>

        <label className="inline">
          <input
            type="checkbox"
            checked={broadcast}
            onChange={(e) => setBroadcast(e.target.checked)}
          />
          Broadcast: gửi tới mọi session đang mở thay vì chỉ pane đang focus
        </label>

        <ul className="rows">
          {snippets.map((snippet) => (
            <li key={snippet.id}>
              <span className="row-name">{snippet.name}</span>
              <code className="row-meta">{snippet.body.split('\n')[0]}</code>
              <span className="row-tools">
                <button className="btn-primary" onClick={() => void run(snippet)}>
                  Run
                </button>
                <button className="btn-quiet" onClick={() => setDraft(snippet)}>Sửa</button>
                <button className="btn-quiet" onClick={() => void deleteSnippet(snippet.id)}>Xoá</button>
              </span>
            </li>
          ))}
          {snippets.length === 0 && <li className="placeholder"><strong>Chưa có snippet</strong><p>Lưu những lệnh bạn gõ lại nhiều lần để gửi nhanh sau này.</p></li>}
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
            <button type="submit" className="btn-primary">
              {draft.id ? 'Cập nhật' : 'Thêm'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
