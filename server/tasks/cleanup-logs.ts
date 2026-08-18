function retentionDays(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export default defineTask({
  meta: {
    name: 'cleanup-logs',
    description: 'Delete expired call and operation logs according to retention settings'
  },
  async run() {
    const callLogDays = retentionDays(process.env.CALL_LOG_RETENTION_DAYS, 30)
    const operationLogDays = retentionDays(process.env.OPERATION_LOG_RETENTION_DAYS, 90)
    const result = await withAdvisoryLock(
      'scheduled-task:cleanup-logs',
      async () => {
        const [callLogs, operationLogs] = await Promise.all([
          deleteOldCallLogs(callLogDays),
          deleteOldOperationLogs(operationLogDays)
        ])
        return { callLogs, operationLogs }
      },
      { wait: false }
    )
    return {
      result: result || { callLogs: 0, operationLogs: 0 }
    }
  }
})
