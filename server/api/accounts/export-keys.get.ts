import { QUOTA_LIMITS_USD, remainingAmount } from '../../utils/quota'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const validKeys = (await listAccounts())
    .filter(account =>
      !account.is_abandoned &&
      account.status === 'active' &&
      account.subscription_status === 'active' &&
      Boolean(account.upstream_api_key) &&
      remainingAmount(account.monthly_usage, QUOTA_LIMITS_USD.monthly) > 0
    )
    .map(account => account.upstream_api_key!)

  setHeader(event, 'Content-Type', 'text/plain')
  setHeader(event, 'Content-Disposition', `attachment; filename="api-keys-${Date.now()}.txt"`)

  return validKeys.join('\n')
})
