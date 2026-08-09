export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!(await getAccount(id))) {
    throw createError({ statusCode: 404, statusMessage: 'Account not found' })
  }
  await deleteManagedAccount(id)
  return { ok: true }
})
