import { fetchOpenCodeAccount, buildAuthCookie } from '~/server/utils/opencode'
import { discoverChineseModelsServerId, enableOpenCodeChineseModels } from '~/server/utils/opencode-chinese-models'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody(event)
  const { auth_cookie } = body

  if (!auth_cookie) {
    throw createError({
      statusCode: 400,
      statusMessage: 'auth_cookie is required'
    })
  }

  try {
    // First, get account info to get workspace ID and HTML for server ID discovery
    const accountInfo = await fetchOpenCodeAccount(auth_cookie, null)

    if (!accountInfo.workspaceId) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Failed to get workspace ID from account'
      })
    }

    const workspaceId = accountInfo.workspaceId

    // Get the workspace page HTML to discover server ID
    const cookie = buildAuthCookie(auth_cookie)
    const response = await fetch(`https://opencode.ai/workspace/${workspaceId}/go`, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'cookie': cookie,
        'referer': 'https://opencode.ai/zh/go',
        'upgrade-insecure-requests': '1'
      }
    })

    if (!response.ok) {
      throw createError({
        statusCode: response.status,
        statusMessage: 'Failed to fetch workspace page'
      })
    }

    const html = await response.text()

    // Discover the server ID for Chinese models settings
    const serverId = await discoverChineseModelsServerId(html)

    if (!serverId) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Failed to discover Chinese models server ID'
      })
    }

    // Enable Chinese models
    await enableOpenCodeChineseModels(auth_cookie, workspaceId, serverId)

    return {
      success: true,
      message: '已成功开启中国模型支持',
      workspace_id: workspaceId
    }
  } catch (error: any) {
    if (error.statusCode) throw error

    throw createError({
      statusCode: 500,
      statusMessage: error.message || '开启中国模型失败'
    })
  }
})
