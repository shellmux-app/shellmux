import { useEffect, useRef, useState } from 'react'

import { useDialog } from '../../state/useDialog'

/**
 * Nơi duy nhất render prompt/confirm. Đặt một lần ở App, mọi call site chỉ gọi
 * `ask()` / `confirm()` rồi await.
 *
 * Bàn phím: Esc để huỷ, Enter để xác nhận, autofocus vào ô nhập — đúng những
 * gì `window.prompt` cho sẵn mà app tự làm thường bỏ mất.
 */
export function DialogHost() {
  const { request, resolvePrompt, resolveConfirm } = useDialog()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (request?.kind === 'prompt') {
      setValue(request.value ?? '')
      // Chờ một frame để dialog vào DOM rồi mới focus và select.
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
                autoFocus
                value={value}
                placeholder={request.placeholder}
                onChange={(e) => setValue(e.target.value)}
              />
              {request.hint && <span className="field-hint">{request.hint}</span>}
            </label>

            <footer className="dialog-actions">
              <button type="button" onClick={cancel}>
                Huỷ
              </button>
              <button type="submit" className="btn-primary" disabled={value.trim().length === 0}>
                {request.confirmLabel ?? 'Lưu'}
              </button>
            </footer>
          </form>
        ) : (
          <>
            <p className="dialog-body">{request.body}</p>
            <footer className="dialog-actions">
              <button type="button" onClick={() => resolveConfirm(false)}>
                Huỷ
              </button>
              <button
                type="button"
                autoFocus
                className={request.danger ? 'btn-danger' : 'btn-primary'}
                onClick={() => resolveConfirm(true)}
              >
                {request.confirmLabel ?? 'Đồng ý'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
