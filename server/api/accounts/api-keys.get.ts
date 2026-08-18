import { QUOTA_LIMITS_USD, remainingAmount } from '../../utils/quota'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const accounts = await listAccounts()
  const validAccounts = accounts
    .filter(account =>
      !account.is_abandoned &&
      account.status === 'active' &&
      account.subscription_status === 'active' &&
      Boolean(account.upstream_api_key) &&
      remainingAmount(account.monthly_usage, QUOTA_LIMITS_USD.monthly) > 0
    )
    .map(account => ({
      id: account.id,
      name: account.name || account.email || `账号 #${account.id}`,
      api_key: account.upstream_api_key!,
      monthly_remaining: remainingAmount(account.monthly_usage, QUOTA_LIMITS_USD.monthly)
    }))

  return {
    total: validAccounts.length,
    accounts: validAccounts
  }
})
