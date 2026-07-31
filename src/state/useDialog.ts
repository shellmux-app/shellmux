import { create } from 'zustand'

/**
 * Replaces `window.prompt` / `window.confirm` with an in-app dialog.
 *
 * The OS dialog blocks the whole process, can't be styled, and on macOS it
 * shows up as a system alert for something as small as renaming a file. This
 * API still returns a Promise, so call sites barely change.
 */

interface PromptOptions {
  title: string
  label: string
  value?: string
  placeholder?: string
  confirmLabel?: string
  hint?: string
  /** Renders the input as `type="password"` — for passphrases, not names. */
  masked?: boolean
}

interface ConfirmOptions {
  title: string
  body: string
  confirmLabel?: string
  /** Destructive action: the confirm button switches to a warning tone. */
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
