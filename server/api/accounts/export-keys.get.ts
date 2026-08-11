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
          return account.upstream_api_key
        }
        return null
      })
  )

  const validKeys = accountsWithQuota.filter(key => key !== null)

  // Generate TXT content
  const txtContent = validKeys.join('\n')

  // Set headers for file download
  setHeader(event, 'Content-Type', 'text/plain')
  setHeader(event, 'Content-Disposition', `attachment; filename="api-keys-${Date.now()}.txt"`)

  return txtContent
})
