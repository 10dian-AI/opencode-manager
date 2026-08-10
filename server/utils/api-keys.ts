import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function apiKeyPrefix(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 3)}***`
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

export function generateApiKey(): string {
  return `sk-ocm-${randomBytes(24).toString('base64url')}`
}

let configApiKeyHashes: Set<string> | null = null

export async function isValidApiKey(key: string): Promise<boolean> {
  const value = key.trim()
  if (!value) return false
  const hash = hashApiKey(value)
  if (!configApiKeyHashes) {
    configApiKeyHashes = new Set(getAppConfig().api_keys.map(hashApiKey))
  }
  if (configApiKeyHashes.has(hash)) return true
  return (await getManagedApiKeyHashes()).has(hash)
}

export async function requireApiKey(event: H3Event): Promise<{ key: string; keyId: number | null; keyPrefix: string }> {
  const authorization = getHeader(event, 'authorization') || ''
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
  const key = bearer || getHeader(event, 'x-api-key') || ''
  if (!await isValidApiKey(key)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Invalid API key',
      data: {
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      }
    })
  }

  // Try to find the managed API key ID
  const hash = hashApiKey(key)
  const managedKeys = await listManagedApiKeys()
  const managedKey = managedKeys.find(k => k.key_hash === hash)

  return {
    key,
    keyId: managedKey?.id || null,
    keyPrefix: apiKeyPrefix(key)
  }
}
