import { loginWithAdminKey } from '~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ key?: string }>(event)
  if (!body?.key) {
    throw createError({ statusCode: 400, statusMessage: 'key is required' })
  }

  const trustProxy = process.env.TRUST_PROXY === 'true'
  const identifier = trustProxy
    ? getRequestIP(event, { xForwardedFor: true })
    : getRequestIP(event)
  const token = await loginWithAdminKey(body.key, identifier || 'unknown')
  const forwardedProto = trustProxy ? getHeader(event, 'x-forwarded-proto') : undefined
  const secure = forwardedProto
    ? forwardedProto.split(',', 1)[0]?.trim() === 'https'
    : Boolean((event.node.req.socket as { encrypted?: boolean }).encrypted)

  setCookie(event, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 60 * 60 * 24 * 7
  })

  return { ok: true }
})
