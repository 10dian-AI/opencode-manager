export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid operation log ID' })
  }

  const log = await getOperationLogById(id)
  if (!log) {
    throw createError({ statusCode: 404, statusMessage: 'Operation log not found' })
  }
  return log
})
