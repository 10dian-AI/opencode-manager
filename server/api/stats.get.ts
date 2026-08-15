import type { Account } from '../utils/db'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const accounts = await listAccounts()

  const members = accounts.filter(account => account.subscription_status === 'active')
  const availableAccounts = accounts.filter(account => account.status === 'active')
  const availableMembers = members.filter(account =>
    account.status === 'active' &&
    account.disabled_reason !== 'risk_control' &&
    typeof account.monthly_usage === 'number' &&
    Number.isFinite(account.monthly_usage) &&
    account.monthly_usage < 100
  )
  const riskControlled = accounts.filter(account =>
    account.disabled_reason === 'risk_control'
  )
  const nonMembers = accounts.filter(account =>
    account.subscription_status !== null && account.subscription_status !== 'active'
  )
  const abandoned = accounts.filter(account => account.is_abandoned)

  // For each available member, effective remaining = min(5h remaining, weekly remaining, monthly remaining)
  // This reflects the true usable quota before hitting any window limit.
  const effectiveRemainingAmounts = availableMembers.map(a =>
    effectiveRemainingAmount(a, QUOTA_LIMITS_USD)
  )
  const totalEffectiveRemaining = Math.round(
    effectiveRemainingAmounts.reduce((sum, v) => sum + v, 0) * 100
  ) / 100

  return {
    total: accounts.length,
    active: availableAccounts.length,
    error: riskControlled.length,
    disabled: accounts.filter(a => a.status === 'disabled').length,
    pending: accounts.filter(a => a.status === 'pending').length,
    members: members.length,
    nonMembers: nonMembers.length,
    abandoned: abandoned.length,
    available: availableMembers.length,
    avgRollingRemaining: avgRemaining(availableMembers.map(a => a.rolling_usage)),
    avgWeeklyRemaining: avgRemaining(availableMembers.map(a => a.weekly_usage)),
    avgMonthlyRemaining: avgRemaining(availableMembers.map(a => a.monthly_usage)),
    totalBalance: availableAccounts.reduce((sum, account) => sum + (account.balance || 0), 0),
    rollingRemainingAmount: sumRemaining(availableMembers, 'rolling_usage', QUOTA_LIMITS_USD.rolling),
    weeklyRemainingAmount: sumRemaining(availableMembers, 'weekly_usage', QUOTA_LIMITS_USD.weekly),
    monthlyRemainingAmount: sumRemaining(availableMembers, 'monthly_usage', QUOTA_LIMITS_USD.monthly),
    rollingLimitAmount: knownLimit(availableMembers, 'rolling_usage', QUOTA_LIMITS_USD.rolling),
    weeklyLimitAmount: knownLimit(availableMembers, 'weekly_usage', QUOTA_LIMITS_USD.weekly),
    monthlyLimitAmount: knownLimit(availableMembers, 'monthly_usage', QUOTA_LIMITS_USD.monthly),
    totalEffectiveRemaining
  }
})

/**
 * Effective remaining for one account = min of all three window remainders.
 * If a window's usage is unknown, it is excluded from the min (treated as unlimited).
 * If all windows are unknown, returns 0.
 */
function effectiveRemainingAmount(
  account: Account,
  limits: typeof QUOTA_LIMITS_USD
): number {
  const windows = [
    { usage: account.rolling_usage, limit: limits.rolling },
    { usage: account.weekly_usage, limit: limits.weekly },
    { usage: account.monthly_usage, limit: limits.monthly }
  ]
  const known = windows
    .filter(w => typeof w.usage === 'number' && Number.isFinite(w.usage))
    .map(w => remainingAmount(w.usage, w.limit))
  return known.length ? Math.min(...known) : 0
}

function sumRemaining(
  accounts: Account[],
  field: 'rolling_usage' | 'weekly_usage' | 'monthly_usage',
  limit: number
) {
  return Math.round(
    accounts.reduce((sum, account) => sum + remainingAmount(account[field], limit), 0) * 100
  ) / 100
}

function avgRemaining(values: Array<number | null | undefined>) {
  const nums = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map(remainingPercent)
  if (!nums.length) return 0
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
}

function knownLimit(
  accounts: Account[],
  field: 'rolling_usage' | 'weekly_usage' | 'monthly_usage',
  limit: number
) {
  return accounts.filter(account =>
    typeof account[field] === 'number' && Number.isFinite(account[field])
  ).length * limit
}
