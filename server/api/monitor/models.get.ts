export default defineEventHandler(async () => {
  // Get logs from last 5 hours
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()

  const result = await queryCallLogs({
    startTime: fiveHoursAgo,
    limit: 10000 // Get all logs from last 5 hours
  })

  // Group by model and calculate success rate
  const modelStats: Record<string, { total: number; success: number; errors: number }> = {}

  for (const log of result.logs) {
    const model = log.model_name || 'unknown'
    if (!modelStats[model]) {
      modelStats[model] = { total: 0, success: 0, errors: 0 }
    }
    modelStats[model].total++
    if (log.status_code && log.status_code >= 200 && log.status_code < 300) {
      modelStats[model].success++
    } else {
      modelStats[model].errors++
    }
  }

  // Convert to array with success rate
  const models = Object.entries(modelStats).map(([model, stats]) => ({
    model,
    total: stats.total,
    success: stats.success,
    errors: stats.errors,
    success_rate: stats.total > 0 ? (stats.success / stats.total) * 100 : 0
  }))

  return {
    period_hours: 5,
    models: models.sort((a, b) => b.total - a.total)
  }
})
