import type { IpPoolEntry, ProxySubscription, ProxySubscriptionNode } from './db'
import { getDb, withTransaction } from './db'
import { fetchSubscription, type SubscriptionNode } from './subscription'
import { ensureStableIpAssignments, listIpPoolEntries, normalizeProxyUrl } from './ip-pool'

export interface ProxySubscriptionSummary extends ProxySubscription {
  node_count: number
  supported_count: number
  imported_count: number
}

export interface ProxySubscriptionNodeView extends ProxySubscriptionNode {
  imported_pool_id: number | null
}

function normalizeSubscriptionUrl(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw createError({ statusCode: 400, statusMessage: '订阅链接不能为空' })
  }
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw createError({ statusCode: 400, statusMessage: '订阅链接格式不正确' })
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw createError({ statusCode: 400, statusMessage: '订阅链接仅支持 http/https' })
  }
  return url.toString()
}

export function redactSubscriptionUrl(input: string): string {
  try {
    const url = new URL(input)
    if (url.username) url.username = '***'
    if (url.password) url.password = '***'
    if (url.pathname && url.pathname !== '/') url.pathname = '/***'
    for (const key of [...new Set(url.searchParams.keys())]) {
      url.searchParams.set(key, '***')
    }
    if (url.hash) url.hash = '#***'
    return url.toString()
  } catch {
    return '[invalid subscription URL]'
  }
}

/** Removes credentials and path/query tokens if an HTTP client error echoes the subscription URL. */
export function redactSubscriptionError(message: string, subscriptionUrl: string): string {
  let result = message
  try {
    const url = new URL(subscriptionUrl)
    const safeUrl = redactSubscriptionUrl(subscriptionUrl)
    const fullUrlCandidates = [...new Set([subscriptionUrl, subscriptionUrl.trim(), url.toString()])]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
    for (const candidate of fullUrlCandidates) result = result.replaceAll(candidate, safeUrl)

    const encodedUserInfo = url.username
      ? `${url.username}${url.password ? `:${url.password}` : ''}@`
      : ''
    const decodedUserInfo = url.username
      ? `${decodeURIComponent(url.username)}${url.password ? `:${decodeURIComponent(url.password)}` : ''}@`
      : ''
    for (const userInfo of new Set([encodedUserInfo, decodedUserInfo])) {
      if (userInfo) result = result.replaceAll(userInfo, '***:***@')
    }

    if (url.pathname && url.pathname !== '/') {
      result = result.replaceAll(`${url.pathname}${url.search}${url.hash}`, '/***')
      result = result.replaceAll(url.pathname, '/***')
    }
    for (const [key, value] of url.searchParams) {
      result = result.replaceAll(`${key}=${value}`, `${key}=***`)
      const decodedValue = decodeURIComponent(value)
      if (decodedValue !== value) result = result.replaceAll(`${key}=${decodedValue}`, `${key}=***`)
    }
    if (url.hash) result = result.replaceAll(url.hash, '#***')
  } catch {
    // Invalid input has no reliably identifiable credential components.
  }
  return result
}

export async function listProxySubscriptions(): Promise<ProxySubscriptionSummary[]> {
  const db = await getDb()
  const { rows } = await db.query<ProxySubscriptionSummary>(`
    SELECT
      s.*,
      COUNT(DISTINCT n.id)::int AS node_count,
      COUNT(DISTINCT n.id) FILTER (WHERE n.supported)::int AS supported_count,
      COUNT(DISTINCT n.id) FILTER (WHERE p.id IS NOT NULL)::int AS imported_count
    FROM proxy_subscriptions s
    LEFT JOIN proxy_subscription_nodes n ON n.subscription_id = s.id
    LEFT JOIN ip_pool p ON p.proxy_url = n.uri
    GROUP BY s.id
    ORDER BY s.id ASC
  `)
  return rows
}

export async function getProxySubscription(id: number): Promise<ProxySubscription | undefined> {
  const db = await getDb()
  return (await db.query<ProxySubscription>(
    'SELECT * FROM proxy_subscriptions WHERE id = $1',
    [id]
  )).rows[0]
}

export async function createProxySubscription(input: { name?: string; url: unknown }) {
  const url = normalizeSubscriptionUrl(input.url)
  const db = await getDb()
  const { rows } = await db.query<ProxySubscription>(
    'INSERT INTO proxy_subscriptions (name, url) VALUES ($1, $2) RETURNING *',
    [input.name?.trim() || null, url]
  )
  return rows[0]!
}

