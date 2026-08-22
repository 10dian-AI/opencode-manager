import type { Account, IpPoolEntry } from './db'
import { getAccount, getDb, invalidateAccountCaches, listAccounts } from './db'

const BLOCK_SIZE_SETTING = 'ip_pool_block_size'
const DEFAULT_BLOCK_SIZE = 5

export interface IpPoolPublicEntry {
  id: number
  name: string | null
  proxy_url: string
  enabled: boolean
  subscription_id: number | null
  region: string | null
  latency_ms: number | null
  health: string
  account_count: number
  last_ip: string | null
  last_check_ok: boolean | null
  last_checked_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface IpAssignmentChange {
  accountId: number
  ipPoolId: number | null
}

export function normalizeProxyUrl(input: unknown) {
  if (typeof input !== 'string' || !input.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Proxy URL is required' })
  }
  let value = input.trim()
  if (/^sk5:\/\//i.test(value)) value = value.replace(/^sk5:/i, 'socks5:')

  // Accept the common ip:port:user:password export format in addition to URLs.
  if (!value.includes('://') && !value.includes('@')) {
    const parts = value.split(':')
    if (parts.length === 4 && /^\d+$/.test(parts[1]!)) {
      const [host, port, username, password] = parts
      value = `http://${encodeURIComponent(username!)}:${encodeURIComponent(password!)}@${host}:${port}`
    }
  }
  if (!value.includes('://')) value = `http://${value}`

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid proxy URL' })
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:', 'ss:', 'trojan:'].includes(url.protocol)) {
    throw createError({
      statusCode: 400,
      statusMessage: '仅支持 HTTP / HTTPS / SOCKS5 / Shadowsocks / Trojan 代理'
    })
  }
  if (!url.hostname || !url.port) {
    throw createError({ statusCode: 400, statusMessage: 'Proxy host and port are required' })
  }
  if (['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
    url.pathname = ''
    url.search = ''
    url.hash = ''
  } else {
    // ss/trojan URIs carry meaningful query params (sni, allowInsecure); only
    // drop the display-name fragment.
    url.hash = ''
  }
  return url.toString()
}

export function redactProxyUrl(proxyUrl: string) {
  const url = new URL(proxyUrl)
  if (url.protocol === 'trojan:' && url.username) {
    url.username = '***'
  } else if (url.password) {
    url.password = '***'
  }
  return url.toString()
}

export function redactProxyInput(input: unknown) {
  const value = String(input ?? '').trim()
  if (!value) return value
  try {
    return redactProxyUrl(normalizeProxyUrl(value))
  } catch {
    return value
      .replace(/(\/\/[^:\s/@]+:)[^@\s]+@/g, '$1***@')
      .replace(/^([^:\s]+:\d+:[^:\s]+:).+$/, '$1***')
  }
}

export function redactProxyError(message: string, proxyUrl: string) {
  const url = new URL(proxyUrl)
  let safe = message.replaceAll(proxyUrl, redactProxyUrl(proxyUrl))
  if (url.password) {
    safe = safe.replaceAll(url.password, '***')
  }
  if (url.protocol === 'trojan:' && url.username) {
    safe = safe.replaceAll(url.username, '***')
  }
  return safe
}

export async function getIpPoolBlockSize() {
  const db = await getDb()
  const { rows } = await db.query<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [BLOCK_SIZE_SETTING]
  )
  const parsed = Number(rows[0]?.value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000
    ? parsed
    : DEFAULT_BLOCK_SIZE
}

export async function setIpPoolBlockSize(value: unknown) {
  const blockSize = Number(value)
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 1000) {
    throw new Error('Block size must be an integer between 1 and 1000')
  }
  const db = await getDb()
  await db.query(`
    INSERT INTO app_settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `, [BLOCK_SIZE_SETTING, String(blockSize)])
  return blockSize
}

export async function listIpPoolEntries(): Promise<IpPoolEntry[]> {
  const db = await getDb()
  return (await db.query<IpPoolEntry>('SELECT * FROM ip_pool ORDER BY id ASC')).rows
}

export async function getIpPoolEntry(id: number): Promise<IpPoolEntry | undefined> {
  const db = await getDb()
  return (await db.query<IpPoolEntry>('SELECT * FROM ip_pool WHERE id = $1', [id])).rows[0]
}

export async function listPublicIpPoolEntries(): Promise<IpPoolPublicEntry[]> {
  const db = await getDb()
  const { rows } = await db.query<IpPoolEntry & { account_count: number }>(`
    SELECT ip_pool.*, COUNT(accounts.id)::int AS account_count
    FROM ip_pool
    LEFT JOIN accounts ON accounts.ip_pool_id = ip_pool.id
    GROUP BY ip_pool.id
    ORDER BY ip_pool.id ASC
  `)
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    proxy_url: redactProxyUrl(row.proxy_url),
    enabled: Boolean(row.enabled),
    subscription_id: row.subscription_id ?? null,
    region: row.region ?? null,
    latency_ms: row.latency_ms ?? null,
    health: row.health || 'unknown',
    account_count: row.account_count,
    last_ip: row.last_ip,
    last_check_ok: row.last_check_ok === null ? null : Boolean(row.last_check_ok),
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at
  }))
}

