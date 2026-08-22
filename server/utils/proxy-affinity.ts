import { createHash } from 'node:crypto'

interface RendezvousScore {
  high: number
  low: number
}

function rendezvousScore(affinityKey: string, accountId: number): RendezvousScore {
  const digest = createHash('sha256')
    .update(affinityKey)
    .update('\0')
    .update(String(accountId))
    .digest()
  return {
    high: digest.readUInt32BE(0),
    low: digest.readUInt32BE(4)
  }
}

/**
 * Returns the full rendezvous-hash order for a key. The first account remains
 * the preferred affinity target, while later accounts provide deterministic
 * spillover when earlier accounts have reached their live concurrency limit.
 */
export function rankAffinityAccountIds(
  affinityKey: string,
  accountIds: Iterable<number>
): number[] {
  return [...new Set(accountIds)]
    .map(accountId => ({ accountId, score: rendezvousScore(affinityKey, accountId) }))
    .sort((left, right) => {
      if (left.score.high !== right.score.high) return right.score.high - left.score.high
      if (left.score.low !== right.score.low) return right.score.low - left.score.low
      return left.accountId - right.accountId
    })
    .map(entry => entry.accountId)
}

/**
 * Rendezvous hashing only remaps a key when the selected account disappears or
 * a newly added account wins that key, unlike hash % accountCount.
 */
export function selectAffinityAccountId(
  affinityKey: string,
  accountIds: Iterable<number>
): number | null {
  return rankAffinityAccountIds(affinityKey, accountIds)[0] ?? null
}
