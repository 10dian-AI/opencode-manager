export default defineTask({
  meta: {
    name: 'refresh-error-accounts',
    description: 'Aggressively retry accounts in error state every minute tick (effective ~5 s via polling schedule)'
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
