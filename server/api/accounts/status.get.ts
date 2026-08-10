export default defineEventHandler(async (event) => {
  await requireSession(event)

  const accounts = await getProxyCandidates()
  const allAccounts = await listAccounts()

  const accountsStatus = await Promise.all(
    allAccounts.map(async (account) => {
      const isActive = account.status === 'active' &&
                       account.subscription_status === 'active' &&
                       account.upstream_api_key

      // Calculate cooldown time
      let cooldownSeconds = 0
      if (account.auto_enable_at) {
        const enableAt = new Date(account.auto_enable_at).getTime()
        const now = Date.now()
        cooldownSeconds = Math.max(0, Math.ceil((enableAt - now) / 1000))
      }

      // Calculate remaining quota (minimum of 5h and weekly limits)
      let remainingQuota = null
      if (isActive) {
        const rollingLimit = 25 // 5h limit in dollars
        const rollingUsage = account.rolling_usage || 0
        const rollingRemaining = Math.max(0, rollingLimit - rollingUsage)

        const weeklyLimit = account.weekly_usage !== null ? 100 : null // Assuming $100 weekly limit
        const weeklyRemaining = weeklyLimit !== null
          ? Math.max(0, weeklyLimit - (account.weekly_usage || 0))
          : null

        remainingQuota = weeklyRemaining !== null
          ? Math.min(rollingRemaining, weeklyRemaining)
          : rollingRemaining
      }

      return {
        id: account.id,
        name: account.name || account.email || `账号 #${account.id}`,
        status: account.status,
        subscription_status: account.subscription_status,
        is_available: isActive,
        disabled_reason: account.disabled_reason,
        cooldown_seconds: cooldownSeconds,
        remaining_quota: remainingQuota,
        rolling_usage: account.rolling_usage,
        rolling_reset_at: account.rolling_reset_at,
        weekly_usage: account.weekly_usage,
        weekly_reset_at: account.weekly_reset_at
      }
    })
  )

  return {
    total: allAccounts.length,
    active: accounts.length,
    accounts: accountsStatus
  }
})
