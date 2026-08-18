export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const query = getQuery(event)
  const requestedLimit = Number(query.limit)
  const requestedOffset = Number(query.offset)
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 500)
    : 50
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0
  const operation = query.operation ? String(query.operation) : undefined
  const status = query.status ? String(query.status) : undefined

  const [logs, total] = await Promise.all([
    getOperationLogs({ limit, offset, operation, status }),
    countOperationLogs({ operation, status })
  ])

  return { logs, total, limit, offset }
})
