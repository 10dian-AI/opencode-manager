export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const [entries, blockSize, healthSettings] = await Promise.all([
    listPublicIpPoolEntries(),
    getIpPoolBlockSize(),
    getProxyHealthSettings()
  ])
  return {
    entries,
    block_size: blockSize,
    threshold_ms: healthSettings.threshold_ms,
    check_url: healthSettings.check_url,
    assigned_accounts: entries.reduce((sum, entry) => sum + entry.account_count, 0)
  }
})
