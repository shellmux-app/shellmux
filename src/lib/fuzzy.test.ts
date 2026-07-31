import { describe, expect, it } from 'vitest'

import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('matches when every query character appears in order, non-contiguous', () => {
    expect(fuzzyScore('gcm', 'git commit -m')).not.toBeNull()
  })

  it('does not match when a query character is missing', () => {
    expect(fuzzyScore('gcz', 'git commit -m')).toBeNull()
  })

  it('does not match out-of-order characters', () => {
    expect(fuzzyScore('tg', 'git')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('GCM', 'git commit -m')).not.toBeNull()
  })

  it('an empty query matches anything with zero score', () => {
    expect(fuzzyScore('', 'anything')).toEqual({ text: 'anything', score: 0, positions: [] })
  })

  it('scores a contiguous, word-start match higher than a scattered mid-word one', () => {
    const contiguous = fuzzyScore('git', 'git commit')
    // Every matched letter sits mid-word here, none contiguous, none at a
    // word boundary — the opposite of every bonus `contiguous` gets.
    const scattered = fuzzyScore('git', 'xgxixt')
    expect(contiguous).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(contiguous!.score).toBeGreaterThan(scattered!.score)
  })

  it('records the matched character positions', () => {
    const match = fuzzyScore('cm', 'commit')
    expect(match?.positions).toEqual([0, 2])
  })
})

describe('fuzzyFilter', () => {
  const history = ['git status', 'git commit -m "fix"', 'ls -la', 'ssh prod-db']

  it('an empty query returns every candidate in original order', () => {
    expect(fuzzyFilter('', history).map((m) => m.text)).toEqual(history)
  })

  it('filters out non-matches and ranks the rest by score', () => {
    const results = fuzzyFilter('git', history)
    expect(results.map((m) => m.text)).toEqual(['git status', 'git commit -m "fix"'])
  })

  it('respects the limit', () => {
    const results = fuzzyFilter('', ['a', 'b', 'c'], 2)
    expect(results).toHaveLength(2)
  })

  it('returns nothing when nothing matches', () => {
    expect(fuzzyFilter('zzz', history)).toEqual([])
  })
})
