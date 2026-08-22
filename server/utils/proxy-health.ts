import type { IpPoolEntry } from './db'
import { getDb, listAccounts, withAdvisoryLock, withTransaction } from './db'
import { createProxyFetch } from './account-fetch'
import {
  ensureStableIpAssignments,
  listIpPoolEntries,
  redactProxyError,
  redactProxyUrl,
  type IpAssignmentChange
} from './ip-pool'
import { logOperation } from './operation-log'

const THRESHOLD_SETTING = 'proxy_health_threshold_ms'
const CHECK_URL_SETTING = 'proxy_health_check_url'
export const DEFAULT_THRESHOLD_MS = 3000
export const DEFAULT_CHECK_URL = 'https://www.gstatic.com/generate_204'
const MAX_PINGS_PER_RUN = 3
const CHECK_BATCH_SIZE = 4

export interface ProxyPingSample {
  ok: boolean
  latency_ms: number
  status_code: number | null
  error: string | null
}

export interface ProxyHealthResult {
  entryId: number
  samples: ProxyPingSample[]
  finalLatency: number | null
  overStreak: number
  previousHealth: string
  health: 'healthy' | 'down' | 'unknown'
  switched: boolean
  recovered: boolean
}

export async function getProxyHealthSettings() {
  const db = await getDb()
  const { rows } = await db.query<{ key: string; value: string }>(
    'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
    [[THRESHOLD_SETTING, CHECK_URL_SETTING]]
  )
  const map = new Map(rows.map(row => [row.key, row.value]))
  const threshold = Number(map.get(THRESHOLD_SETTING))
  return {
    threshold_ms: Number.isInteger(threshold) && threshold >= 200 && threshold <= 60000
      ? threshold
      : DEFAULT_THRESHOLD_MS,
    check_url: map.get(CHECK_URL_SETTING)?.trim() || DEFAULT_CHECK_URL
  }
}

export async function setProxyHealthSettings(input: {
  threshold_ms?: unknown
  check_url?: unknown
}) {
  let threshold: number | undefined
  let checkUrl: string | undefined
  if (input.threshold_ms !== undefined) {
    threshold = Number(input.threshold_ms)
    if (!Number.isInteger(threshold) || threshold < 200 || threshold > 60000) {
      throw createError({
        statusCode: 400,
        statusMessage: '延迟阈值必须是 200-60000 之间的整数（毫秒）'
      })
    }
  }
  if (input.check_url !== undefined) {
    const value = String(input.check_url ?? '').trim()
    if (value) {
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        throw createError({ statusCode: 400, statusMessage: '检测地址格式不正确' })
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw createError({ statusCode: 400, statusMessage: '检测地址仅支持 http/https' })
      }
    }
    checkUrl = value || DEFAULT_CHECK_URL
  }

  await withTransaction(async (db) => {
    if (threshold !== undefined) {
      await db.query(`
        INSERT INTO app_settings (key, value) VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `, [THRESHOLD_SETTING, String(threshold)])
    }
    if (checkUrl !== undefined) {
      await db.query(`
        INSERT INTO app_settings (key, value) VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `, [CHECK_URL_SETTING, checkUrl])
    }
  })
  return getProxyHealthSettings()
}

export function calculateProxyHealthState(input: {
  previousHealth: string | null | undefined
  previousStreak: number
  overCount: number
}) {
  const previousHealth: ProxyHealthResult['health'] = ['healthy', 'down'].includes(input.previousHealth || '')
    ? input.previousHealth as ProxyHealthResult['health']
    : 'unknown'
  const streak = input.overCount === 0 ? 0 : Math.max(0, input.previousStreak) + input.overCount
  let health: ProxyHealthResult['health'] = previousHealth
  if (input.overCount === 0) {
    health = 'healthy'
  } else if (streak >= MAX_PINGS_PER_RUN) {
    health = 'down'
  }
  return {
    previousHealth,
    streak,
    health,
    switched: previousHealth !== 'down' && health === 'down',
    recovered: previousHealth === 'down' && health === 'healthy'
  }
}

