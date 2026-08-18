import { effectiveRemainingAmount } from '../../utils/quota'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  try {
    const accounts = await getProxyCandidates()
    const allAccounts = await listAccounts()

    const accountsStatus = allAccounts.map(account => {
      const isActive = Boolean(
        account.status === 'active' &&
        account.subscription_status === 'active' &&
        account.upstream_api_key &&
        !account.is_abandoned
      )

      let cooldownSeconds = 0
      if (account.auto_enable_at) {
        const enableAt = new Date(account.auto_enable_at).getTime()
        const now = Date.now()
        cooldownSeconds = Math.max(0, Math.ceil((enableAt - now) / 1000))
      }

      const remainingQuota = isActive
        ? effectiveRemainingAmount({
            rollingUsage: account.rolling_usage,
            weeklyUsage: account.weekly_usage,
            monthlyUsage: account.monthly_usage
          })
        : null

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

    return {
      total: allAccounts.length,
      active: accounts.length,
      accounts: accountsStatus
    }
  } catch (error) {
    console.error('Failed to get account status:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to retrieve account status'
    })
  }
})
