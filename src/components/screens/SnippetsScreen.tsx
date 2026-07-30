import { useState } from 'react'
import { CheckIcon, PencilSimpleIcon, PlayIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'

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
      setStatus('name and content are both required')
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
      setStatus('no sessions are currently open')
      return
    }
    try {
      const sent = await sessionApi.sendSnippet(targets, snippet.id)
      setStatus(`sent to ${sent}/${targets.length} sessions`)
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
          Broadcast: send to every open session instead of just the focused pane
        </label>

        <ul className="rows">
          {snippets.map((snippet) => (
            <li key={snippet.id}>
              <span className="row-name">{snippet.name}</span>
              <code className="row-meta">{snippet.body.split('\n')[0]}</code>
              <span className="row-tools">
                <button className="btn-primary" onClick={() => void run(snippet)}>
                  <PlayIcon weight="fill" />
                  Run
                </button>
                <button className="btn-quiet" onClick={() => setDraft(snippet)}>
                  <PencilSimpleIcon />
                  Edit
                </button>
                <button className="btn-quiet" onClick={() => void deleteSnippet(snippet.id)}>
                  <TrashIcon />
                  Delete
                </button>
              </span>
            </li>
          ))}
          {snippets.length === 0 && <li className="placeholder"><strong>No snippets yet</strong><p>Save commands you type repeatedly so you can send them quickly later.</p></li>}
        </ul>

        <form onSubmit={submit}>
          <label>
            Name
            <input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="restart nginx"
            />
          </label>
          <label>
            Content
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
            Automatically add Enter at the end
          </label>

          {status && <p className="hint">{status}</p>}

          <footer className="modal-foot">
            <button type="submit" className="btn-primary">
              {draft.id ? <CheckIcon /> : <PlusIcon />}
              {draft.id ? 'Update' : 'Add'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
