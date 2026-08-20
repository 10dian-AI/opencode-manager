import type { Account } from '../utils/db'
import { classifyAccounts } from '../utils/account-stats'
import {
  effectiveRemainingAmount,
  QUOTA_LIMITS_USD,
  remainingAmount,
  remainingPercent
} from '../utils/quota'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const categories = classifyAccounts(await listAccounts())
  const availableAccounts = categories.availableAccounts

  const totalEffectiveRemaining = Math.round(
    availableAccounts.reduce((sum, account) => sum + effectiveRemainingAmount({
      rollingUsage: account.rolling_usage,
      weeklyUsage: account.weekly_usage,
      monthlyUsage: account.monthly_usage
    }), 0) * 100
  ) / 100

  return {
    total: categories.total,
    poolTotal: categories.poolTotal,
    active: availableAccounts.length,
    error: categories.error,
    riskControlled: categories.riskControlled,
    notRiskControlled: categories.notRiskControlled,
    disabled: categories.disabled,
    pending: categories.pending,
    members: categories.members,
    nonMembers: categories.nonMembers,
    membershipUnknown: categories.membershipUnknown,
    abandoned: categories.abandoned,
    abandonedRiskControlled: categories.abandonedRiskControlled,
    abandonedMonthlyExhausted: categories.abandonedMonthlyExhausted,
    available: availableAccounts.length,
    avgRollingRemaining: avgRemaining(availableAccounts.map(account => account.rolling_usage)),
    avgWeeklyRemaining: avgRemaining(availableAccounts.map(account => account.weekly_usage)),
    avgMonthlyRemaining: avgRemaining(availableAccounts.map(account => account.monthly_usage)),
    totalBalance: availableAccounts.reduce((sum, account) => sum + (account.balance || 0), 0),
    rollingRemainingAmount: sumRemaining(availableAccounts, 'rolling_usage', QUOTA_LIMITS_USD.rolling),
    weeklyRemainingAmount: sumRemaining(availableAccounts, 'weekly_usage', QUOTA_LIMITS_USD.weekly),
    monthlyRemainingAmount: sumRemaining(availableAccounts, 'monthly_usage', QUOTA_LIMITS_USD.monthly),
    rollingLimitAmount: knownLimit(availableAccounts, 'rolling_usage', QUOTA_LIMITS_USD.rolling),
    weeklyLimitAmount: knownLimit(availableAccounts, 'weekly_usage', QUOTA_LIMITS_USD.weekly),
    monthlyLimitAmount: knownLimit(availableAccounts, 'monthly_usage', QUOTA_LIMITS_USD.monthly),
    totalEffectiveRemaining
  }
})

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
