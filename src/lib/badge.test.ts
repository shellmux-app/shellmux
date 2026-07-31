import { describe, expect, it } from 'vitest'

import { badgeColor, badgeText, PALETTE } from './badge'

describe('badgeColor', () => {
  it('is deterministic for the same seed', () => {
    expect(badgeColor('prod-web-01')).toBe(badgeColor('prod-web-01'))
  })

  it('always returns a color from the palette', () => {
    expect(PALETTE).toContain(badgeColor('any-host-name'))
    expect(PALETTE).toContain(badgeColor(''))
  })

  it('varies across different seeds', () => {
    const colors = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(badgeColor))
    expect(colors.size).toBeGreaterThan(1)
  })
})

describe('badgeText', () => {
  it('uses the first letter of each of the first two words', () => {
    expect(badgeText('prod web')).toBe('pw')
    expect(badgeText('Production Web-01')).toBe('PW')
  })

  it('splits on spaces, dots, underscores, hyphens, and slashes', () => {
    expect(badgeText('db.primary')).toBe('dp')
    expect(badgeText('db_primary')).toBe('dp')
    expect(badgeText('db-primary')).toBe('dp')
    expect(badgeText('db/primary')).toBe('dp')
  })

  it('takes the first two letters of a single word', () => {
    expect(badgeText('webserver')).toBe('we')
  })

  it('falls back to "?" when there is nothing to show', () => {
    expect(badgeText('')).toBe('?')
    expect(badgeText('   ')).toBe('?')
  })
})
