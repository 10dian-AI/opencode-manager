import { describe, expect, test } from 'bun:test'
import { selectAffinityAccountId } from '../server/utils/proxy-affinity'

describe('proxy affinity rendezvous hashing', () => {
  test('is independent from candidate ordering', () => {
    expect(selectAffinityAccountId('session-a', [1, 2, 3, 4])).toBe(
      selectAffinityAccountId('session-a', [4, 2, 1, 3])
    )
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
