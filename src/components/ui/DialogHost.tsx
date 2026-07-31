import { useEffect, useRef, useState } from 'react'
import { CheckIcon, TrashIcon, XIcon } from '@phosphor-icons/react'

import { useDialog } from '../../state/useDialog'

/**
 * The single place that renders prompt/confirm. Mounted once in App; every
 * call site just calls `ask()` / `confirm()` and awaits the result.
 *
 * Keyboard: Esc cancels, Enter confirms, the input autofocuses — the things
 * `window.prompt` gives you for free that hand-rolled dialogs usually drop.
 */
export function DialogHost() {
  const { request, resolvePrompt, resolveConfirm } = useDialog()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (request?.kind === 'prompt') {
      setValue(request.value ?? '')
      // Wait one frame for the dialog to mount before focusing and selecting.
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [request])

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (request.kind === 'prompt') resolvePrompt(null)
      else resolveConfirm(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, resolvePrompt, resolveConfirm])

  if (!request) return null

  const cancel = () => {
    if (request.kind === 'prompt') resolvePrompt(null)
    else resolveConfirm(false)
  }

  return (
    <div className="dialog-backdrop" onMouseDown={cancel}>
      <div
        className={`dialog ${request.kind === 'confirm' && request.danger ? 'is-danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="dialog-title">{request.title}</h2>

        {request.kind === 'prompt' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = value.trim()
              if (trimmed.length > 0) resolvePrompt(trimmed)
            }}
          >
            <label className="field">
              <span className="field-label">{request.label}</span>
              <input
                ref={inputRef}
                type={request.masked ? 'password' : 'text'}
                autoComplete="off"
                autoFocus
                value={value}
                placeholder={request.placeholder}
                onChange={(e) => setValue(e.target.value)}
              />
              {request.hint && <span className="field-hint">{request.hint}</span>}
            </label>

            <footer className="dialog-actions">
              <button type="button" onClick={cancel}>
                <XIcon />
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={value.trim().length === 0}>
                <CheckIcon />
                {request.confirmLabel ?? 'Save'}
              </button>
            </footer>
          </form>
        ) : (
          <>
            <p className="dialog-body">{request.body}</p>
            <footer className="dialog-actions">
              <button type="button" onClick={() => resolveConfirm(false)}>
                <XIcon />
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                className={request.danger ? 'btn-danger' : 'btn-primary'}
                onClick={() => resolveConfirm(true)}
              >
                {request.danger ? <TrashIcon /> : <CheckIcon />}
                {request.confirmLabel ?? 'Confirm'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
