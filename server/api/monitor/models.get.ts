export default defineEventHandler(async () => {
  // Get logs from last 5 hours. queryCallLogs caps page size at 500, so use
  // the database aggregate path below instead of silently truncating results.
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
  const db = await getDb()
  const { rows } = await db.query<{
    model: string | null
    total: number
    success: number
  }>(`
    SELECT
      model_name AS model,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE status_code >= 200 AND status_code < 300
      )::int AS success
    FROM call_logs
    WHERE timestamp >= $1
    GROUP BY model_name
    ORDER BY total DESC
  `, [fiveHoursAgo])

  const models = rows.map(row => ({
    model: row.model || 'unknown',
    total: Number(row.total),
    success: Number(row.success),
    errors: Number(row.total) - Number(row.success),
    success_rate: Number(row.total) > 0
      ? (Number(row.success) / Number(row.total)) * 100
      : 0
  }))

  return {
    period_hours: 5,
    models
  }
})
