import { getAppSetting, setAppSetting } from './db'

export interface ReferralRewardCacheInput {
  rewardIds: Iterable<string>
  usedRewardIds?: Iterable<string>
  workspaceId: string | null
  applyServerId: string | null
  refreshedAt?: number
}

export interface ReferralRewardCacheSnapshot {
  rewardIds: string[]
  usedRewardIds: string[]
  workspaceId: string | null
  applyServerId: string | null
  refreshedAt: number
  deleted?: boolean
}

export interface SelectedReferralReward {
  rewardId: string
  workspaceId: string | null
  applyServerId: string | null
  refreshedAt: number
}

interface ReferralRewardCacheEntry {
  rewardIds: Set<string>
  usedRewardIds: Set<string>
  workspaceId: string | null
  applyServerId: string | null
  refreshedAt: number
}

const referralRewardsByAccount = new Map<number, ReferralRewardCacheEntry>()
const CACHE_SETTING_PREFIX = 'referral_rewards:'
const pendingWrites = new Map<number, Promise<void>>()

function enqueueCacheWrite(accountId: number, value: ReferralRewardCacheSnapshot) {
  const previous = pendingWrites.get(accountId) || Promise.resolve()
  const write = previous
    .then(() => setAppSetting(`${CACHE_SETTING_PREFIX}${accountId}`, JSON.stringify(value)))
    .catch(() => {})
    .finally(() => {
      if (pendingWrites.get(accountId) === write) pendingWrites.delete(accountId)
    })
  pendingWrites.set(accountId, write)
}

export async function flushCachedReferralRewards(accountId: number) {
  await pendingWrites.get(accountId)
}

function persistCache(accountId: number) {
  const cached = getCachedReferralRewards(accountId)
  if (!cached) {
    enqueueCacheWrite(accountId, {
      rewardIds: [],
      usedRewardIds: [],
      workspaceId: null,
      applyServerId: null,
      refreshedAt: Date.now(),
      deleted: true
    })
    return
  }
  enqueueCacheWrite(accountId, cached)
}

export async function hydrateCachedReferralRewards(accountId: number) {
  await flushCachedReferralRewards(accountId)
  const local = getCachedReferralRewards(accountId)
  const stored = await getAppSetting(`${CACHE_SETTING_PREFIX}${accountId}`)
  if (!stored) return local
  try {
    const parsed = JSON.parse(stored) as ReferralRewardCacheSnapshot
    if (parsed.deleted) {
      if (!local || parsed.refreshedAt >= local.refreshedAt) {
        referralRewardsByAccount.delete(accountId)
        return undefined
      }
      return local
    }
    if (!local || parsed.refreshedAt >= local.refreshedAt) {
      cacheAvailableReferralRewards(accountId, parsed, false)
    }
  } catch {
    // Ignore malformed cache data; the next account refresh replaces it.
  }
  return getCachedReferralRewards(accountId)
}

export function cacheAvailableReferralRewards(
  accountId: number,
  input: ReferralRewardCacheInput,
  persist = true
) {
  referralRewardsByAccount.set(accountId, {
    rewardIds: new Set(input.rewardIds),
    usedRewardIds: new Set(input.usedRewardIds ?? []),
    workspaceId: input.workspaceId,
    applyServerId: input.applyServerId,
    refreshedAt: input.refreshedAt ?? Date.now()
  })
  if (persist) persistCache(accountId)
}

export function getCachedReferralRewards(
  accountId: number
): ReferralRewardCacheSnapshot | undefined {
  const cached = referralRewardsByAccount.get(accountId)
  if (!cached) return undefined
  return {
    rewardIds: [...cached.rewardIds],
    usedRewardIds: [...cached.usedRewardIds],
    workspaceId: cached.workspaceId,
    applyServerId: cached.applyServerId,
    refreshedAt: cached.refreshedAt
  }
}

export function selectCachedReferralReward(
  accountId: number,
  rewardId: string
): SelectedReferralReward | undefined {
  const cached = referralRewardsByAccount.get(accountId)
  if (!cached?.rewardIds.has(rewardId)) return undefined
  return {
    rewardId,
    workspaceId: cached.workspaceId,
    applyServerId: cached.applyServerId,
    refreshedAt: cached.refreshedAt
  }
}

export function consumeCachedReferralReward(accountId: number, rewardId: string) {
  const cached = referralRewardsByAccount.get(accountId)
  if (!cached?.rewardIds.delete(rewardId)) return false
  cached.usedRewardIds.add(rewardId)
  cached.refreshedAt = Math.max(Date.now(), cached.refreshedAt + 1)
  persistCache(accountId)
  return true
}

export function removeCachedReferralRewards(accountId: number) {
  const refreshedAt = Math.max(
    Date.now(),
    (referralRewardsByAccount.get(accountId)?.refreshedAt || 0) + 1
  )
  referralRewardsByAccount.delete(accountId)
  enqueueCacheWrite(accountId, {
    rewardIds: [],
    usedRewardIds: [],
    workspaceId: null,
    applyServerId: null,
    refreshedAt,
    deleted: true
  })
}

export function retainCachedReferralRewardAccounts(accountIds: Iterable<number>) {
  const retained = new Set(accountIds)
  for (const accountId of referralRewardsByAccount.keys()) {
    if (!retained.has(accountId)) removeCachedReferralRewards(accountId)
  }
}
