export default defineTask({
  meta: {
    name: 'refresh-accounts',
    description: 'Refresh OpenCode accounts at quota reset nodes and optionally retry failed refreshes'
  },
  async run() {
    await cleanExpiredSessions()
    const results = await withAdvisoryLock(
      'scheduled-task:refresh-accounts',
      refreshDueAccounts,
      { wait: false }
    ) || []
    return {
      result: {
        count: results.length,
        active: results.filter(a => a.status === 'active').length,
        error: results.filter(a => a.status === 'error').length
      }
    }
  }
})
