export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid account ID' })
  }

  const body = await readBody<{
    name?: string
    auth_cookie?: unknown
    status?: 'pending' | 'active' | 'error' | 'disabled'
    is_abandoned?: boolean
  }>(event)
  // is_abandoned 列是 BOOLEAN NOT NULL，运行时校验避免 null/字符串触发数据库 500
  if (body.is_abandoned !== undefined && typeof body.is_abandoned !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'is_abandoned (boolean) is required' })
  }
  if (
    body.status !== undefined &&
    !['pending', 'active', 'error', 'disabled'].includes(body.status)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid account status' })
  }
  let authCookie: string | undefined
  if (body.auth_cookie !== undefined) {
    try {
      authCookie = validateAuthCookieValue(body.auth_cookie)
    } catch (error) {
      throw createError({
        statusCode: 400,
        statusMessage: error instanceof Error ? error.message : 'Invalid auth cookie value'
      })
    }
  }

  const updated = await updateAccountSettings(id, {
    name: body.name,
    status: body.status,
    is_abandoned: body.is_abandoned,
    ...(authCookie !== undefined ? { auth_cookie: authCookie } : {})
  })

  return toPublicAccount(updated)
})