export async function createIpPoolEntry(input: { name?: string; proxy_url: unknown }) {
  const db = await getDb()
  const { rows } = await db.query<IpPoolEntry>(
    'INSERT INTO ip_pool (name, proxy_url) VALUES ($1, $2) RETURNING *',
    [input.name?.trim() || null, normalizeProxyUrl(input.proxy_url)]
  )
  return rows[0]!
}

export async function createIpPoolEntries(
  inputs: Array<{ name?: string; proxy_url: unknown }>
): Promise<IpPoolEntry[]> {
  if (!inputs.length) return []
  const names: Array<string | null> = []
  const urls: string[] = []
  for (const input of inputs) {
    names.push(input.name?.trim() || null)
    urls.push(normalizeProxyUrl(input.proxy_url))
  }
  const db = await getDb()
  const { rows } = await db.query<IpPoolEntry>(`
    INSERT INTO ip_pool (name, proxy_url)
    SELECT name, proxy_url
    FROM unnest($1::text[], $2::text[]) AS t(name, proxy_url)
    ON CONFLICT (proxy_url) DO NOTHING
    RETURNING *
  `, [names, urls])
  return rows
}

export async function updateIpPoolEntry(
  id: number,
  input: { name?: string | null; proxy_url?: unknown; enabled?: boolean }
) {
  const current = await getIpPoolEntry(id)
  if (!current) return undefined
  const nextUrl = input.proxy_url === undefined
    ? current.proxy_url
    : normalizeProxyUrl(input.proxy_url)
  const db = await getDb()
  const { rows } = await db.query<IpPoolEntry>(`
    UPDATE ip_pool
    SET name = $1, proxy_url = $2, enabled = $3,
        subscription_id = CASE WHEN proxy_url = $2 THEN subscription_id ELSE NULL END,
        region = CASE WHEN proxy_url = $2 THEN region ELSE NULL END,
        latency_ms = CASE WHEN proxy_url = $2 THEN latency_ms ELSE NULL END,
        health = CASE WHEN proxy_url = $2 THEN health ELSE 'unknown' END,
        consecutive_over = CASE WHEN proxy_url = $2 THEN consecutive_over ELSE 0 END,
        last_ip = CASE WHEN proxy_url = $2 THEN last_ip ELSE NULL END,
        last_check_ok = CASE WHEN proxy_url = $2 THEN last_check_ok ELSE NULL END,
        last_checked_at = CASE WHEN proxy_url = $2 THEN last_checked_at ELSE NULL END,
        last_error = CASE WHEN proxy_url = $2 THEN last_error ELSE NULL END,
        updated_at = now()
    WHERE id = $4
    RETURNING *
  `, [
    input.name === undefined ? current.name : input.name?.trim() || null,
    nextUrl,
    input.enabled === undefined ? current.enabled : input.enabled,
    id
  ])
  return rows[0]
}

export async function deleteIpPoolEntry(id: number) {
  const db = await getDb()
  // The accounts.ip_pool_id foreign key is ON DELETE SET NULL, so bound
  // accounts fall back to direct mode without a second pass.
  const result = await db.query('DELETE FROM ip_pool WHERE id = $1', [id])
  return { changes: result.rowCount }
}

export async function recordIpPoolCheck(
  id: number,
  result: { ok: boolean; ip?: string | null; error?: string | null; latency_ms?: number | null }
) {
  const entry = await getIpPoolEntry(id)
  const safeError = result.error && entry
    ? redactProxyError(result.error, entry.proxy_url)
    : result.error
  const db = await getDb()
  const { rows } = await db.query<IpPoolEntry>(`
    UPDATE ip_pool
    SET last_ip = COALESCE($1, last_ip), last_check_ok = $2, last_checked_at = $3,
        last_error = $4, latency_ms = COALESCE($5, latency_ms),
        health = CASE WHEN $2 THEN 'healthy' ELSE health END,
        consecutive_over = CASE WHEN $2 THEN 0 ELSE consecutive_over END,
        updated_at = now()
    WHERE id = $6
    RETURNING *
  `, [
    result.ip || null,
    result.ok,
    new Date().toISOString(),
    safeError || null,
    result.latency_ms ?? null,
    id
  ])
  return rows[0]
}

