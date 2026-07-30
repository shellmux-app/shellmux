/**
 * Text badges instead of icons, the way TablePlus tells connections apart
 * (`Re`, `Pg`, `Sl`). Color is derived from the name, so a given host keeps
 * the same color across sessions and users recognize it by color before
 * they read the text.
 */

export const PALETTE = [
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

/** At most 2 characters: first letter of the first two words, or the first two letters. */
export function badgeText(label: string): string {
  const words = label
    .split(/[\s._\-/]+/)
    .map((w) => w.trim())
    .filter(Boolean)

  if (words.length >= 2) return (words[0][0] + words[1][0]).slice(0, 2)
  if (words.length === 1) return words[0].slice(0, 2)
  return '?'
}
