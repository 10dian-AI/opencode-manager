export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readBody<{ auto_refresh_errors?: unknown }>(event)
  if (typeof body?.auto_refresh_errors !== 'boolean') {
    throw createError({
      statusCode: 400,
      statusMessage: 'auto_refresh_errors must be a boolean'
    })
  }
  return setAutoRefreshErrors(body.auto_refresh_errors)
})
