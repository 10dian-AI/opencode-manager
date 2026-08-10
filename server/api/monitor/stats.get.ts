export default defineEventHandler(async () => {
  const accounts = await getProxyCandidates()
  const allAccounts = await listAccounts()

  // Calculate total quota from active accounts
  let totalQuota = 0
  for (const account of accounts) {
    if (account.status === 'active' && account.subscription_status === 'active') {
      const rollingLimit = 25 // 5h limit
      const rollingUsage = account.rolling_usage || 0
      const rollingRemaining = Math.max(0, rollingLimit - rollingUsage)

      const weeklyLimit = 100 // Weekly limit
      const weeklyUsage = account.weekly_usage || 0
      const weeklyRemaining = Math.max(0, weeklyLimit - weeklyUsage)

      totalQuota += Math.min(rollingRemaining, weeklyRemaining)
    }
  }

  return {
    active_accounts: accounts.length,
    total_accounts: allAccounts.length,
    total_quota: totalQuota
  }
})