export async function deleteProxySubscription(id: number) {
  const db = await getDb()
  // ip_pool.subscription_id is ON DELETE SET NULL: imported proxies stay in the
  // pool as standalone entries when their subscription is removed.
  const result = await db.query('DELETE FROM proxy_subscriptions WHERE id = $1', [id])
  return { changes: result.rowCount }
}

/**
 * Fetches the subscription URL and atomically replaces the cached node list.
 * Returns the parsed nodes so callers can log/return them.
 */
export async function refreshProxySubscription(
  subscription: ProxySubscription
): Promise<SubscriptionNode[]> {
  const nodes = await fetchSubscription(subscription.url)
  await withTransaction(async (db) => {
    await db.query('DELETE FROM proxy_subscription_nodes WHERE subscription_id = $1', [subscription.id])
    for (const node of nodes) {
      await db.query(`
        INSERT INTO proxy_subscription_nodes
          (subscription_id, name, protocol, uri, region, supported, unsupported_reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        subscription.id,
        node.name,
        node.protocol,
        node.uri,
        node.region,
        node.supported,
        node.unsupported_reason
      ])
    }
    await db.query(`
      UPDATE proxy_subscriptions
      SET last_fetched_at = now(), last_node_count = $2, last_error = NULL, updated_at = now()
      WHERE id = $1
    `, [subscription.id, nodes.length])
  })
  return nodes
}

export async function recordSubscriptionError(id: number, error: unknown) {
  const db = await getDb()
  await db.query(`
    UPDATE proxy_subscriptions
    SET last_error = $2, updated_at = now()
    WHERE id = $1
  `, [id, error instanceof Error ? error.message : String(error)])
}

export async function listSubscriptionNodes(id: number): Promise<ProxySubscriptionNodeView[]> {
  const db = await getDb()
  const { rows } = await db.query<ProxySubscriptionNodeView>(`
    SELECT n.*, p.id AS imported_pool_id
    FROM proxy_subscription_nodes n
    LEFT JOIN ip_pool p ON p.proxy_url = n.uri
    WHERE n.subscription_id = $1
    ORDER BY n.supported DESC, n.id ASC
  `, [id])
  return rows
}

/**
 * Imports the selected cached nodes into the IP pool. Duplicates (same
 * proxy_url already in the pool) are skipped via the UNIQUE constraint.
 */
export async function importSubscriptionNodes(subscriptionId: number, nodeIds: number[]) {
  const db = await getDb()
  const uniqueIds = [...new Set(nodeIds.map(id => Number(id)).filter(Number.isInteger))]
  if (!uniqueIds.length) {
    throw createError({ statusCode: 400, statusMessage: '请先选择要导入的节点' })
  }
  const { rows } = await db.query<ProxySubscriptionNode>(`
    SELECT * FROM proxy_subscription_nodes
    WHERE subscription_id = $1 AND id = ANY($2::bigint[]) AND supported
  `, [subscriptionId, uniqueIds])
  if (!rows.length) {
    throw createError({ statusCode: 400, statusMessage: '所选节点中没有可导入的可用节点' })
  }

  const existing = new Set((await listIpPoolEntries()).map(entry => entry.proxy_url))
  const pendingByUrl = new Map<string, ProxySubscriptionNode>()
  for (const node of rows) {
    if (!node.uri) continue
    const proxyUrl = normalizeProxyUrl(node.uri)
    if (!existing.has(proxyUrl) && !pendingByUrl.has(proxyUrl)) {
      pendingByUrl.set(proxyUrl, node)
    }
  }
  const pending = [...pendingByUrl.entries()]
  const created = pending.length
    ? await withTransaction(async (client) => {
        const { rows: inserted } = await client.query<IpPoolEntry>(`
          INSERT INTO ip_pool (name, proxy_url, subscription_id, region)
          SELECT name, proxy_url, subscription_id, region
          FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[])
            AS t(name, proxy_url, subscription_id, region)
          ON CONFLICT (proxy_url) DO NOTHING
          RETURNING *
        `, [
          pending.map(([, node]) => node.name || null),
          pending.map(([proxyUrl]) => proxyUrl),
          pending.map(() => subscriptionId),
          pending.map(([, node]) => node.region ?? null)
        ])
        return inserted
      })
    : []
  const changes = await ensureStableIpAssignments()
  return {
    created,
    skipped: rows.length - created.length,
    unsupported: uniqueIds.length - rows.length,
    assigned: changes.filter(change => change.ipPoolId !== null).length,
    changes
  }
}
