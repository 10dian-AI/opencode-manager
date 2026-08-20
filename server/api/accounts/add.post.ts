export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody(event)
  const startTime = Date.now()
  let authCookie: string
  try {
    authCookie = validateAuthCookieValue(body?.auth_cookie)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid auth cookie value'
    void logOperation({
      operation: 'add_account',
      trigger_type: 'api',
      status: 'error',
      error_message: message,
      request_detail: body,
      response_detail: error,
      duration_ms: Date.now() - startTime
    })
    throw createError({
      statusCode: 400,
      statusMessage: message
    })
  }

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
      detail: `账号 #${account.id} 添加成功`,
      request_detail: body,
      response_detail: { success: true, account: toPublicAccount(account), message: '账号添加成功' },
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
      request_detail: body,
      response_detail: error,
      duration_ms: Date.now() - startTime
    })

    if (error?.statusCode) throw error
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : '添加账号失败'
    })
  }
})
