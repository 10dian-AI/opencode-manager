import { createRequire } from 'node:module'
import { resolve } from 'node:path'
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
  upstream_api_key: string | null
  ip_pool_id: number | null
  status: AccountStatus
  disabled_reason: string | null
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
  'upstream_api_key',
  'ip_pool_id',
  'status',
  'disabled_reason',
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
let readyPromise: Promise<PoolLike> | null = null
let proxyCandidatesCache: Account[] | null = null
let proxyPoolCursor = 0
let managedApiKeyHashesCache: Set<string> | null = null

function invalidateProxyCandidates() {
  proxyCandidatesCache = null
}

/** Lets other modules that write to accounts directly drop the proxy pool cache. */
export function invalidateAccountCaches() {
  invalidateProxyCandidates()
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function buildPool(): PoolLike {
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
  const ssl = /^(1|true|require)$/i.test(process.env.DATABASE_SSL || '')
    ? { rejectUnauthorized: false }
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

  config.max = positiveInteger(process.env.POSTGRES_POOL_MAX, 20)
  config.idleTimeoutMillis = positiveInteger(process.env.POSTGRES_IDLE_TIMEOUT_MS, 30_000)
  config.connectionTimeoutMillis = positiveInteger(process.env.POSTGRES_CONNECT_TIMEOUT_MS, 10_000)

  const created = new Pool(config)
  created.on('error', () => {
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
    upstream_api_key TEXT,
    ip_pool_id BIGINT,
    status TEXT NOT NULL DEFAULT 'pending',
    disabled_reason TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_accounts_ip_pool_id ON accounts(ip_pool_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_proxy_pool
    ON accounts(id) WHERE status = 'active' AND subscription_status = 'active';
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
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
    await migrateStoredAuthCookieValues(client)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [4_517_923_001])
  }
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

  readyPromise = (async () => {
    const created = buildPool()
    const client = await created.connect()
    try {
      await initializeSchema(client)
    } finally {
      client.release()
    }
    pool = created
    return created
  })()

  readyPromise = readyPromise.catch(error => {
    readyPromise = null
    pool = null
    throw error
  })

  return readyPromise
}

export async function closeDb() {
  const current = pool
  pool = null
  readyPromise = null
  proxyCandidatesCache = null
  managedApiKeyHashesCache = null
  if (current) await current.end()
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

export async function createAccount(input: { name?: string; auth_cookie: string }): Promise<Account> {
  const created = await queryRow<Account>(
    `INSERT INTO accounts (name, auth_cookie, status)
     VALUES ($1, $2, 'pending')
     RETURNING *`,
    [input.name || null, validateAuthCookieValue(input.auth_cookie)]
  )
  invalidateProxyCandidates()
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
  invalidateProxyCandidates()
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
  invalidateProxyCandidates()
  return updated
}

export async function deleteAccount(id: number) {
  const result = await query('DELETE FROM accounts WHERE id = $1', [id])
  invalidateProxyCandidates()
  return { changes: result.rowCount }
}

export async function deleteAccounts(ids: number[]) {
  if (!ids.length) return { changes: 0 }
  const result = await query('DELETE FROM accounts WHERE id = ANY($1::bigint[])', [ids])
  invalidateProxyCandidates()
  return { changes: result.rowCount }
}

export async function deleteNonMemberAccounts() {
  const result = await query(
    `DELETE FROM accounts WHERE subscription_status IS NULL OR subscription_status <> 'active'`
  )
  invalidateProxyCandidates()
  return { changes: result.rowCount }
}

export async function getProxyCandidates(): Promise<Account[]> {
  if (proxyCandidatesCache) return proxyCandidatesCache
  const rows = await queryRows<Account>(`
    SELECT * FROM accounts
    WHERE status = 'active'
      AND subscription_status = 'active'
      AND upstream_api_key IS NOT NULL
      AND upstream_api_key <> ''
    ORDER BY id ASC
  `)
  proxyCandidatesCache = rows
  return rows
}

export async function reserveProxyCandidate(): Promise<Account | undefined> {
  const accounts = await getProxyCandidates()
  if (!accounts.length) return undefined
  const cursor = proxyPoolCursor % accounts.length
  proxyPoolCursor = (cursor + 1) % accounts.length
  return accounts[cursor]
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
  managedApiKeyHashesCache = null
  return created!
}

export async function deleteManagedApiKey(id: number) {
  const result = await query('DELETE FROM api_keys WHERE id = $1', [id])
  managedApiKeyHashesCache = null
  return { changes: result.rowCount }
}

export async function getManagedApiKeyHashes(): Promise<Set<string>> {
  if (managedApiKeyHashesCache) return managedApiKeyHashesCache
  const rows = await queryRows<{ key_hash: string }>('SELECT key_hash FROM api_keys')
  managedApiKeyHashesCache = new Set(rows.map(row => row.key_hash))
  return managedApiKeyHashesCache
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
}
