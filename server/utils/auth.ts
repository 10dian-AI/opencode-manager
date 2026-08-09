import { randomBytes, timingSafeEqual } from 'node:crypto'
const COOKIE_NAME = 'ocm_session'

export function createAuthToken() {
  return randomBytes(32).toString('hex')
}

export async function loginWithAdminKey(key: string, identifier = 'unknown') {
  await checkLoginRateLimit(identifier)
  const config = getAppConfig()
  if (!timingSafeEqualString(key, config.admin_key)) {
    await recordLoginFailure(identifier)
    throw createError({ statusCode: 401, statusMessage: 'Invalid admin key' })
  }

  await clearLoginFailures(identifier)
  await cleanExpiredSessions()
  const token = createAuthToken()
  await createSession(token)
  return token
}

export async function logoutToken(token: string) {
  await deleteSession(token)
}

export async function requireAuth(
  event: { node: { req: { headers: { cookie?: string } } } }
) {
  const cookieHeader = event.node.req.headers.cookie || ''
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`))
  const token = match?.[1]

  if (!token || !await findSession(token)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  return token
}

function timingSafeEqualString(a: string, b: string) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export { COOKIE_NAME }
