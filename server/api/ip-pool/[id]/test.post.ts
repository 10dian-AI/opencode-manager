import { createProxyFetch } from '../../../utils/account-fetch'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const entry = await getIpPoolEntry(id)
  if (!entry) throw createError({ statusCode: 404, statusMessage: 'Proxy not found' })
  const targetUrl = 'https://api64.ipify.org?format=json'
  const startedAt = Date.now()
  let statusCode: number | null = null
  let responseHeaders: Record<string, string> | null = null
  let rawBody: string | null = null

  try {
    const fetchImpl = createProxyFetch(entry.id, entry.proxy_url)
    const response = await fetchImpl(targetUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json' }
    })
    statusCode = response.status
    responseHeaders = headersForLog(response.headers)
    rawBody = await response.text()
    let body: { ip?: string }
    try {
      body = JSON.parse(rawBody) as { ip?: string }
    } catch {
      throw new Error(`检测响应不是有效 JSON（HTTP ${response.status}）`)
    }
    if (!response.ok || !body.ip) throw new Error(`检测失败：HTTP ${response.status}，响应中没有出口 IP`)
    const latencyMs = Date.now() - startedAt
    await recordIpPoolCheck(id, { ok: true, ip: body.ip, latency_ms: latencyMs })
    const result = { ok: true, ip: body.ip, latency_ms: latencyMs, status_code: response.status }
    await logOperation({
      operation: 'ip_pool_test',
      trigger_type: 'manual',
      status: 'success',
      detail: `代理 #${id} 检测成功，出口 IP ${body.ip}，延迟 ${latencyMs}ms`,
      request_detail: {
        method: 'GET',
        url: targetUrl,
        timeout_ms: 15000,
        headers: { accept: 'application/json' },
        proxy: { id, name: entry.name, proxy_url: redactProxyUrl(entry.proxy_url) }
      },
      response_detail: {
        status_code: response.status,
        status_text: response.statusText,
        headers: responseHeaders,
        raw_body: rawBody,
        parsed_body: body,
        latency_ms: latencyMs
      },
      duration_ms: latencyMs
    })
    return result
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const message = redactProxyError(error instanceof Error ? error.message : String(error), entry.proxy_url)
    await recordIpPoolCheck(id, { ok: false, error: message, latency_ms: latencyMs })
    await logOperation({
      operation: 'ip_pool_test',
      trigger_type: 'manual',
      status: 'error',
      detail: `代理 #${id} 检测失败`,
      error_message: message,
      request_detail: {
        method: 'GET',
        url: targetUrl,
        timeout_ms: 15000,
        headers: { accept: 'application/json' },
        proxy: { id, name: entry.name, proxy_url: redactProxyUrl(entry.proxy_url) }
      },
      response_detail: {
        status_code: statusCode,
        headers: responseHeaders,
        raw_body: rawBody,
        latency_ms: latencyMs,
        error
      },
      duration_ms: latencyMs
    })
    return { ok: false, error: message, latency_ms: latencyMs, status_code: statusCode }
  }
})
