export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const account = await getAccount(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'Account not found' })
  }
  return toPublicAccount(account)
})
