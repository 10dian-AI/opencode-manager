import { buildAuthCookie } from './opencode'

interface ChinaModelForm {
  action: string
  values: Record<string, string>
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function readAttribute(source: string, name: string) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return match?.[1] ? decodeHtmlEntities(match[1]) : ''
}

function parseChinaModelForm(html: string): ChinaModelForm | null {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const formAttributes = match[1] || ''
    const body = match[2] || ''
    const inputs: Record<string, string> = {}
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const attributes = input[1] || ''
      const name = readAttribute(attributes, 'name')
      if (name) inputs[name] = readAttribute(attributes, 'value')
    }
    if (Object.prototype.hasOwnProperty.call(inputs, 'useChinaProviders')) {
      return {
        action: readAttribute(formAttributes, 'action'),
        values: inputs
      }
    }
  }
  return null
}

async function loadChinaModelForm(
  fetchImpl: typeof fetch,
  cookie: string,
  workspaceUrl: string
) {
  const response = await fetchImpl(`${workspaceUrl}?protocol=${Date.now()}`, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'cache-control': 'no-cache',
      cookie,
      'user-agent': 'Mozilla/5.0'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) {
    throw new Error(`加载中国模型设置失败（HTTP ${response.status}）`)
  }
  const finalUrl = response.url || workspaceUrl
  if (!/\/workspace\//i.test(finalUrl)) {
    throw new Error('Cookie 登录失败或未找到中国模型设置')
  }
  const form = parseChinaModelForm(await response.text())
  if (!form) throw new Error('未找到中国模型设置表单')
  return form
}

/**
 * Toggle Chinese models through the same HTTP server action used by the page.
 * Using the account fetch implementation here is important: HTTP and SOCKS
 * account proxies must apply consistently to all account mutations.
 */
export async function toggleChineseModels(
  authCookie: string,
  workspaceId: string,
  enable: boolean,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const cookie = buildAuthCookie(authCookie)
  const workspaceUrl = `https://opencode.ai/workspace/${workspaceId}/go`
  const form = await loadChinaModelForm(fetchImpl, cookie, workspaceUrl)
  const targetValue = enable ? 'true' : 'false'
  const currentValue = String(form.values.useChinaProviders || '').toLowerCase()

  if (currentValue === targetValue) return
  if (currentValue !== 'true' && currentValue !== 'false') {
    throw new Error('无法识别中国模型当前状态')
  }

  const actionUrl = new URL(form.action || '/_server', workspaceUrl)
  const serverId = actionUrl.searchParams.get('id')
  const workspaceValue = form.values.workspaceID || workspaceId
  if (!serverId || !workspaceValue) {
    throw new Error('表单缺少动作 ID 或 workspaceID')
  }

  const origin = new URL(workspaceUrl).origin
  const response = await fetchImpl(`${origin}/_server`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin,
      referer: workspaceUrl,
      'user-agent': 'Mozilla/5.0',
      'x-server-id': serverId,
      'x-server-instance': 'server-fn:0',
      'x-single-flight': 'true'
    },
    body: new URLSearchParams({
      workspaceID: workspaceValue,
      // The action is a toggle and receives the current state.
      useChinaProviders: currentValue
    }).toString(),
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) {
    throw new Error(`中国模型切换请求失败（HTTP ${response.status}）`)
  }
  await response.body?.cancel().catch(() => {})

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const latest = await loadChinaModelForm(fetchImpl, cookie, workspaceUrl)
    if (String(latest.values.useChinaProviders || '').toLowerCase() === targetValue) return
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }

  throw new Error(`提交后未确认中国模型已${enable ? '开启' : '关闭'}`)
}

// Keep this export for existing callers.
export async function enableAccountChineseModelsPy(
  authCookie: string,
  workspaceId: string
): Promise<void> {
  await toggleChineseModels(authCookie, workspaceId, true)
}
