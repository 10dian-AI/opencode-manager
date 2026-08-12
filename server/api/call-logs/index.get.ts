export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const query = getQuery(event)
  const parseOptionalInteger = (value: unknown, name: string, options: {
    min?: number
    max?: number
  } = {}) => {
    if (value === undefined || value === '') return undefined
    const parsed = Number(value)
    if (
      !Number.isInteger(parsed) ||
      (options.min !== undefined && parsed < options.min) ||
      (options.max !== undefined && parsed > options.max)
    ) {
      throw createError({ statusCode: 400, statusMessage: `Invalid ${name}` })
    }
    return parsed
  }

  const searchParams: CallLogQuery = {
    limit: parseOptionalInteger(query.limit, 'limit', { min: 1, max: 500 }) ?? 50,
    offset: parseOptionalInteger(query.offset, 'offset', { min: 0 }) ?? 0
  }

  const apiKeyId = parseOptionalInteger(query.apiKeyId, 'API key ID', { min: 1 })
  const accountId = parseOptionalInteger(query.accountId, 'account ID', { min: 1 })
  const statusCode = parseOptionalInteger(query.statusCode, 'status code', { min: 100, max: 599 })
  if (apiKeyId !== undefined) searchParams.apiKeyId = apiKeyId
  if (accountId !== undefined) searchParams.accountId = accountId
  if (statusCode !== undefined) searchParams.statusCode = statusCode
  if (query.modelName) searchParams.modelName = String(query.modelName).slice(0, 200)
  if (query.callerIp) searchParams.callerIp = String(query.callerIp).slice(0, 200)
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