export interface IpPoolPlanEntry {
  id: number
  enabled: boolean | number
  /** Entries marked 'down' by the health checker are treated as unavailable. */
  health?: string | null
  region?: string | null
}

type PendingAccount = Pick<Account, 'id' | 'ip_pool_id'>

interface PlanCandidate {
  id: number
  region: string | null
  count: number
}

export function planStableIpAssignments(
  accounts: PendingAccount[],
  entries: IpPoolPlanEntry[],
  blockSize: number
): IpAssignmentChange[] {
  const available = entries
    .filter(entry => Boolean(entry.enabled) && entry.health !== 'down')
    .map<PlanCandidate>(entry => ({
      id: entry.id,
      region: entry.region ?? null,
      count: 0
    }))
  const availableById = new Map(available.map(entry => [entry.id, entry]))
  const regionById = new Map(entries.map(entry => [entry.id, entry.region ?? null]))
  const pending: PendingAccount[] = []

  for (const account of accounts) {
    const bound = account.ip_pool_id !== null ? availableById.get(account.ip_pool_id) : undefined
    if (bound) bound.count++
    else pending.push(account)
  }

  const changes: IpAssignmentChange[] = []
  pending.sort((a, b) => a.id - b.id)
  if (!available.length) {
    for (const account of pending) {
      if (account.ip_pool_id !== null) changes.push({ accountId: account.id, ipPoolId: null })
    }
    return changes
  }

  const assignChunked = (list: PendingAccount[], candidates: PlanCandidate[]) => {
    let cursor = 0
    while (cursor < list.length) {
      candidates.sort((a, b) => a.count - b.count || a.id - b.id)
      const target = candidates[0]!
      const remainingInBlock = blockSize - (target.count % blockSize || 0)
      const take = Math.min(remainingInBlock, list.length - cursor)
      for (let offset = 0; offset < take; offset++) {
        const account = list[cursor + offset]!
        if (account.ip_pool_id !== target.id) {
          changes.push({ accountId: account.id, ipPoolId: target.id })
        }
      }
      target.count += take
      cursor += take
    }
  }

  // Phase 1 ("就近切换"): accounts whose previous node had a region prefer the
  // least-loaded healthy node of the SAME region, so an auto-switch does not
  // jump continents (which risks triggering upstream risk control).
  const rest: PendingAccount[] = []
  const byRegion = new Map<string, PendingAccount[]>()
  for (const account of pending) {
    const previousRegion = account.ip_pool_id !== null
      ? regionById.get(account.ip_pool_id) ?? null
      : null
    if (previousRegion && available.some(entry => entry.region === previousRegion)) {
      const group = byRegion.get(previousRegion) || []
      group.push(account)
      byRegion.set(previousRegion, group)
    } else {
      rest.push(account)
    }
  }
  for (const region of [...byRegion.keys()].sort()) {
    assignChunked(
      byRegion.get(region)!,
      available.filter(entry => entry.region === region)
    )
  }

  // Phase 2: accounts without a same-region candidate use the global pool.
  assignChunked(rest, available)
  return changes
}

export async function ensureStableIpAssignments() {
  return await withAdvisoryLock('ip-pool-assignment', ensureStableIpAssignmentsOnce) || []
}

async function ensureStableIpAssignmentsOnce() {
  const [accounts, entries, blockSize] = await Promise.all([
    listAccounts(),
    listIpPoolEntries(),
    getIpPoolBlockSize()
  ])
  const changes = planStableIpAssignments(accounts, entries, blockSize)
  if (!changes.length) return changes

  // One statement for the whole plan keeps large pools from issuing
  // thousands of round trips.
  const db = await getDb()
  await db.query(`
    UPDATE accounts
    SET ip_pool_id = plan.ip_pool_id, updated_at = now()
    FROM (
      SELECT * FROM unnest($1::bigint[], $2::bigint[]) AS t(account_id, ip_pool_id)
    ) AS plan
    WHERE accounts.id = plan.account_id
  `, [
    changes.map(change => change.accountId),
    changes.map(change => change.ipPoolId)
  ])
  invalidateAccountCaches()
  return changes
}

export async function ensureAccountIpAssignment(id: number) {
  const account = await getAccount(id)
  if (!account) return undefined
  if (account.ip_pool_id !== null) {
    const entry = await getIpPoolEntry(account.ip_pool_id)
    if (entry?.enabled && entry.health !== 'down') return account
  }
  await ensureStableIpAssignments()
  return getAccount(id)
}
