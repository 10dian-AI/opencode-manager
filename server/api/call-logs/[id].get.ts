export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid call log ID' })
  }

  const log = await getCallLogById(id)
  if (!log) {
    throw createError({ statusCode: 404, statusMessage: 'Call log not found' })
  }
  return log
})
