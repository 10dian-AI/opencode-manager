const SENSITIVE_FIELD_PATTERN = /^(authorization|proxy-authorization|x-api-key|cookie|set-cookie|auth_cookie|upstream_api_key|key_hash|api_key|access_token|refresh_token|password|secret)$/i

function isSensitiveField(name: string) {
  return SENSITIVE_FIELD_PATTERN.test(name)
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map(item => redactValue(item, seen))
  if (value instanceof Error) {
    const errorWithDetails = value as Error & {
      statusCode?: unknown
      statusMessage?: unknown
      data?: unknown
    }
    const details: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
      status_code: errorWithDetails.statusCode,
      status_message: errorWithDetails.statusMessage,
      data: redactValue(errorWithDetails.data, seen)
    }
    for (const [key, child] of Object.entries(value)) {
      details[key] = isSensitiveField(key) ? '[REDACTED]' : redactValue(child, seen)
    }
    return details
  }

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSensitiveField(key) ? '[REDACTED]' : redactValue(child, seen)
  }
  return result
}

export function serializeLogPayload(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(redactValue(value, new WeakSet()), null, 2)
  } catch (error) {
    return JSON.stringify({
      serialization_error: error instanceof Error ? error.message : String(error),
      value: String(value)
    }, null, 2)
  }
}

export function headersForLog(headers: Headers | Record<string, string | string[] | undefined>) {
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers).flatMap(([name, value]) => {
        if (value === undefined) return []
        return [[name, Array.isArray(value) ? value.join(', ') : value] as const]
      })

  return Object.fromEntries(entries.map(([name, value]) => [
    name.toLowerCase(),
    isSensitiveField(name) ? '[REDACTED]' : value
  ]))
}
