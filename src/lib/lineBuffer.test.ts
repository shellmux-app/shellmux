import { describe, expect, it } from 'vitest'

import { applyToLineBuffer, mayRecordInHistory } from './lineBuffer'

describe('mayRecordInHistory', () => {
  it('records a command the shell echoed after its prompt', () => {
    expect(mayRecordInHistory('docker ps -a', 'user@host:~$ docker ps -a')).toBe(true)
  })

  it('records when the line is exactly the command', () => {
    expect(mayRecordInHistory('ls -la', 'ls -la')).toBe(true)
  })

  /**
   * The security property: at a password prompt the remote pty has ECHO off,
   * so the typed characters are never drawn even though the app saw every
   * keystroke. Those must never reach localStorage.
   */
  it('refuses a password typed at a non-echoing prompt', () => {
    expect(mayRecordInHistory('hunter2', '[sudo] password for alice: ')).toBe(false)
    expect(mayRecordInHistory('s3cret', 'Enter password: ')).toBe(false)
    expect(mayRecordInHistory('key-passphrase', "Enter passphrase for key '/id_ed25519': ")).toBe(
      false,
    )
  })

  it('refuses an empty or whitespace-only submission', () => {
    expect(mayRecordInHistory('', 'user@host:~$ ')).toBe(false)
    expect(mayRecordInHistory('   ', 'user@host:~$ ')).toBe(false)
  })

  /**
   * `includes` would wrongly pass here: the prompt path contains "ls", so a
   * password of "ls" typed at an echo-off prompt would look echoed. The
   * cursor always sits at the end of what was drawn, so anchor to the end.
   */
  it('does not mistake text elsewhere in the prompt for an echo', () => {
    expect(mayRecordInHistory('ls', 'alice@host:~/tools$ ')).toBe(false)
    expect(mayRecordInHistory('ls', 'alice@host:~/tools$ ls')).toBe(true)
  })

  it('tolerates trailing whitespace on either side', () => {
    expect(mayRecordInHistory('git status', 'user@host:~$ git status   ')).toBe(true)
  })
})

/** Feeds a sequence of raw onData chunks through the reducer, returning the
 * final buffer plus every command that got submitted along the way. */
function run(chunks: string[]) {
  let buffer = ''
  const submitted: string[] = []
  for (const chunk of chunks) {
    const result = applyToLineBuffer(buffer, chunk)
    if (result.kind === 'submit') {
      submitted.push(result.command)
      buffer = ''
    } else {
      buffer = result.buffer
    }
  }
  return { buffer, submitted }
}

describe('applyToLineBuffer', () => {
  it('accumulates typed characters one at a time', () => {
    expect(run(['g', 'i', 't']).buffer).toBe('git')
  })

  it('accepts a multi-character chunk as one paste', () => {
    expect(run(['git status']).buffer).toBe('git status')
  })

  it('submits the buffer on carriage return and resets it', () => {
    const { buffer, submitted } = run(['g', 'i', 't', '\r'])
    expect(submitted).toEqual(['git'])
    expect(buffer).toBe('')
  })

  it('submits on a bare newline too', () => {
    expect(run(['ls', '\n']).submitted).toEqual(['ls'])
  })

  it('backspace (DEL) removes the last character', () => {
    expect(run(['g', 'i', 't', 'x', '\x7f']).buffer).toBe('git')
  })

  it('backspace (BS) removes the last character', () => {
    expect(run(['g', 'i', 't', 'x', '\b']).buffer).toBe('git')
  })

  it('backspace on an empty buffer does not underflow', () => {
    expect(run(['\x7f', '\x7f']).buffer).toBe('')
  })

  it('Ctrl+C clears the buffer without submitting it', () => {
    const { buffer, submitted } = run(['r', 'm', ' ', '-', 'r', 'f', '\x03'])
    expect(buffer).toBe('')
    expect(submitted).toEqual([])
  })

  it('Ctrl+U clears the buffer without submitting it', () => {
    const { buffer, submitted } = run(['g', 'i', 't', '\x15'])
    expect(buffer).toBe('')
    expect(submitted).toEqual([])
  })

  it('ignores escape sequences (arrow keys) entirely', () => {
    // Up-arrow is ESC [ A — none of it should land in the buffer.
    expect(run(['g', 'i', '\x1b[A', 't']).buffer).toBe('git')
  })

  it('does not add Ctrl+R to the buffer', () => {
    expect(run(['g', 'i', '\x12', 't']).buffer).toBe('git')
  })

  it('handles a full multi-command session in order', () => {
    const { submitted, buffer } = run([
      'g', 'i', 't', ' ', 's', 't', 'a', 't', 'u', 's', '\r',
      'l', 's', ' ', '-', 'l', 'a', '\r',
      'c', 'd', ' ', '.', '.',
    ])
    expect(submitted).toEqual(['git status', 'ls -la'])
    expect(buffer).toBe('cd ..')
  })
})