/**
 * Single latency probe through the proxy. Any HTTP response (even an error
 * status) proves the tunnel works; thrown errors and timeouts count as
 * failures with the elapsed time recorded as the latency sample.
 */
async function pingEntry(
  entry: IpPoolEntry,
  checkUrl: string,
  timeoutMs: number
): Promise<ProxyPingSample> {
  const startedAt = Date.now()
  try {
    const fetchImpl = createProxyFetch(entry.id, entry.proxy_url)
    const response = await fetchImpl(checkUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: '*/*' }
    })
    // Measure at response-headers time; discard the body to keep the probe cheap.
    await response.body?.cancel().catch(() => {})
    return {
      ok: true,
      latency_ms: Date.now() - startedAt,
      status_code: response.status,
      error: null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      latency_ms: Date.now() - startedAt,
      status_code: null,
      error: redactProxyError(message, entry.proxy_url)
    }
  }
}

/**
 * Pings one entry. On the first over-threshold (or failed) sample it
 * immediately re-pings, up to MAX_PINGS_PER_RUN samples total, stopping early
 * as soon as one sample is fast enough.
 */
async function checkEntry(
  entry: IpPoolEntry,
  checkUrl: string,
  thresholdMs: number
): Promise<{ samples: ProxyPingSample[]; overStreak: number; finalLatency: number | null }> {
  const samples: ProxyPingSample[] = []
  let overStreak = 0
  while (samples.length < MAX_PINGS_PER_RUN) {
    const sample = await pingEntry(entry, checkUrl, thresholdMs)
    samples.push(sample)
    if (sample.ok && sample.latency_ms <= thresholdMs) {
      overStreak = 0
      break
    }
    overStreak += 1
  }
  const lastGood = [...samples].reverse().find(sample => sample.ok)
  return { samples, overStreak, finalLatency: lastGood?.latency_ms ?? samples.at(-1)?.latency_ms ?? null }
}

async function persistHealthResult(
  entry: IpPoolEntry,
  result: { samples: ProxyPingSample[]; overStreak: number; finalLatency: number | null },
  thresholdMs: number
): Promise<ProxyHealthResult> {
  const state = calculateProxyHealthState({
    previousHealth: entry.health,
    previousStreak: Number(entry.consecutive_over) || 0,
    overCount: result.overStreak
  })

  const lastSample = result.samples.at(-1)!
  const db = await getDb()
  await db.query(`
    UPDATE ip_pool
    SET latency_ms = $1,
        consecutive_over = $2,
        health = $3,
        last_check_ok = $4,
        last_checked_at = $5,
        last_error = $6,
        updated_at = now()
    WHERE id = $7
  `, [
    result.finalLatency,
    state.streak,
    state.health,
    result.overStreak === 0,
    new Date().toISOString(),
    result.overStreak === 0 ? null : lastSample.error || `延迟 ${lastSample.latency_ms}ms 超过阈值 ${thresholdMs}ms`,
    entry.id
  ])

  return {
    entryId: entry.id,
    samples: result.samples,
    finalLatency: result.finalLatency,
    overStreak: state.streak,
    previousHealth: state.previousHealth,
    health: state.health,
    switched: state.switched,
    recovered: state.recovered
  }
}

function summarizeEntry(entry: IpPoolEntry, result: ProxyHealthResult) {
  return {
    id: entry.id,
    name: entry.name,
    proxy_url: redactProxyUrl(entry.proxy_url),
    region: entry.region,
    previous_health: result.previousHealth,
    health: result.health,
    consecutive_over: result.overStreak,
    final_latency_ms: result.finalLatency,
    samples: result.samples.map(sample => ({
      ok: sample.ok,
      latency_ms: sample.latency_ms,
      status_code: sample.status_code,
      error: sample.error
    }))
  }
}

/**
 * Runs one health-check round over every enabled pool entry, then migrates
 * accounts away from nodes that went down (same region first) and writes a
 * complete operation log whenever anything changed or failed.
 */
