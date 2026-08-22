import { describe, expect, test } from 'bun:test'
import { rankAffinityAccountIds, selectAffinityAccountId } from '../server/utils/proxy-affinity'

describe('proxy affinity rendezvous hashing', () => {
  test('is independent from candidate ordering', () => {
    expect(selectAffinityAccountId('session-a', [1, 2, 3, 4])).toBe(
      selectAffinityAccountId('session-a', [4, 2, 1, 3])
    )
  })

  test('keeps a stable spillover order independent from candidate ordering', () => {
    const expected = rankAffinityAccountIds('busy-session', [1, 2, 3, 4, 5])
    expect(rankAffinityAccountIds('busy-session', [5, 3, 1, 4, 2])).toEqual(expected)
    expect(new Set(expected).size).toBe(5)
    expect(expected[0]).toBe(selectAffinityAccountId('busy-session', [1, 2, 3, 4, 5]))
  })

  test('removes only the unavailable account from the spillover order', () => {
    const ranked = rankAffinityAccountIds('session-overflow', [1, 2, 3, 4])
    const removed = ranked[1]!
    expect(rankAffinityAccountIds('session-overflow', [1, 2, 3, 4].filter(id => id !== removed)))
      .toEqual(ranked.filter(id => id !== removed))
  })

  test('deduplicates account ids before ranking', () => {
    expect(rankAffinityAccountIds('session-a', [1, 1, 2, 2])).toHaveLength(2)
  })

  test('only moves existing keys to a newly added account', () => {
    for (let index = 0; index < 200; index++) {
      const key = `session-${index}`
      const before = selectAffinityAccountId(key, [1, 2, 3])
      const after = selectAffinityAccountId(key, [1, 2, 3, 4])
      if (before !== after) expect(after).toBe(4)
    }
  })

  test('keeps a key stable when an unrelated account disappears', () => {
    for (let index = 0; index < 100; index++) {
      const key = `stable-${index}`
      const selected = selectAffinityAccountId(key, [1, 2, 3])
      const removed = [1, 2, 3].find(id => id !== selected)!
      expect(selectAffinityAccountId(key, [1, 2, 3].filter(id => id !== removed))).toBe(selected)
    }
  })

  test('returns null for an empty pool', () => {
    expect(selectAffinityAccountId('session-a', [])).toBeNull()
  })
})
