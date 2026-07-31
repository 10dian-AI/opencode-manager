export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const entries = await listPublicIpPoolEntries()
  return {
    entries,
    block_size: await getIpPoolBlockSize(),
    assigned_accounts: entries.reduce((sum, entry) => sum + entry.account_count, 0)
  }
})
