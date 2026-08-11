import { listAccounts } from '~/server/utils/db'
import { QUOTA_LIMITS_USD } from '~/server/utils/constants'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const accounts = await listAccounts()

  const members = accounts.filter(account => account.subscription_status === 'active')
  const available = members.filter(account =>
    account.status === 'active' && !account.disabled_reason
  )
  return {
    total: accounts.length,
    active: accounts.filter(a => a.status === 'active').length,
    error: accounts.filter(a => a.status === 'error').length,
    disabled: accounts.filter(a => a.status === 'disabled').length,
    pending: accounts.filter(a => a.status === 'pending').length,
    members: members.length,
    nonMembers: accounts.length - members.length,
    available: available.length,
    avgRollingRemaining: avgRemaining(available.map(a => a.rolling_usage)),
    avgWeeklyRemaining: avgRemaining(available.map(a => a.weekly_usage)),
    avgMonthlyRemaining: avgRemaining(available.map(a => a.monthly_usage)),
    totalBalance: available.reduce((sum, account) => sum + (account.balance || 0), 0),
    rollingRemainingAmount: sumRemaining(available, 'rolling_usage', QUOTA_LIMITS_USD.rolling),
    weeklyRemainingAmount: sumRemaining(available, 'weekly_usage', QUOTA_LIMITS_USD.weekly),
    monthlyRemainingAmount: sumRemaining(available, 'monthly_usage', QUOTA_LIMITS_USD.monthly),
    rollingLimitAmount: knownLimit(available, 'rolling_usage', QUOTA_LIMITS_USD.rolling),
    weeklyLimitAmount: knownLimit(available, 'weekly_usage', QUOTA_LIMITS_USD.weekly),
    monthlyLimitAmount: knownLimit(available, 'monthly_usage', QUOTA_LIMITS_USD.monthly)
  }
})

function sumRemaining(
  accounts: Awaited<ReturnType<typeof listAccounts>>,
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
  accounts: Awaited<ReturnType<typeof listAccounts>>,
  field: 'rolling_usage' | 'weekly_usage' | 'monthly_usage',
  limit: number
) {
  return accounts.filter(account =>
    typeof account[field] === 'number' && Number.isFinite(account[field])
  ).length * limit
}
