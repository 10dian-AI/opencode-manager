import { effectiveRemainingAmount } from '../../utils/quota'

export default defineEventHandler(async () => {
  const accounts = await getProxyCandidates()
  const allAccounts = await listAccounts()

  let totalQuota = 0
  for (const account of accounts) {
    totalQuota += effectiveRemainingAmount({
      rollingUsage: account.rolling_usage,
      weeklyUsage: account.weekly_usage,
      monthlyUsage: account.monthly_usage
    })
  }

  return {
    active_accounts: accounts.length,
    total_accounts: allAccounts.length,
    total_quota: Math.round(totalQuota * 100) / 100
  }
})
