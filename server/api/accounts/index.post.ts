export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody<{ name?: string; auth_cookie?: unknown; refresh?: boolean }>(event)
  let authCookie: string
  try {
    authCookie = validateAuthCookieValue(body?.auth_cookie)
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Invalid auth cookie value'
    })
  }

  const account = await createAccount({
    name: body.name,
    auth_cookie: authCookie
  })
  await ensureStableIpAssignments()
  const assignedAccount = (await getAccount(account.id))!

  if (body.refresh !== false) {
    const expanded = await expandAccountWorkspacesByIds([assignedAccount.id])
    const refreshed = await refreshAccountsByIds(expanded.map(item => item.id))
    return toPublicAccount(refreshed[0]!)
  }

  await updateAccountPollSchedule(assignedAccount)
  return toPublicAccount(assignedAccount)
})
