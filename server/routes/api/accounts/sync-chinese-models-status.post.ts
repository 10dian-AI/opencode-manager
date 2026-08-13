export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const accounts = await listAccounts()
  const eligibleAccounts = accounts.filter(
    account =>
      account.auth_cookie &&
      account.workspace_id &&
      account.disabled_reason !== 'manual'
  )

  let synchronized = 0
  let failed = 0

  for (const account of eligibleAccounts) {
    try {
      await refreshAccount(account.id, { throwOnError: false })
      synchronized++
    } catch (error) {
      failed++
      console.error(`Failed to sync chinese models status for account ${account.id}:`, error)
    }
  }

  return {
    total: eligibleAccounts.length,
    synchronized,
    failed
  }
})
