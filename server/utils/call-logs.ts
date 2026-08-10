import type { SqlClient } from './db'
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
  created_at: string
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS call_logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    api_key_id BIGINT,
    api_key_prefix TEXT,
    model_name TEXT,
    account_id BIGINT,
    account_name TEXT,
    is_stream BOOLEAN NOT NULL DEFAULT false,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cached_prompt_tokens INTEGER,
    created_prompt_tokens INTEGER,
    throughput DOUBLE PRECISION,
    first_token_time_ms INTEGER,
    response_time_ms INTEGER,
    caller_ip TEXT,
    status_code INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_call_logs_timestamp ON call_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_call_logs_api_key_id ON call_logs(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_call_logs_account_id ON call_logs(account_id);
  CREATE INDEX IF NOT EXISTS idx_call_logs_model_name ON call_logs(model_name);
  CREATE INDEX IF NOT EXISTS idx_call_logs_status_code ON call_logs(status_code);
`

let schemaInitialized = false

async function ensureSchema() {
  if (schemaInitialized) return
  const client = await getDb()
  await client.query('SELECT pg_advisory_lock($1)', [4_517_923_002])
  try {
    await client.query(SCHEMA_SQL)
    schemaInitialized = true
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [4_517_923_002])
  }
}

export async function createCallLog(log: Omit<CallLog, 'id' | 'created_at'>): Promise<void> {
  await ensureSchema()
  const client = await getDb()
  await client.query(
    `INSERT INTO call_logs (
      timestamp, api_key_id, api_key_prefix, model_name, account_id, account_name,
      is_stream, prompt_tokens, completion_tokens, cached_prompt_tokens,
      created_prompt_tokens, throughput, first_token_time_ms, response_time_ms,
      caller_ip, status_code, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
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
      log.error_message
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

export async function queryCallLogs(query: CallLogQuery): Promise<{ logs: CallLog[]; total: number }> {
  await ensureSchema()
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
      conditions.push(`error_message IS NOT NULL`)
    } else {
      conditions.push(`error_message IS NULL`)
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

  const limit = query.limit || 50
  const offset = query.offset || 0
  paramCount++
  values.push(limit)
  paramCount++
  values.push(offset)

  const logs = await client.query<CallLog>(
    `SELECT * FROM call_logs ${whereClause} ORDER BY timestamp DESC LIMIT $${paramCount - 1} OFFSET $${paramCount}`,
    values
  )

  return { logs: logs.rows, total }
}

export async function deleteOldCallLogs(daysToKeep = 30): Promise<number> {
  await ensureSchema()
  const client = await getDb()
  const result = await client.query(
    `DELETE FROM call_logs WHERE timestamp < now() - ($1 || ' days')::interval`,
    [String(daysToKeep)]
  )
  return result.rowCount
}
