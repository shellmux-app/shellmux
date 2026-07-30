import { create } from 'zustand'

/**
 * Thay `window.prompt` / `window.confirm` bằng dialog trong app.
 *
 * Dialog của hệ điều hành chặn cả process, không style được, và trên macOS nó
 * hiện ra như một cảnh báo hệ thống cho một việc nhỏ như đổi tên file. API ở
 * đây vẫn trả Promise nên call site gần như không đổi.
 */

interface PromptOptions {
  title: string
  label: string
  value?: string
  placeholder?: string
  confirmLabel?: string
  hint?: string
}

interface ConfirmOptions {
  title: string
  body: string
  confirmLabel?: string
  /** Hành động phá huỷ: nút xác nhận đổi sang tông cảnh báo. */
  danger?: boolean
}

export type DialogRequest =
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions)
  | ({ kind: 'confirm'; resolve: (value: boolean) => void } & ConfirmOptions)

interface DialogState {
  request: DialogRequest | null
  ask: (options: PromptOptions) => Promise<string | null>
  confirm: (options: ConfirmOptions) => Promise<boolean>
  resolvePrompt: (value: string | null) => void
  resolveConfirm: (value: boolean) => void
}

export const useDialog = create<DialogState>((set, get) => ({
  request: null,

  ask: (options) =>
    new Promise<string | null>((resolve) => {
      set({ request: { kind: 'prompt', resolve, ...options } })
    }),

  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      set({ request: { kind: 'confirm', resolve, ...options } })
    }),

  resolvePrompt: (value) => {
    const request = get().request
    if (request?.kind !== 'prompt') return
    set({ request: null })
    request.resolve(value)
  },

  resolveConfirm: (value) => {
    const request = get().request
    if (request?.kind !== 'confirm') return
    set({ request: null })
    request.resolve(value)
  },
}))
