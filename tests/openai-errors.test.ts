import { describe, expect, test } from 'bun:test'
import { normalizeOpenAIError } from '../server/utils/openai-errors'

describe('OpenAI-compatible route errors', () => {
  test('preserves structured API key errors', () => {
    expect(normalizeOpenAIError({
      statusCode: 401,
      data: {
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      }
    })).toEqual({
      statusCode: 401,
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    })
  })

  test('uses server_error only for unstructured server failures', () => {
    expect(normalizeOpenAIError({ statusCode: 502, statusMessage: 'Upstream failed' })).toEqual({
      statusCode: 502,
      error: {
        message: 'Upstream failed',
        type: 'server_error',
        code: 502
      }
    })
  })
})
