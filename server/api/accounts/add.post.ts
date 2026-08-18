export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody(event)
  let authCookie: string
  try {
    authCookie = validateAuthCookieValue(body?.auth_cookie)
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Invalid auth cookie value'
    })
  }

  const startTime = Date.now()
  try {
    const account = await withAuthCookieLocks([authCookie], () => createAccount({
      name: body.name,
      auth_cookie: authCookie,
      workspace_id: body.workspace_id,
      workspace_name: body.workspace_name,
      allow_existing_cookie: false
    }))

    void refreshAccount(account.id).catch(() => {})

    void logOperation({
      operation: 'add_account',
      trigger_type: 'api',
      account_id: account.id,
      status: 'success',
      duration_ms: Date.now() - startTime
    })

    return {
      success: true,
      account: toPublicAccount(account),
      message: '账号添加成功'
    }
  } catch (error: any) {
    void logOperation({
      operation: 'add_account',
      trigger_type: 'api',
      status: 'error',
      error_message: error?.message || '添加账号失败',
      duration_ms: Date.now() - startTime
    })

    if (error?.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : '添加账号失败'
    })
  }
})
