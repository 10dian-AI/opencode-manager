import { getAccount, deleteManagedAccount } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid account ID' })
  }
  if (!(await getAccount(id))) {
    throw createError({ statusCode: 404, statusMessage: 'Account not found' })
  }
  await deleteManagedAccount(id)
  return { ok: true }
})
