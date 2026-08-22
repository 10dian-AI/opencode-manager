import { describe, expect, test } from 'bun:test'
import {
  normalizeOpenAIChatRequest,
  normalizeOpenAIChatRequestBody,
  ToolRequestValidationError
} from '../server/utils/openai-tooling'

describe('OpenAI-compatible tool request normalization', () => {
  test('leaves requests without tool fields byte-for-byte unchanged', () => {
    const raw = JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    }, null, 2)

    expect(normalizeOpenAIChatRequestBody(raw)).toEqual({
      body: raw,
      parsed: JSON.parse(raw),
      changed: false
    })
  })

  test('accepts flat Responses-style function tools and fills an object schema', () => {
    const result = normalizeOpenAIChatRequest({
      tools: [{
        type: 'function',
        name: 'lookup_weather',
        description: 'Look up weather'
      }],
      tool_choice: { type: 'function', name: 'lookup_weather' }
    })

    expect(result.changed).toBe(true)
    expect(result.value).toEqual({
      tools: [{
        type: 'function',
        function: {
          name: 'lookup_weather',
          description: 'Look up weather',
          parameters: { type: 'object', properties: {} }
        }
      }],
      tool_choice: {
        type: 'function',
        function: { name: 'lookup_weather' }
      }
    })
  })

  test('converts input_schema and string schemas to function.parameters', () => {
    const result = normalizeOpenAIChatRequest({
      tools: [
        { name: 'search', input_schema: { properties: { q: { type: 'string' } }, required: ['q'] } },
        { type: 'function', function: { name: 'read', inputSchema: '{"type":"object","properties":{"id":{"type":"number"}}}' } }
      ]
    })

    expect(result.value).toEqual({
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            parameters: {
              properties: { q: { type: 'string' } },
              required: ['q'],
              type: 'object'
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'read',
            parameters: { type: 'object', properties: { id: { type: 'number' } } }
          }
        }
      ]
    })
  })

  test('accepts common tool schema aliases and Anthropic-style tool choices', () => {
    const result = normalizeOpenAIChatRequest({
      tools: [{
        type: 'function',
        name: 'lookup',
        parametersJsonSchema: {
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }],
      tool_choice: { type: 'any' }
    })

    expect(result.value).toEqual({
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }
      }],
      tool_choice: 'required'
    })
  })

  test('converts legacy functions, function_call, and function result messages', () => {
    const result = normalizeOpenAIChatRequest({
      functions: [{ name: 'calculate', parameters: { type: 'object' } }],
      function_call: { name: 'calculate' },
      messages: [
        { role: 'assistant', function_call: { name: 'calculate', arguments: { value: 2 } } },
        { role: 'function', name: 'calculate', content: '4' }
      ]
    })

    expect(result.value).toEqual({
      tools: [{
        type: 'function',
        function: { name: 'calculate', parameters: { type: 'object', properties: {} } }
      }],
      tool_choice: { type: 'function', function: { name: 'calculate' } },
      messages: [
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_legacy_0_0',
            type: 'function',
            function: { name: 'calculate', arguments: '{"value":2}' }
          }]
        },
        {
          role: 'tool',
          name: 'calculate',
          content: '4',
          tool_call_id: 'call_legacy_0_0'
        }
      ]
    })
  })

  test('preserves tool_call_id on current tool result messages', () => {
    const result = normalizeOpenAIChatRequest({
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'read', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'call_123', content: 'done' }
      ]
    })

    expect((result.value as any).messages[1].tool_call_id).toBe('call_123')
  })

  test('reports an actionable client error for a tool without a name', () => {
    expect(() => normalizeOpenAIChatRequest({ tools: [{ type: 'function', parameters: {} }] }))
      .toThrow(ToolRequestValidationError)
  })

  test('reports unsupported built-in tool types before contacting the upstream', () => {
    expect(() => normalizeOpenAIChatRequest({ tools: [{ type: 'web_search_preview' }] }))
      .toThrow('tools[0].type must be "function"')
  })
})
