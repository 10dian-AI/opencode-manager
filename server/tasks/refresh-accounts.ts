export default defineTask({
  meta: {
    name: 'refresh-accounts',
    description: 'Refresh OpenCode accounts at quota reset nodes and optionally retry failed refreshes'
  },
  async run() {
    const results = await refreshDueAccounts()
    return {
      result: {
        count: results.length,
        active: results.filter(a => a.status === 'active').length,
        error: results.filter(a => a.status === 'error').length
      }
    }
  }
})
