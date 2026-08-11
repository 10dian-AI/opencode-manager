export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody(event)

  if (!body.auth_cookie || typeof body.auth_cookie !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'auth_cookie is required'
    })
  }

  try {
    const account = await createAccount({
      name: body.name,
      auth_cookie: body.auth_cookie,
      workspace_id: body.workspace_id,
      workspace_name: body.workspace_name,
      allow_existing_cookie: false
    })

    // Trigger initial refresh
    void refreshAccount(account.id).catch(() => {})

    return {
      success: true,
      account: toPublicAccount(account),
      message: '账号添加成功'
    }
  } catch (error: any) {
    if (error.statusCode === 409) {
      throw createError({
        statusCode: 409,
        statusMessage: '该 Cookie 已存在'
      })
    }
    throw createError({
      statusCode: 500,
      statusMessage: error.message || '添加账号失败'
    })
  }
})
