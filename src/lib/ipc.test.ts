import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { decodeBytes, encodeBytes } from './ipc'

describe('base64 bridge', () => {
  it('round-trips bytes that are not valid UTF-8', () => {
    // Arrange: terminal escape sequences often have odd bytes like 0x9b, 0xff.
    const bytes = new Uint8Array([0x1b, 0x5b, 0x41, 0x9b, 0xff, 0x00, 0x7f])

    // Act
    const restored = decodeBytes(encodeBytes(bytes))

    // Assert
    expect(Array.from(restored)).toEqual(Array.from(bytes))
  })

  it('round-trips every possible byte value', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i += 1) bytes[i] = i

    expect(Array.from(decodeBytes(encodeBytes(bytes)))).toEqual(Array.from(bytes))
  })

  it('handles an empty payload', () => {
    expect(encodeBytes(new Uint8Array())).toBe('')
    expect(decodeBytes('')).toHaveLength(0)
  })

  it('handles payloads larger than the chunk size without blowing the stack', () => {
    // The chunk size in encodeBytes is 0x8000; this test crosses multiple chunks.
    const size = 0x8000 * 3 + 17
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i += 1) bytes[i] = i % 256

    const restored = decodeBytes(encodeBytes(bytes))

    expect(restored).toHaveLength(size)
    expect(restored[size - 1]).toBe((size - 1) % 256)
  })
})
