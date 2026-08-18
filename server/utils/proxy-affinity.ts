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

function isHigherScore(left: RendezvousScore, right: RendezvousScore | null) {
  if (!right) return true
  return left.high > right.high || (left.high === right.high && left.low > right.low)
}

/**
 * Rendezvous hashing only remaps a key when the selected account disappears or
 * a newly added account wins that key, unlike hash % accountCount.
 */
export function selectAffinityAccountId(
  affinityKey: string,
  accountIds: Iterable<number>
): number | null {
  let selected: number | null = null
  let selectedScore: RendezvousScore | null = null
  for (const accountId of accountIds) {
    const score = rendezvousScore(affinityKey, accountId)
    if (
      isHigherScore(score, selectedScore) ||
      (selectedScore && score.high === selectedScore.high && score.low === selectedScore.low &&
        (selected === null || accountId < selected))
    ) {
      selected = accountId
      selectedScore = score
    }
  }
  return selected
}
