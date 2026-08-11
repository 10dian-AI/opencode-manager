import { refreshAllAccounts, toPublicAccount } from '~/server/utils/accounts'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const accounts = await refreshAllAccounts()
  return accounts.map(toPublicAccount)
})
