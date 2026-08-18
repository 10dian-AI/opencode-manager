export const QUOTA_LIMITS_USD = {
  rolling: 12,
  weekly: 30,
  monthly: 60
} as const

export type QuotaWindow = keyof typeof QUOTA_LIMITS_USD

export interface QuotaSnapshot {
  rollingUsage: number | null
  rollingResetAt: string | null
  weeklyUsage: number | null
  weeklyResetAt: string | null
  monthlyUsage: number | null
  monthlyResetAt: string | null
}

export function resetAtFromSeconds(seconds: number | null, now = new Date()): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  return new Date(now.getTime() + Math.max(0, seconds) * 1000).toISOString()
}

export function usedAmount(usagePercent: number | null | undefined, limit: number): number {
  if (typeof usagePercent !== 'number' || !Number.isFinite(usagePercent)) return 0
  return Math.round((Math.max(0, usagePercent) / 100) * limit * 100) / 100
}

export function remainingPercent(usagePercent: number | null | undefined): number {
  if (typeof usagePercent !== 'number' || !Number.isFinite(usagePercent)) return 0
  return Math.round(Math.max(0, Math.min(100, 100 - usagePercent)) * 10) / 10
}

export function remainingAmount(usagePercent: number | null | undefined, limit: number): number {
  return Math.round((remainingPercent(usagePercent) / 100) * limit * 100) / 100
}

/**
 * Return the amount that is actually usable before any known quota window is
 * exhausted. Unknown windows are excluded from the minimum; if every window
 * is unknown, return 0 so callers do not advertise an unverified balance.
 */
export function effectiveRemainingAmount(
  snapshot: Pick<QuotaSnapshot, 'rollingUsage' | 'weeklyUsage' | 'monthlyUsage'>,
  limits: typeof QUOTA_LIMITS_USD = QUOTA_LIMITS_USD
) {
  const windows = [
    { usage: snapshot.rollingUsage, limit: limits.rolling },
    { usage: snapshot.weeklyUsage, limit: limits.weekly },
    { usage: snapshot.monthlyUsage, limit: limits.monthly }
  ]
  const known = windows
    .filter(window => typeof window.usage === 'number' && Number.isFinite(window.usage))
    .map(window => remainingAmount(window.usage, window.limit))
  return known.length ? Math.min(...known) : 0
}

export function analyzeQuota(snapshot: QuotaSnapshot) {
  const windows = [
    { name: 'rolling' as const, usage: snapshot.rollingUsage, resetAt: snapshot.rollingResetAt },
    { name: 'weekly' as const, usage: snapshot.weeklyUsage, resetAt: snapshot.weeklyResetAt },
    { name: 'monthly' as const, usage: snapshot.monthlyUsage, resetAt: snapshot.monthlyResetAt }
  ]
  const exhausted = windows.filter(item => typeof item.usage === 'number' && item.usage >= 100)
  const futureResets = windows
    .map(item => item.resetAt)
    .filter((value): value is string => Boolean(value))
    .sort()
  const exhaustedResets = exhausted
    .map(item => item.resetAt)
    .filter((value): value is string => Boolean(value))
    .sort()

  return {
    exhausted: exhausted.map(item => item.name),
    nextRefreshAt: futureResets[0] || null,
    autoEnableAt: exhaustedResets.at(-1) || null
  }
}
