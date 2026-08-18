export default defineTask({
  meta: {
    name: 'refresh-error-accounts',
    description: 'Fallback retry for error accounts on each minute tick; in-process retries run after about 5 seconds'
  },
  async run() {
    const results = await withAdvisoryLock(
      'scheduled-task:refresh-error-accounts',
      refreshDueErrorAccounts,
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
