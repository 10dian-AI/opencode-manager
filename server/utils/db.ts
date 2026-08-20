import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { normalizeStoredAuthCookieValue, validateAuthCookieValue } from './auth-cookie'

export type AccountStatus = 'pending' | 'active' | 'error' | 'disabled'

export interface Account {
  id: number
  name: string | null
  auth_cookie: string
  email: string | null
  workspace_id: string | null
  workspace_name: string | null
  balance: number | null
  rolling_usage: number | null
  rolling_reset_sec: number | null
  weekly_usage: number | null
  weekly_reset_sec: number | null
  monthly_usage: number | null
  monthly_reset_sec: number | null
  rolling_reset_at: string | null
  weekly_reset_at: string | null
  monthly_reset_at: string | null
  next_quota_refresh_at: string | null
  quota_refreshed_at: string | null
  referral_code: string | null
  last_referral_reward_id: string | null
  last_referral_reward_applied_at: string | null
  subscription_status: string | null
  cancelled_subscription_id: string | null
  subscription_cancelled_at: string | null
  subscription_cancel_checked_at: string | null
  subscription_ends_at: string | null
  subscription_cancel_error: string | null
  chinese_models_enabled_at: string | null
  chinese_models_enable_error: string | null
  chinese_models_checked_at: string | null
  chinese_models_manual_off_at: string | null
  upstream_api_key: string | null
  ip_pool_id: number | null
  status: AccountStatus
  disabled_reason: string | null
  is_abandoned: boolean
  abandoned_reason: string | null
  auto_enable_at: string | null
  risk_control_checked_at: string | null
  risk_control_detected_at: string | null
  last_error: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export type AccountPublic = Omit<Account, 'auth_cookie' | 'upstream_api_key' | 'cancelled_subscription_id'> & {
  has_upstream_api_key: boolean
}

export interface ManagedApiKey {
  id: number
  name: string
  key_hash: string
  key_prefix: string
  affinity_enabled: boolean
  created_at: string
}

export interface IpPoolEntry {
  id: number
  name: string | null
  proxy_url: string
  enabled: boolean
  last_ip: string | null
  last_check_ok: boolean | null
  last_checked_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface QueryResult<T> {
  rows: T[]
  rowCount: number
}

export interface SqlClient {
  query<T = any>(text: string, values?: unknown[]): Promise<QueryResult<T>>
}

interface PoolLike extends SqlClient {
  connect(): Promise<PoolClientLike>
  end(): Promise<void>
  on(event: 'error', listener: (error: Error) => void): unknown
}

interface PoolClientLike extends SqlClient {
  release(): void
}

/**
 * Column names are only ever taken from the Account keys below, never from
 * request input, so dynamic UPDATE statements cannot be used for injection.
 */
const ACCOUNT_COLUMNS = new Set<string>([
  'name',
  'auth_cookie',
  'email',
  'workspace_id',
  'workspace_name',
  'balance',
  'rolling_usage',
  'rolling_reset_sec',
  'weekly_usage',
  'weekly_reset_sec',
  'monthly_usage',
  'monthly_reset_sec',
  'rolling_reset_at',
  'weekly_reset_at',
  'monthly_reset_at',
  'next_quota_refresh_at',
  'quota_refreshed_at',
  'referral_code',
  'last_referral_reward_id',
  'last_referral_reward_applied_at',
  'subscription_status',
  'cancelled_subscription_id',
  'subscription_cancelled_at',
  'subscription_cancel_checked_at',
  'subscription_ends_at',
  'subscription_cancel_error',
  'chinese_models_enabled_at',
  'chinese_models_enable_error',
  'chinese_models_checked_at',
  'chinese_models_manual_off_at',
  'upstream_api_key',
  'ip_pool_id',
  'status',
  'disabled_reason',
  'is_abandoned',
  'abandoned_reason',
  'auto_enable_at',
  'risk_control_checked_at',
  'risk_control_detected_at',
  'last_error',
  'last_synced_at'
])

const runtimeRequire = createRequire(
  process.argv[1] ? resolve(process.argv[1]) : resolve(process.cwd(), 'index.js')
)

let pool: PoolLike | null = null
let lockPool: PoolLike | null = null
let readyPromise: Promise<PoolLike> | null = null

/** Lets other modules that write to accounts directly drop the proxy pool cache. */
export function invalidateAccountCaches() {
  // Candidate reads are intentionally uncached so multiple app instances see
  // account state changes immediately.
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function buildPool(max = positiveInteger(process.env.POSTGRES_POOL_MAX, 20)): PoolLike {
  const { Pool, types } = runtimeRequire('pg') as {
    Pool: new (config: Record<string, unknown>) => PoolLike
    types: { setTypeParser(oid: number, parser: (value: string) => unknown): void }
  }

  // Keep timestamps and numerics as the ISO strings / JS numbers the app expects.
  types.setTypeParser(1114, value => `${value.replace(' ', 'T')}Z`)
  types.setTypeParser(1184, value => new Date(value).toISOString())
  types.setTypeParser(1700, value => Number(value))
  types.setTypeParser(20, value => Number(value))

  const connectionString = process.env.DATABASE_URL
  if (!connectionString && !process.env.POSTGRES_HOST) {
    throw new Error(
      'Database configuration missing: Set DATABASE_URL or POSTGRES_HOST environment variable'
    )
  }

  const ssl = /^(1|true|require)$/i.test(process.env.DATABASE_SSL || '')
    ? {
        rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
        ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA } : {})
      }
    : undefined

