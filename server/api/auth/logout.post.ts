import { requireAuth, logoutToken, COOKIE_NAME } from '~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const token = await requireAuth(event)
  await logoutToken(token)
  deleteCookie(event, COOKIE_NAME, { path: '/' })
  return { ok: true }
})
