export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const eligibleIds = (await listAccounts())
    .filter(account =>
      Boolean(account.auth_cookie) &&
      Boolean(account.workspace_id) &&
      account.disabled_reason !== 'manual'
    )
    .map(account => account.id)

  const results = await syncAccountChineseModelsStatusesByIds(eligibleIds)
  return {
    total: results.length,
    synchronized: results.filter(result => result.synchronized).length,
    failed: results.filter(result => !result.synchronized).length,
    failures: results
      .filter(result => !result.synchronized)
      .map(result => ({ account_id: result.account.id, message: result.message }))
  }
})