  const config: Record<string, unknown> = connectionString
    ? { connectionString, ssl }
    : {
        host: process.env.POSTGRES_HOST || '127.0.0.1',
        port: positiveInteger(process.env.POSTGRES_PORT, 5432),
        user: process.env.POSTGRES_USER || 'opencode',
        password: process.env.POSTGRES_PASSWORD || '',
        database: process.env.POSTGRES_DB || 'opencode_manager',
        ssl
      }

  config.max = max
  config.idleTimeoutMillis = positiveInteger(process.env.POSTGRES_IDLE_TIMEOUT_MS, 30_000)
  config.connectionTimeoutMillis = positiveInteger(process.env.POSTGRES_CONNECT_TIMEOUT_MS, 10_000)

  const created = new Pool(config)
  created.on('error', (error) => {
    // Log idle client errors for monitoring purposes
    console.error('Database pool idle client error:', error)
    // Idle client failures are recoverable; the pool creates a new connection on demand.
  })
  return created
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS accounts (
    id BIGSERIAL PRIMARY KEY,
    name TEXT,
    auth_cookie TEXT NOT NULL,
    email TEXT,
    workspace_id TEXT,
    workspace_name TEXT,
    balance DOUBLE PRECISION,
    rolling_usage DOUBLE PRECISION,
    rolling_reset_sec BIGINT,
    weekly_usage DOUBLE PRECISION,
    weekly_reset_sec BIGINT,
    monthly_usage DOUBLE PRECISION,
    monthly_reset_sec BIGINT,
    rolling_reset_at TEXT,
    weekly_reset_at TEXT,
    monthly_reset_at TEXT,
    next_quota_refresh_at TEXT,
    quota_refreshed_at TEXT,
    referral_code TEXT,
    last_referral_reward_id TEXT,
    last_referral_reward_applied_at TEXT,
    subscription_status TEXT,
    cancelled_subscription_id TEXT,
    subscription_cancelled_at TEXT,
    subscription_cancel_checked_at TEXT,
    subscription_ends_at TEXT,
    subscription_cancel_error TEXT,
    chinese_models_enabled_at TEXT,
    chinese_models_enable_error TEXT,
    chinese_models_checked_at TEXT,
    chinese_models_manual_off_at TEXT,
    upstream_api_key TEXT,
    ip_pool_id BIGINT,
    status TEXT NOT NULL DEFAULT 'pending',
    disabled_reason TEXT,
    is_abandoned BOOLEAN NOT NULL DEFAULT FALSE,
    abandoned_reason TEXT,
    auto_enable_at TEXT,
    risk_control_checked_at TEXT,
    risk_control_detected_at TEXT,
    last_error TEXT,
    last_synced_at TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    affinity_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS ip_pool (
    id BIGSERIAL PRIMARY KEY,
    name TEXT,
    proxy_url TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_ip TEXT,
    last_check_ok BOOLEAN,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS call_logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    api_key_id BIGINT,
    api_key_prefix TEXT,
    model_name TEXT,
    account_id BIGINT,
    account_name TEXT,
    is_stream BOOLEAN NOT NULL DEFAULT FALSE,
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
    request_detail TEXT,
    response_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS auth_login_attempts (
    identifier TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    blocked_until TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS account_proxy_slots (
    account_id BIGINT NOT NULL,
    slot INTEGER NOT NULL,
    lease_token TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, slot)
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_ip_pool_id ON accounts(ip_pool_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_proxy_pool
    ON accounts(id) WHERE status = 'active' AND subscription_status = 'active';
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_call_logs_timestamp ON call_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_call_logs_api_key_id ON call_logs(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_call_logs_account_id ON call_logs(account_id);
  CREATE INDEX IF NOT EXISTS idx_call_logs_model_name ON call_logs(model_name);
  CREATE INDEX IF NOT EXISTS idx_call_logs_status_code ON call_logs(status_code);
  CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_blocked_until
    ON auth_login_attempts(blocked_until);

  CREATE TABLE IF NOT EXISTS operation_logs (
    id BIGSERIAL PRIMARY KEY,
    operation TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    account_id BIGINT,
    account_ids TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    error_message TEXT,
    request_detail TEXT,
    response_detail TEXT,
    blocked_at TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_operation_logs_operation ON operation_logs(operation);
  CREATE INDEX IF NOT EXISTS idx_operation_logs_status ON operation_logs(status);
`

async function initializeSchema(client: SqlClient) {
  // A session-level advisory lock keeps concurrent boots from racing on DDL.
  await client.query('SELECT pg_advisory_lock($1)', [4_517_923_001])
  try {
    await client.query(SCHEMA_SQL)
    await client.query(`
      ALTER TABLE accounts
      DROP CONSTRAINT IF EXISTS accounts_ip_pool_id_fkey
    `)
    await client.query(`
      ALTER TABLE accounts
      ADD CONSTRAINT accounts_ip_pool_id_fkey
      FOREIGN KEY (ip_pool_id) REFERENCES ip_pool(id) ON DELETE SET NULL
    `)
    await migrateAccountsSchema(client)
    // 一次性回填抛弃账号标记（幂等，每次启动都会运行；手动标记的账号永不被动改）。
    // 注意：disabled_reason 可能为 NULL，(expr) IS TRUE 保证表达式永不返回 NULL，
    // 否则 `NULL OR FALSE = NULL` 会写进 NOT NULL 的 is_abandoned 列导致启动崩溃。
    await client.query(`
      UPDATE accounts SET
        is_abandoned = (disabled_reason = 'risk_control') IS TRUE OR (monthly_usage IS NOT NULL AND monthly_usage >= 100),
        abandoned_reason = CASE WHEN abandoned_reason = 'manual' THEN 'manual'
          WHEN disabled_reason = 'risk_control' THEN 'risk_control'
          WHEN (monthly_usage IS NOT NULL AND monthly_usage >= 100) THEN 'monthly_limit'
          ELSE NULL END
      WHERE abandoned_reason IS DISTINCT FROM 'manual'
    `)
    await migrateCallLogsSchema(client)
    await migrateOperationLogsSchema(client)
    await migrateStoredAuthCookieValues(client)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [4_517_923_001])
  }
}

async function migrateAccountsSchema(client: SqlClient) {
  await client.query(`
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS chinese_models_enabled_at TEXT,
      ADD COLUMN IF NOT EXISTS chinese_models_enable_error TEXT,
      ADD COLUMN IF NOT EXISTS chinese_models_checked_at TEXT,
      ADD COLUMN IF NOT EXISTS chinese_models_manual_off_at TEXT,
      ADD COLUMN IF NOT EXISTS is_abandoned BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS abandoned_reason TEXT
  `)
  await client.query(`
    ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS affinity_enabled BOOLEAN NOT NULL DEFAULT FALSE
  `)
}

async function migrateOperationLogsSchema(client: SqlClient) {
  // CREATE TABLE IF NOT EXISTS does not upgrade installations that already
  // have an older operation_logs table, so keep all additive migrations explicit.
  // 对带 DEFAULT 或可空列直接 ADD COLUMN IF NOT EXISTS；无 DEFAULT 的 NOT NULL 列
  // （operation/trigger_type/status）迁移时以可空形式添加，避免旧表已有行时整条
  // ALTER 失败导致应用无法启动（应用侧始终会写入这些字段；新装库由 CREATE TABLE
  // 保持 NOT NULL）。
  await client.query(`
    ALTER TABLE operation_logs
      ADD COLUMN IF NOT EXISTS id BIGINT,
      ADD COLUMN IF NOT EXISTS operation TEXT,
      ADD COLUMN IF NOT EXISTS trigger_type TEXT,
      ADD COLUMN IF NOT EXISTS account_id BIGINT,
      ADD COLUMN IF NOT EXISTS account_ids TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT,
      ADD COLUMN IF NOT EXISTS detail TEXT,
      ADD COLUMN IF NOT EXISTS error_message TEXT,
      ADD COLUMN IF NOT EXISTS blocked_at TEXT,
      ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `)
}

async function migrateCallLogsSchema(client: SqlClient) {
  // CREATE TABLE IF NOT EXISTS does not upgrade installations that already
  // have an older call_logs table, so keep all additive migrations explicit.
  await client.query(`
    ALTER TABLE call_logs
      ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS api_key_id BIGINT,
      ADD COLUMN IF NOT EXISTS api_key_prefix TEXT,
      ADD COLUMN IF NOT EXISTS model_name TEXT,
      ADD COLUMN IF NOT EXISTS account_id BIGINT,
      ADD COLUMN IF NOT EXISTS account_name TEXT,
      ADD COLUMN IF NOT EXISTS is_stream BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER,
      ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
      ADD COLUMN IF NOT EXISTS cached_prompt_tokens INTEGER,
      ADD COLUMN IF NOT EXISTS created_prompt_tokens INTEGER,
      ADD COLUMN IF NOT EXISTS throughput DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS first_token_time_ms INTEGER,
      ADD COLUMN IF NOT EXISTS response_time_ms INTEGER,
      ADD COLUMN IF NOT EXISTS caller_ip TEXT,
      ADD COLUMN IF NOT EXISTS status_code INTEGER,
      ADD COLUMN IF NOT EXISTS error_message TEXT,
      ADD COLUMN IF NOT EXISTS request_detail TEXT,
      ADD COLUMN IF NOT EXISTS response_detail TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `)
}

async function migrateStoredAuthCookieValues(client: SqlClient) {
  const { rows } = await client.query<{ id: number; auth_cookie: string }>(
    'SELECT id, auth_cookie FROM accounts'
  )
  for (const account of rows) {
    const normalized = normalizeStoredAuthCookieValue(account.auth_cookie)
    if (normalized !== account.auth_cookie) {
      await client.query('UPDATE accounts SET auth_cookie = $1 WHERE id = $2', [
        normalized,
        account.id
      ])
    }
  }
}

export function getDb(): Promise<SqlClient> {
  if (pool) return Promise.resolve(pool)
  if (readyPromise) return readyPromise

  const initialization = (async () => {
    const created = buildPool()
    try {
      const client = await created.connect()
      try {
        await initializeSchema(client)
      } finally {
        client.release()
      }
      pool = created
      return created
    } catch (error) {
      await created.end().catch(() => {})
      throw error
    }
  })()

  let guarded!: Promise<PoolLike>
  guarded = initialization.catch(error => {
    if (readyPromise === guarded) readyPromise = null
    pool = null
    throw error
  })
  readyPromise = guarded
  return guarded
}
export async function closeDb() {
  const current = pool
  const currentLocks = lockPool
  pool = null
  lockPool = null
  readyPromise = null
  await Promise.all([
    current?.end(),
    currentLocks?.end()
  ])
}

async function query<T>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
  const client = await getDb()
  return client.query<T>(text, values)
}

async function queryRows<T>(text: string, values?: unknown[]): Promise<T[]> {
  return (await query<T>(text, values)).rows
}

async function queryRow<T>(text: string, values?: unknown[]): Promise<T | undefined> {
  return (await query<T>(text, values)).rows[0]
}

/** PostgreSQL reports unique constraint conflicts with SQLSTATE 23505. */
export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && (error as { code?: string }).code === '23505'
}

export function toPublicAccount(row: Account): AccountPublic {
  const { auth_cookie: _, upstream_api_key, cancelled_subscription_id: __, ...rest } = row
  return { ...rest, has_upstream_api_key: Boolean(upstream_api_key) }
}

export function listAccounts(): Promise<Account[]> {
  return queryRows<Account>('SELECT * FROM accounts ORDER BY id DESC')
}

export function getAccount(id: number): Promise<Account | undefined> {
  return queryRow<Account>('SELECT * FROM accounts WHERE id = $1', [id])
}

/** Fetches many accounts in one round trip, preserving the requested id order. */
export async function getAccountsByIds(ids: number[]): Promise<Account[]> {
  if (!ids.length) return []
  const rows = await queryRows<Account>(
    'SELECT * FROM accounts WHERE id = ANY($1::bigint[])',
    [ids]
  )
  const byId = new Map(rows.map(row => [row.id, row]))
  return ids.map(id => byId.get(id)).filter((row): row is Account => Boolean(row))
}

export async function createAccount(input: {
  name?: string
  auth_cookie: string
  workspace_id?: string
  workspace_name?: string | null
  allow_existing_cookie?: boolean
}): Promise<Account> {
  const authCookie = validateAuthCookieValue(input.auth_cookie)
  if (!input.allow_existing_cookie) {
    const duplicate = await queryRow<{ id: number }>(
      'SELECT id FROM accounts WHERE auth_cookie = $1 LIMIT 1',
      [authCookie]
    )
    if (duplicate) {
      throw createError({ statusCode: 409, statusMessage: 'This auth cookie has already been imported' })
    }
  }
  const created = await queryRow<Account>(
    `INSERT INTO accounts (name, auth_cookie, workspace_id, workspace_name, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [input.name || null, authCookie, input.workspace_id || null, input.workspace_name || null]
  )
  return created!
}

/**
 * Batch imports insert every row in one statement so a 500-cookie paste costs
 * a single round trip instead of 500. Order matches the input array.
 */
export async function createAccounts(
  inputs: Array<{ name?: string; auth_cookie: string }>
): Promise<Account[]> {
  if (!inputs.length) return []
  const names = inputs.map(input => input.name || null)
  const cookies = inputs.map(input => validateAuthCookieValue(input.auth_cookie))
  const existing = await queryRows<{ auth_cookie: string }>(
    'SELECT DISTINCT auth_cookie FROM accounts WHERE auth_cookie = ANY($1::text[])',
    [cookies]
  )
  if (existing.length) {
    throw createError({
      statusCode: 409,
      statusMessage: `${existing.length} auth cookie value(s) have already been imported`
    })
  }
  const rows = await queryRows<Account>(
    `WITH inserted AS (
       INSERT INTO accounts (name, auth_cookie, status)
       SELECT name, auth_cookie, 'pending'
       FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(name, auth_cookie, ord)
       ORDER BY ord
       RETURNING *
     )
     SELECT * FROM inserted ORDER BY id ASC`,
    [names, cookies]
  )
  return rows
}

export async function updateAccount(
  id: number,
  data: Partial<Account>
): Promise<Account | undefined> {
  const assignments: string[] = []
  const values: unknown[] = []

  for (const [key, value] of Object.entries(data)) {
    if (!ACCOUNT_COLUMNS.has(key)) continue
    values.push(key === 'auth_cookie' ? validateAuthCookieValue(value) : value)
    assignments.push(`${key} = $${values.length}`)
  }

  if (!assignments.length) return getAccount(id)

  values.push(id)
  const updated = await queryRow<Account>(
    `UPDATE accounts
     SET ${assignments.join(', ')}, updated_at = now()
     WHERE id = $${values.length}
     RETURNING *`,
    values
  )
  return updated
}

export async function deleteAccount(id: number) {
  const result = await query('DELETE FROM accounts WHERE id = $1', [id])
  return { changes: result.rowCount }
}

export async function deleteAccounts(ids: number[]) {
  if (!ids.length) return { changes: 0 }
  const result = await query('DELETE FROM accounts WHERE id = ANY($1::bigint[])', [ids])
  return { changes: result.rowCount }
}

export async function deleteNonMemberAccounts() {
  const result = await query(
    `DELETE FROM accounts
     WHERE is_abandoned IS NOT TRUE
       AND subscription_status IS NOT NULL
       AND subscription_status <> 'active'`
  )
  return { changes: result.rowCount }
}

export async function getProxyCandidates(): Promise<Account[]> {
  // Order by subscription_ends_at ASC so accounts expiring soonest are
  // preferred; accounts with no known end date come last.
  return queryRows<Account>(`
    SELECT * FROM accounts
    WHERE status = 'active'
      AND subscription_status = 'active'
      AND upstream_api_key IS NOT NULL
      AND upstream_api_key <> ''
      AND is_abandoned IS NOT TRUE
    ORDER BY
      CASE WHEN subscription_ends_at IS NULL THEN 1 ELSE 0 END ASC,
      subscription_ends_at ASC,
      id ASC
  `)
}

export function listManagedApiKeys(): Promise<ManagedApiKey[]> {
  return queryRows<ManagedApiKey>('SELECT * FROM api_keys ORDER BY id DESC')
}

export async function createManagedApiKey(input: {
  name: string
  key_hash: string
  key_prefix: string
}): Promise<ManagedApiKey> {
  const created = await queryRow<ManagedApiKey>(
    `INSERT INTO api_keys (name, key_hash, key_prefix)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.name, input.key_hash, input.key_prefix]
  )
  return created!
}

export async function deleteManagedApiKey(id: number) {
  const result = await query('DELETE FROM api_keys WHERE id = $1', [id])
  return { changes: result.rowCount }
}

export async function updateManagedApiKeyAffinity(id: number, affinity_enabled: boolean): Promise<ManagedApiKey | undefined> {
  return queryRow<ManagedApiKey>(
    `UPDATE api_keys SET affinity_enabled = $1 WHERE id = $2 RETURNING *`,
    [affinity_enabled, id]
  )
}

export async function getManagedApiKeyHashes(): Promise<Set<string>> {
  const rows = await queryRows<{ key_hash: string }>('SELECT key_hash FROM api_keys')
  return new Set(rows.map(row => row.key_hash))
}

export async function getAppSetting(key: string): Promise<string | undefined> {
  const row = await queryRow<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [key]
  )
  return row?.value
}

export async function setAppSetting(key: string, value: string) {
  await query(`
    INSERT INTO app_settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `, [key, value])
}

export async function deleteAppSetting(key: string) {
  await query('DELETE FROM app_settings WHERE key = $1', [key])
}

export async function withAdvisoryLock<T>(
  key: string,
  operation: () => Promise<T>,
  options: { wait?: boolean } = {}
): Promise<T | undefined> {
  return withAdvisoryLocks([key], operation, options)
}

async function withAdvisoryLocks<T>(
  keys: string[],
  operation: () => Promise<T>,
  options: { wait?: boolean } = {}
): Promise<T | undefined> {
  if (!lockPool) {
    lockPool = buildPool(positiveInteger(process.env.POSTGRES_LOCK_POOL_MAX, 20))
  }
  const client = await lockPool.connect()
  const acquired: string[] = []
  try {
    for (const key of keys) {
      if (options.wait === false) {
        const row = (await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
          [key]
        )).rows[0]
        if (!row?.locked) return undefined
      } else {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key])
      }
      acquired.push(key)
    }
    return await operation()
  } finally {
    for (const key of acquired.reverse()) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
        .catch(() => {})
    }
    client.release()
  }
}

export function withAuthCookieLocks<T>(cookies: string[], operation: () => Promise<T>) {
  const keys = [...new Set(cookies)]
    .map(cookie => createHash('sha256').update(cookie).digest('hex'))
    .sort()
    .map(hash => `account-import:${hash}`)
  return withAdvisoryLocks(keys.length ? keys : ['account-import'], operation) as Promise<T>
}

export function withAccountLocks<T>(ids: number[], operation: () => Promise<T>) {
  const keys = [...new Set(ids)].sort((a, b) => a - b).map(id => `account-operation:${id}`)
  return withAdvisoryLocks(keys, operation) as Promise<T>
}

export async function tryAcquireAccountProxySlot(
  accountId: number,
  concurrency: number,
  leaseMs = 11 * 60 * 1000
): Promise<(() => Promise<void>) | null> {
  for (let slot = 0; slot < concurrency; slot++) {
    const leaseToken = randomUUID()
    // Use CTE with SELECT FOR UPDATE to ensure atomic check-and-set
    const acquired = await queryRow<{ lease_token: string }>(`
      WITH available_slot AS (
        SELECT account_id, slot
        FROM account_proxy_slots
        WHERE account_id = $1 AND slot = $2 AND expires_at <= now()
        FOR UPDATE SKIP LOCKED
      )
      INSERT INTO account_proxy_slots (account_id, slot, lease_token, expires_at)
      SELECT $1, $2, $3, now() + ($4 || ' milliseconds')::interval
      WHERE EXISTS (SELECT 1 FROM available_slot)
         OR NOT EXISTS (SELECT 1 FROM account_proxy_slots WHERE account_id = $1 AND slot = $2)
      ON CONFLICT (account_id, slot) DO UPDATE SET
        lease_token = excluded.lease_token,
        expires_at = excluded.expires_at
      WHERE account_proxy_slots.expires_at <= now()
      RETURNING lease_token
    `, [accountId, slot, leaseToken, String(leaseMs)])
    if (!acquired) continue
    let released = false
    return async () => {
      if (released) return
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await query(
            'DELETE FROM account_proxy_slots WHERE account_id = $1 AND slot = $2 AND lease_token = $3',
            [accountId, slot, leaseToken]
          )
          released = true
          return
        } catch {
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
        }
      }
    }
  }
  return null
}

export async function createSession(token: string, hours = 24 * 7) {
  await query(
    `INSERT INTO sessions (token, expires_at)
     VALUES ($1, now() + ($2 || ' hours')::interval)`,
    [token, String(hours)]
  )
}

export function findSession(token: string) {
  return queryRow<{ token: string; created_at: string; expires_at: string }>(
    'SELECT * FROM sessions WHERE token = $1 AND expires_at > now()',
    [token]
  )
}

export async function deleteSession(token: string) {
  await query('DELETE FROM sessions WHERE token = $1', [token])
}

export async function cleanExpiredSessions() {
  await query('DELETE FROM sessions WHERE expires_at <= now()')
  await query(`
    DELETE FROM auth_login_attempts
    WHERE (blocked_until IS NULL AND window_started_at < now() - interval '1 day')
       OR blocked_until < now() - interval '1 day'
  `)
  await query('DELETE FROM account_proxy_slots WHERE expires_at <= now()')
  await query(`
    DELETE FROM app_settings
    WHERE key LIKE 'account_import_progress:%'
      AND (value::jsonb->>'updatedAt')::timestamptz < now() - interval '1 day'
  `)
  await query(`
    DELETE FROM app_settings setting
    WHERE setting.key ~ '^(account_refresh_progress|referral_rewards):[0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM accounts
        WHERE accounts.id = split_part(setting.key, ':', 2)::bigint
      )
  `)
}

export async function checkLoginRateLimit(identifier: string) {
  const row = await queryRow<{ attempts: number; blocked_until: string | null }>(`
    SELECT attempts, blocked_until
    FROM auth_login_attempts
    WHERE identifier = $1
  `, [identifier])
  if (row?.blocked_until && new Date(row.blocked_until).getTime() > Date.now()) {
    throw createError({ statusCode: 429, statusMessage: 'Too many login attempts. Try again later.' })
  }
}

export async function recordLoginFailure(identifier: string) {
  const row = await queryRow<{ attempts: number; blocked_until: string | null }>(`
    INSERT INTO auth_login_attempts (identifier, attempts, window_started_at, blocked_until)
    VALUES ($1, 1, now(), NULL)
    ON CONFLICT (identifier) DO UPDATE SET
      attempts = CASE
        WHEN auth_login_attempts.window_started_at < now() - interval '15 minutes' THEN 1
        ELSE auth_login_attempts.attempts + 1
      END,
      window_started_at = CASE
        WHEN auth_login_attempts.window_started_at < now() - interval '15 minutes' THEN now()
        ELSE auth_login_attempts.window_started_at
      END,
      blocked_until = CASE
        WHEN auth_login_attempts.window_started_at >= now() - interval '15 minutes'
          AND auth_login_attempts.attempts + 1 >= 10
        THEN now() + interval '15 minutes'
        ELSE NULL
      END
    RETURNING attempts, blocked_until
  `, [identifier])
  if (row?.blocked_until) {
    throw createError({ statusCode: 429, statusMessage: 'Too many login attempts. Try again later.' })
  }
}

export async function clearLoginFailures(identifier: string) {
  await query('DELETE FROM auth_login_attempts WHERE identifier = $1', [identifier])
}
