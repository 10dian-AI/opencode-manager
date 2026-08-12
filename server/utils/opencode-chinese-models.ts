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
 * The form looks like:
 *   <form method="post" data-slot="setting-row"
 *         action="/_server?id=57e61af1bc9c8fa15e0c1a880a2a6754484afdd4a3bc4426b3fc02e3a7ff4d69">
 *     <input type="hidden" name="useChinaProviders" value="true">
 *   </form>
 */
export function discoverChineseModelsServerId(html: string): string | null {
  // Match: action="/_server?id=<64-hex-char>" near useChinaProviders
  const formMatch = html.match(
    /action="\/(?:_server|server)\?id=([a-f0-9]{64})"[^>]*>[\s\S]{0,800}?name="useChinaProviders"/i
  )
  if (formMatch) return formMatch[1]!

  // Wider search: find /_server?id= anywhere close to useChinaProviders
  const idx = html.indexOf('useChinaProviders')
  if (idx !== -1) {
    const window = html.slice(Math.max(0, idx - 800), idx + 100)
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

  // The form uses a standard POST with application/x-www-form-urlencoded
  const body = new URLSearchParams({
    workspaceID: workspaceId,
    useChinaProviders: 'true'
  })

  const response = await fetchWithDeadline(
    fetchImpl,
    `${BASE}/_server?id=${serverId}`,
    {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
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
      `Failed to enable Chinese models (status ${response.status}${detail ? `: ${detail}` : ''})`
    )
  }
}