async function runProxyHealthCheckOnce() {
  const startedAt = Date.now()
  const settings = await getProxyHealthSettings()
  const entries = (await listIpPoolEntries()).filter(entry => entry.enabled)
  const accountsBefore = await listAccounts()
  const assignmentBefore = new Map(accountsBefore.map(account => [account.id, {
    name: account.name,
    ip_pool_id: account.ip_pool_id
  }]))
  if (!entries.length) {
    await logOperation({
      operation: 'proxy_health_check',
      trigger_type: 'scheduled',
      status: 'success',
      detail: '代理健康检查完成：当前没有启用的节点',
      request_detail: {
        check_url: settings.check_url,
        threshold_ms: settings.threshold_ms,
        max_pings_per_run: MAX_PINGS_PER_RUN,
        checked_entries: []
      },
      response_detail: { checked: 0, results: [], assignment_changes: [] },
      duration_ms: Date.now() - startedAt
    })
    return { checked: 0, results: [] as ProxyHealthResult[], changes: [] as IpAssignmentChange[] }
  }

  const results: ProxyHealthResult[] = []
  for (let index = 0; index < entries.length; index += CHECK_BATCH_SIZE) {
    const batch = entries.slice(index, index + CHECK_BATCH_SIZE)
    const batchResults = await Promise.all(batch.map(async (entry) => {
      const outcome = await checkEntry(entry, settings.check_url, settings.threshold_ms)
      return persistHealthResult(entry, outcome, settings.threshold_ms)
    }))
    results.push(...batchResults)
  }

  let changes: IpAssignmentChange[] = []
  if (results.some(result => result.switched)) {
    changes = await ensureStableIpAssignments()
  }

  const noteworthy = results.filter(result =>
    result.switched || result.recovered || result.health === 'down' ||
    result.samples.some(sample => !sample.ok)
  )
  const entryById = new Map(entries.map(entry => [entry.id, entry]))
  const status = results.some(result => result.health === 'down')
    ? 'partial'
    : results.every(result => result.health === 'healthy')
      ? 'success'
      : 'partial'
  await logOperation({
    operation: 'proxy_health_check',
    trigger_type: 'scheduled',
    status,
    detail: `检测 ${entries.length} 个节点：${results.filter(r => r.health === 'healthy').length} 正常，${results.filter(r => r.health === 'down').length} 判定故障，${results.filter(r => r.recovered).length} 恢复，迁移 ${changes.length} 个账号绑定`,
    error_message: results.some(result => result.health === 'down')
      ? `连续 ${MAX_PINGS_PER_RUN} 次延迟超过阈值 ${settings.threshold_ms}ms 的节点已被判定为故障并切换`
      : null,
    request_detail: {
      method: 'GET',
      check_url: settings.check_url,
      threshold_ms: settings.threshold_ms,
      max_pings_per_run: MAX_PINGS_PER_RUN,
      checked_entries: entries.map(entry => ({
        id: entry.id,
        name: entry.name,
        proxy_url: redactProxyUrl(entry.proxy_url),
        region: entry.region
      }))
    },
    response_detail: {
      checked: entries.length,
      results: results.map(result => summarizeEntry(entryById.get(result.entryId)!, result)),
      assignment_changes: changes.map(change => ({
        account_id: change.accountId,
        account_name: assignmentBefore.get(change.accountId)?.name ?? null,
        from_ip_pool_id: assignmentBefore.get(change.accountId)?.ip_pool_id ?? null,
        to_ip_pool_id: change.ipPoolId
      })),
      noteworthy: noteworthy.map(result => ({
        entry_id: result.entryId,
        switched: result.switched,
        recovered: result.recovered,
        health: result.health
      }))
    },
    duration_ms: Date.now() - startedAt
  })

  return { checked: entries.length, results, changes }
}

export async function runProxyHealthCheck() {
  return await withAdvisoryLock(
    'scheduled-task:check-proxy-health',
    runProxyHealthCheckOnce,
    { wait: false }
  ) || { checked: 0, results: [] as ProxyHealthResult[], changes: [] as IpAssignmentChange[] }
}
