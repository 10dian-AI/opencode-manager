import type { Account } from '../utils/db'
import {
  effectiveRemainingAmount,
  QUOTA_LIMITS_USD,
  remainingAmount,
  remainingPercent
} from '../utils/quota'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const accounts = await listAccounts()

  const members = accounts.filter(account =>
    !account.is_abandoned && account.subscription_status === 'active'
  )
  const availableAccounts = accounts.filter(account =>
    !account.is_abandoned &&
    account.status === 'active' &&
    account.subscription_status === 'active' &&
    Boolean(account.upstream_api_key)
  )
  const availableMembers = availableAccounts
  const abnormalAccounts = accounts.filter(account =>
    account.status === 'error' || account.disabled_reason === 'risk_control'
  )
  const nonMembers = accounts.filter(account =>
    !account.is_abandoned &&
    account.subscription_status !== null &&
    account.subscription_status !== 'active'
  )
  const abandoned = accounts.filter(account => account.is_abandoned)

  const totalEffectiveRemaining = Math.round(
    availableMembers.reduce((sum, account) => sum + effectiveRemainingAmount({
      rollingUsage: account.rolling_usage,
      weeklyUsage: account.weekly_usage,
      monthlyUsage: account.monthly_usage
    }), 0) * 100
  ) / 100

  return {
    total: accounts.length,
    active: availableAccounts.length,
    error: abnormalAccounts.length,
    riskControlled: accounts.filter(account => account.disabled_reason === 'risk_control').length,
    disabled: accounts.filter(account => account.status === 'disabled').length,
    pending: accounts.filter(account => account.status === 'pending').length,
    members: members.length,
    nonMembers: nonMembers.length,
    abandoned: abandoned.length,
    available: availableMembers.length,
    avgRollingRemaining: avgRemaining(availableMembers.map(account => account.rolling_usage)),
    avgWeeklyRemaining: avgRemaining(availableMembers.map(account => account.weekly_usage)),
    avgMonthlyRemaining: avgRemaining(availableMembers.map(account => account.monthly_usage)),
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
