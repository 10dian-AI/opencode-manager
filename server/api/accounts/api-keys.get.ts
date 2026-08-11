import { listAccounts } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const accounts = await listAccounts()

  // Filter accounts with available monthly quota
  const accountsWithQuota = await Promise.all(
    accounts
      .filter(account =>
        account.status === 'active' &&
        account.subscription_status === 'active' &&
        account.upstream_api_key
      )
      .map(async (account) => {
        // Calculate remaining monthly quota
        const monthlyLimit = 100 // Assuming $100 monthly limit
        const weeklyUsage = account.weekly_usage || 0
        const monthlyRemaining = Math.max(0, monthlyLimit - weeklyUsage)

        if (monthlyRemaining > 0) {
          return {
            id: account.id,
            name: account.name || account.email || `账号 #${account.id}`,
            api_key: account.upstream_api_key,
            monthly_remaining: monthlyRemaining
          }
        }
        return null
      })
  )

  const validAccounts = accountsWithQuota.filter(acc => acc !== null)

  return {
    total: validAccounts.length,
    accounts: validAccounts
  }
})
