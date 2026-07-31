/**
 * Best-effort reconstruction of "the command on the current terminal line",
 * fed one raw `term.onData` chunk at a time. Backs both history recording
 * (on Enter) and the history overlay's autocomplete prefill.
 *
 * Known limitation: a command recalled via the *remote* shell's own
 * up-arrow history bypasses this — there's no reliable way to tell that
 * apart from ordinary PTY output without parsing shell-specific escape
 * sequences, so it isn't attempted.
 */

export type LineBufferResult =
  | { kind: 'update'; buffer: string }
  | { kind: 'submit'; command: string }

/** Ctrl+R — a shortcut this app intercepts, not content for the line. */
const CTRL_R = '\x12'

/**
 * Whether a submitted line may be remembered in history.
 *
 * This is the guard that keeps secrets out of history, so it is written to
 * fail closed. A password prompt (`sudo`, `mysql -p`, `ssh`, `read -s`)
 * turns the remote pty's ECHO off, so nothing the user types is ever drawn
 * — while the terminal's `onData` still sees every keystroke. Recording
 * unconditionally would persist those passwords to localStorage in
 * plaintext and surface them in the Ctrl+R overlay.
 *
 * `visibleLine` is the row the cursor is on, read at keypress time, before
 * the remote has processed the Enter — so an echoed command is still on
 * screen. It must *end* with the command rather than merely contain it:
 * a prompt like `user@host:~/tools$ ` can incidentally contain a short
 * command, and the cursor always sits at the end of what was echoed.
 *
 * Deliberately conservative — a command that wrapped onto another row won't
 * match and simply isn't recorded. Losing a history entry is fine; leaking
 * a password is not.
 */
export function mayRecordInHistory(command: string, visibleLine: string): boolean {
  if (command.trim().length === 0) return false
  return visibleLine.trimEnd().endsWith(command.trimEnd())
}

export function applyToLineBuffer(buffer: string, data: string): LineBufferResult {
  // Escape sequences (arrow keys, function keys, ...) start with ESC —
  // treat them as a no-op rather than guessing what they'd do to the line.
  if (data.startsWith('\x1b')) return { kind: 'update', buffer }

  if (data === '\r' || data === '\n') return { kind: 'submit', command: buffer }

  if (data === '\x7f' || data === '\b') {
    return { kind: 'update', buffer: buffer.slice(0, -1) }
  }

  // Ctrl+C / Ctrl+U: the line was aborted or killed, not submitted.
  if (data === '\x03' || data === '\x15') return { kind: 'update', buffer: '' }

  if (data.length > 0 && !data.startsWith(CTRL_R) && data.charCodeAt(0) >= 0x20) {
    // Printable text, including a multi-character paste.
    return { kind: 'update', buffer: buffer + data }
  }

  return { kind: 'update', buffer }
}
