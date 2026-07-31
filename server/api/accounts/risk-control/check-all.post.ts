export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const results = await checkAllAccountRiskControls()
  return results.map(result => ({ ...result, account: toPublicAccount(result.account) }))
})
