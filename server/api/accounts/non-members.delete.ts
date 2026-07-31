export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const result = await deleteNonMemberAccounts()
  await rebuildAccountPollSchedule()
  return { ok: true, deleted: result.changes }
})
