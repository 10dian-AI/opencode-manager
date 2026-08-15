import { getDb } from './db'

export interface OperationLogEntry {
  operation: string
  trigger_type: 'manual' | 'api' | 'scheduled'
  account_id?: number | null
  // 数据库 account_ids 列存的是 JSON 字符串（数组序列化），不是数组本身。
  // 读取时经 getOperationLogs 的 account_ids_parsed 做防御性 JSON.parse。
  account_ids?: string | null
  status: 'success' | 'error' | 'partial'
  detail?: string | null
  error_message?: string | null
  blocked_at?: string | null
  duration_ms?: number | null
}

export interface OperationLog extends OperationLogEntry {
  id: number
  account_ids: string | null
  created_at: string
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS operation_logs (
    id BIGSERIAL PRIMARY KEY,
    operation TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    account_id BIGINT,
    account_ids TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    error_message TEXT,
    blocked_at TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`

let schemaInitialized = false

async function ensureSchema() {
  if (schemaInitialized) return
  const db = await getDb()
  await db.query(SCHEMA_SQL)
  schemaInitialized = true
}

export async function logOperation(opts: OperationLogEntry): Promise<void> {
  try {
    await ensureSchema()
    const db = await getDb()
    const accountIdsJson = opts.account_ids || null
    await db.query(
      `INSERT INTO operation_logs
        (operation, trigger_type, account_id, account_ids, status, detail, error_message, blocked_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        opts.operation,
        opts.trigger_type,
        opts.account_id ?? null,
        accountIdsJson,
        opts.status,
        opts.detail ?? null,
        opts.error_message ?? null,
        opts.blocked_at ?? null,
        opts.duration_ms ?? null
      ]
    )
  } catch (error) {
    // Log failures must never break the calling operation.
    console.error('Failed to write operation log:', error)
  }
}

export async function getOperationLogs(opts: {
  limit?: number
  offset?: number
  operation?: string
  status?: string
} = {}): Promise<Array<OperationLog & { account_ids_parsed: number[] | null }>> {
  await ensureSchema()
  const db = await getDb()
  const limit = Math.min(opts.limit ?? 50, 500)
  const offset = opts.offset ?? 0
  const values: unknown[] = [limit, offset]
  const conditions: string[] = []
  if (opts.operation) {
    values.push(opts.operation)
    conditions.push(`operation = $${values.length}`)
  }
  if (opts.status) {
    values.push(opts.status)
    conditions.push(`status = $${values.length}`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const { rows } = await db.query<OperationLog>(
    `SELECT * FROM operation_logs ${where} ORDER BY id DESC LIMIT $1 OFFSET $2`,
    values
  )
  return rows.map(row => ({
    ...row,
    account_ids_parsed: row.account_ids ? (() => { try { return JSON.parse(row.account_ids) } catch { return null } })() : null
  }))
}

export async function countOperationLogs(opts: { operation?: string; status?: string } = {}): Promise<number> {
  await ensureSchema()
  const db = await getDb()
  const values: unknown[] = []
  const conditions: string[] = []
  if (opts.operation) {
    values.push(opts.operation)
    conditions.push(`operation = $${values.length}`)
  }
  if (opts.status) {
    values.push(opts.status)
    conditions.push(`status = $${values.length}`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const { rows } = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM operation_logs ${where}`, values)
  return Number(rows[0]?.count ?? 0)
}
