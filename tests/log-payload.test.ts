import { describe, expect, test } from 'bun:test'
import { headersForLog, serializeLogPayload } from '../server/utils/log-payload'

describe('log payload serialization', () => {
  test('keeps structured payloads readable while redacting credential fields', () => {
    const serialized = serializeLogPayload({
      request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'hello' }] },
      auth_cookie: 'secret-cookie',
      upstream_api_key: 'secret-key'
    })

    expect(serialized).toContain('"model": "glm-5.2"')
    expect(serialized).toContain('"auth_cookie": "[REDACTED]"')
    expect(serialized).toContain('"upstream_api_key": "[REDACTED]"')
  })

  test('redacts sensitive headers and preserves diagnostic headers', () => {
    expect(headersForLog(new Headers({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
      'x-request-id': 'req-123'
    }))).toEqual({
      authorization: '[REDACTED]',
      'content-type': 'application/json',
      'x-request-id': 'req-123'
    })
  })
})
