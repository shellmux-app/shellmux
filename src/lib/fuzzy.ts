/**
 * Small fzf-style subsequence matcher: every character of `query` must
 * appear in `candidate`, in order, but not necessarily contiguous — so
 * "gcm" matches "git commit -m". No dependency pulled in for this; the
 * whole algorithm is short enough to own directly.
 */

export interface FuzzyMatch {
  text: string
  /** Higher is a better match. Only meaningful for sorting, not absolute. */
  score: number
  /** Indexes into `text` that matched the query, for highlighting. */
  positions: number[]
}

/**
 * Scores `candidate` against `query`, or returns null if `query` isn't a
 * subsequence of `candidate` at all. Rewards matches that start earlier,
 * are more contiguous, and land right after a word boundary (so "gc"
 * prefers "git commit" over "loGCat").
 */
export function fuzzyScore(query: string, candidate: string): FuzzyMatch | null {
  if (query.length === 0) return { text: candidate, score: 0, positions: [] }

  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  const positions: number[] = []
  let qi = 0
  let score = 0
  let lastMatch = -1

  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] !== q[qi]) continue

    const isWordStart = ci === 0 || /[\s/_-]/.test(c[ci - 1])
    const isContiguous = lastMatch === ci - 1
    score += 1 + (isWordStart ? 3 : 0) + (isContiguous ? 2 : 0) - ci * 0.01

    positions.push(ci)
    lastMatch = ci
    qi += 1
  }

  if (qi < q.length) return null
  return { text: candidate, score, positions }
}

/**
 * Filters and ranks `candidates` against `query`, best match first. An
 * empty query returns every candidate in its original order (most-recent
 * history entries stay most-recent, not resorted).
 */
export function fuzzyFilter(query: string, candidates: string[], limit = 50): FuzzyMatch[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return candidates.slice(0, limit).map((text) => ({ text, score: 0, positions: [] }))
  }

  const scored: FuzzyMatch[] = []
  for (const candidate of candidates) {
    const match = fuzzyScore(trimmed, candidate)
    if (match) scored.push(match)
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
