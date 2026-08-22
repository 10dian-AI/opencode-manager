export default defineTask({
  meta: {
    name: 'check-proxy-health',
    description: 'Ping proxy pool nodes and switch accounts away from degraded nodes'
  },
  async run() {
    const { runProxyHealthCheck } = await import('../utils/proxy-health')
    const outcome = await runProxyHealthCheck()
    return {
      result: {
        checked: outcome.checked,
        down: outcome.results.filter(result => result.health === 'down').length,
        recovered: outcome.results.filter(result => result.recovered).length,
        reassigned: outcome.changes.length
      }
    }
  }
})
