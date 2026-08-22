import { getDb } from './db'

export interface CallLog {
  id: number
  timestamp: string
  api_key_id: number | null
  api_key_prefix: string | null
  model_name: string | null
  account_id: number | null
  account_name: string | null
  is_stream: boolean
  prompt_tokens: number | null
  completion_tokens: number | null
  cached_prompt_tokens: number | null
  created_prompt_tokens: number | null
  throughput: number | null
  first_token_time_ms: number | null
  response_time_ms: number | null
  caller_ip: string | null
  status_code: number | null
  error_message: string | null
  request_detail: string | null
  response_detail: string | null
  created_at: string
}

export interface CallLogSummary extends Omit<CallLog, 'request_detail' | 'response_detail'> {
  has_request_detail: boolean
  has_response_detail: boolean
}

export async function createCallLog(log: Omit<CallLog, 'id' | 'created_at'>): Promise<void> {
  const client = await getDb()
  await client.query(
    `INSERT INTO call_logs (
      timestamp, api_key_id, api_key_prefix, model_name, account_id, account_name,
      is_stream, prompt_tokens, completion_tokens, cached_prompt_tokens,
      created_prompt_tokens, throughput, first_token_time_ms, response_time_ms,
      caller_ip, status_code, error_message, request_detail, response_detail
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      log.timestamp,
      log.api_key_id,
      log.api_key_prefix,
      log.model_name,
      log.account_id,
      log.account_name,
      log.is_stream,
      log.prompt_tokens,
      log.completion_tokens,
      log.cached_prompt_tokens,
      log.created_prompt_tokens,
      log.throughput,
      log.first_token_time_ms,
      log.response_time_ms,
      log.caller_ip,
      log.status_code,
      log.error_message,
      log.request_detail,
      log.response_detail
    ]
  )
}

export interface CallLogQuery {
  apiKeyId?: number
  accountId?: number
  modelName?: string
  callerIp?: string
  statusCode?: number
  isStream?: boolean
  hasError?: boolean
  startTime?: string
  endTime?: string
  limit?: number
  offset?: number
}

export async function queryCallLogs(query: CallLogQuery): Promise<{ logs: CallLogSummary[]; total: number }> {
  const client = await getDb()

  const conditions: string[] = []
  const values: unknown[] = []
  let paramCount = 0

  if (query.apiKeyId !== undefined) {
    paramCount++
    conditions.push(`api_key_id = $${paramCount}`)
    values.push(query.apiKeyId)
  }

  if (query.accountId !== undefined) {
    paramCount++
    conditions.push(`account_id = $${paramCount}`)
    values.push(query.accountId)
  }

  if (query.modelName) {
    paramCount++
    conditions.push(`model_name ILIKE $${paramCount}`)
    values.push(`%${query.modelName}%`)
  }

  if (query.callerIp) {
    paramCount++
    conditions.push(`caller_ip ILIKE $${paramCount}`)
    values.push(`%${query.callerIp}%`)
  }

  if (query.statusCode !== undefined) {
    paramCount++
    conditions.push(`status_code = $${paramCount}`)
    values.push(query.statusCode)
  }

  if (query.isStream !== undefined) {
    paramCount++
    conditions.push(`is_stream = $${paramCount}`)
    values.push(query.isStream)
  }

  if (query.hasError !== undefined) {
    if (query.hasError) {
      conditions.push(`(error_message IS NOT NULL OR status_code >= 400)`)
    } else {
      conditions.push(`(error_message IS NULL AND (status_code IS NULL OR status_code < 400))`)
    }
  }

  if (query.startTime) {
    paramCount++
    conditions.push(`timestamp >= $${paramCount}`)
    values.push(query.startTime)
  }

  if (query.endTime) {
    paramCount++
    conditions.push(`timestamp <= $${paramCount}`)
    values.push(query.endTime)
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await client.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM call_logs ${whereClause}`,
    values
  )
  const total = countResult.rows[0]?.count || 0

  const limit = Math.min(500, Math.max(1, query.limit ?? 50))
  const offset = Math.max(0, query.offset ?? 0)
  paramCount++
  values.push(limit)
  paramCount++
  values.push(offset)

  const logs = await client.query<CallLogSummary>(
    `SELECT
       id, timestamp, api_key_id, api_key_prefix, model_name, account_id, account_name,
       is_stream, prompt_tokens, completion_tokens, cached_prompt_tokens, created_prompt_tokens,
       throughput, first_token_time_ms, response_time_ms, caller_ip, status_code, error_message,
       created_at,
       (request_detail IS NOT NULL AND request_detail <> '') AS has_request_detail,
       (response_detail IS NOT NULL AND response_detail <> '') AS has_response_detail
     FROM call_logs ${whereClause}
     ORDER BY timestamp DESC LIMIT $${paramCount - 1} OFFSET $${paramCount}`,
    values
  )

  return { logs: logs.rows, total }
}

export async function getCallLogById(id: number): Promise<CallLog | undefined> {
  const client = await getDb()
  const result = await client.query<CallLog>(
    `SELECT * FROM call_logs WHERE id = $1 LIMIT 1`,
    [id]
  )
  return result.rows[0]
}

export async function deleteOldCallLogs(daysToKeep = 30): Promise<number> {
  const client = await getDb()
  const result = await client.query(
    `DELETE FROM call_logs WHERE timestamp < now() - ($1 || ' days')::interval`,
    [String(daysToKeep)]
  )
  return result.rowCount
}
