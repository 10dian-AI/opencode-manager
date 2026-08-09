export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const result = await deleteManagedNonMemberAccounts()
  return { ok: true, deleted: result.changes }
})
