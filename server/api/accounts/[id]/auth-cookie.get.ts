import { getAccount } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid account ID' })
  }
  const account = await getAccount(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'Account not found' })
  }

  setResponseHeader(event, 'Cache-Control', 'no-store, private, max-age=0')
  setResponseHeader(event, 'Pragma', 'no-cache')
  return { auth_cookie: account.auth_cookie }
})
