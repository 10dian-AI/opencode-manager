import { buildAuthCookie } from './opencode'

const BASE = 'https://opencode.ai'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 20_000

function fetchWithDeadline(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {}
) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout
  return fetchImpl(input, { ...init, signal })
}

/**
 * Parse the server action ID from the workspace settings page HTML.
 *
 * Actual browser request (from Network capture):
 *   POST https://opencode.ai/_server
 *   x-server-id: 57e61af1bc9c8fa15e0c1a880a2a6754484afdd4a3bc4426b3fc02e3a7ff4d69
 *   x-server-instance: server-fn:N
 *   content-type: application/x-www-form-urlencoded
 *   body: workspaceID=wrk_xxx&useChinaProviders=true
 *
 * The ID comes from the form's action attribute in the HTML:
 *   <form action="/_server?id=57e61af1bc9c8fa15e0c1a880a2a6754484afdd4a3bc4426b3fc02e3a7ff4d69"
 *         method="post" data-slot="setting-row">
 *     <input type="hidden" name="workspaceID" value="wrk_xxx">
 *     <input type="hidden" name="useChinaProviders" value="true">
 *   </form>
 */
export function discoverChineseModelsServerId(html: string): string | null {
  // Primary: action="/_server?id=<64hex>" near useChinaProviders
  const formMatch = html.match(
    /action="\/(?:_server|server)\?id=([a-f0-9]{64})"[^>]*>[\s\S]{0,800}?name="useChinaProviders"/i
  )
  if (formMatch) return formMatch[1]!

  // Fallback: search backwards from useChinaProviders within 1000 chars
  const idx = html.indexOf('useChinaProviders')
  if (idx !== -1) {
    const window = html.slice(Math.max(0, idx - 1000), idx + 100)
    const idMatch = window.match(/\/_server\?id=([a-f0-9]{64})/i)
    if (idMatch) return idMatch[1]!
  }
  return null
}

export async function enableOpenCodeChineseModels(
  authCookie: string,
  workspaceId: string,
  serverId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const cookie = buildAuthCookie(authCookie)

  // Exact same format as the real browser request captured from Network tab:
  // POST https://opencode.ai/_server
  // Headers: x-server-id, x-server-instance, content-type, cookie, referer
  // Body: application/x-www-form-urlencoded  workspaceID=...&useChinaProviders=true
  const body = new URLSearchParams({
    workspaceID: workspaceId,
    useChinaProviders: 'true'
  })

  const response = await fetchWithDeadline(
    fetchImpl,
    `${BASE}/_server`,
    {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'x-server-id': serverId,
        'x-server-instance': 'server-fn:0',
        'x-single-flight': 'true',
        cookie,
        referer: `${BASE}/workspace/${workspaceId}/go`,
        'user-agent': UA
      },
      body: body.toString()
    }
  )

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(
      `Failed to enable Chinese models (HTTP ${response.status}${detail ? `: ${detail}` : ''})`
    )
  }

  // Verify the change by parsing the response
  const responseText = await response.text()
  const regionMatch = responseText.match(/region["\s:]+\[([^\]]+)\]/)
  if (regionMatch) {
    const regions = regionMatch[1]!
    const hasCn = regions.includes('"cn"') || regions.includes("'cn'")
    if (!hasCn) {
      throw new Error('中国模型开启请求已发送，但服务器返回的 region 数组中未包含 "cn"')
    }
  }
}

export async function disableOpenCodeChineseModels(
  authCookie: string,
  workspaceId: string,
  serverId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const cookie = buildAuthCookie(authCookie)

  const body = new URLSearchParams({
    workspaceID: workspaceId,
    useChinaProviders: 'false'
  })

  const response = await fetchWithDeadline(
    fetchImpl,
    `${BASE}/_server`,
    {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'x-server-id': serverId,
        'x-server-instance': 'server-fn:0',
        'x-single-flight': 'true',
        cookie,
        referer: `${BASE}/workspace/${workspaceId}/go`,
        'user-agent': UA
      },
      body: body.toString()
    }
  )

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(
      `Failed to disable Chinese models (HTTP ${response.status}${detail ? `: ${detail}` : ''})`
    )
  }

  // Verify the change by parsing the response
  const responseText = await response.text()
  const regionMatch = responseText.match(/region["\s:]+\[([^\]]+)\]/)
  if (regionMatch) {
    const regions = regionMatch[1]!
    const hasCn = regions.includes('"cn"') || regions.includes("'cn'")
    if (hasCn) {
      throw new Error('中国模型关闭请求已发送，但服务器返回的 region 数组中仍包含 "cn"')
    }
  }
}
