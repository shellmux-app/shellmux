/**
 * Badge chữ thay cho icon, đúng cách TablePlus phân biệt kết nối (`Re`, `Pg`,
 * `Sl`). Màu suy ra từ tên nên mỗi host luôn giữ đúng một màu qua các lần mở,
 * và người dùng nhận ra host bằng màu trước khi đọc chữ.
 */

const PALETTE = [
  '#e0663b',
  '#2f7fe6',
  '#0f9d76',
  '#8d5cf6',
  '#d9a11b',
  '#d4426e',
  '#3aa8c1',
  '#5b6b7c',
]

function hash(seed: string): number {
  let value = 0
  for (let i = 0; i < seed.length; i += 1) {
    value = (value * 31 + seed.charCodeAt(i)) >>> 0
  }
  return value
}

export function badgeColor(seed: string): string {
  return PALETTE[hash(seed) % PALETTE.length]
}

/** Tối đa 2 ký tự: chữ đầu của hai từ đầu, hoặc hai ký tự đầu. */
export function badgeText(label: string): string {
  const words = label
    .split(/[\s._\-/]+/)
    .map((w) => w.trim())
    .filter(Boolean)

  if (words.length >= 2) return (words[0][0] + words[1][0]).slice(0, 2)
  if (words.length === 1) return words[0].slice(0, 2)
  return '?'
}
