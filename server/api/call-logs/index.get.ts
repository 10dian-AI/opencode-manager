import { requireAuth } from '~/server/utils/auth'
import { queryCallLogs } from '~/server/utils/call-logs'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const query = getQuery(event)

  const searchParams: any = {
    limit: query.limit ? Number(query.limit) : 50,
    offset: query.offset ? Number(query.offset) : 0
  }

  if (query.apiKeyId) searchParams.apiKeyId = Number(query.apiKeyId)
  if (query.accountId) searchParams.accountId = Number(query.accountId)
  if (query.modelName) searchParams.modelName = String(query.modelName)
  if (query.callerIp) searchParams.callerIp = String(query.callerIp)
  if (query.statusCode) searchParams.statusCode = Number(query.statusCode)
  if (query.isStream !== undefined) searchParams.isStream = query.isStream === 'true'
  if (query.hasError !== undefined) searchParams.hasError = query.hasError === 'true'
  if (query.startTime) searchParams.startTime = String(query.startTime)
  if (query.endTime) searchParams.endTime = String(query.endTime)

  const result = await queryCallLogs(searchParams)

  return {
    logs: result.logs,
    total: result.total,
    limit: searchParams.limit,
    offset: searchParams.offset
  }
})
