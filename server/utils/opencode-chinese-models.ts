import { loadOpenCodeRouteModules, buildAuthCookie, serializeOpenCodeServerArgs } from './opencode'

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

export async function discoverChineseModelsServerId(
  html: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const modules = await loadOpenCodeRouteModules(html, fetchImpl)
  for (const source of modules) {
    // Look for Chinese models settings server action
    const match = source.match(
      /enableChineseModels|chineseModels|chinese_models[\s\S]{0,500}?createServerReference\("([a-f0-9]{64})"\)/i
    )
    if (match) return match[1] || null

    // Alternative pattern: look for settings update actions
    const settingsMatch = source.match(
      /updateSettings|settings\.update[\s\S]{0,300}?createServerReference\("([a-f0-9]{64})"\)/i
    )
    if (settingsMatch) return settingsMatch[1] || null
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
  const response = await fetchWithDeadline(fetchImpl, `${BASE}/_server`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      cookie,
      referer: `${BASE}/workspace/${workspaceId}/go`,
      'user-agent': UA,
      'x-server-id': serverId,
      'x-server-instance': 'server-fn:0'
    },
    body: JSON.stringify(serializeOpenCodeServerArgs([workspaceId, { enableChineseModels: true }]))
  })

  if (!response.ok || response.headers.has('x-error')) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(
      `Failed to enable Chinese models (status ${response.status}${detail ? `: ${detail}` : ''})`
    )
  }
}
