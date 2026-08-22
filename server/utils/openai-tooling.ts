type JsonRecord = Record<string, unknown>

export class ToolRequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolRequestValidationError'
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSchema(value: unknown): JsonRecord | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeParameters(value: unknown): JsonRecord {
  const parsed = parseSchema(value)
  if (!parsed) return { type: 'object', properties: {} }

  const parameters = { ...parsed }
  if (typeof parameters.type !== 'string' || !parameters.type.trim()) {
    parameters.type = 'object'
  }
  if (parameters.type === 'object' && !isRecord(parameters.properties)) {
    parameters.properties = {}
  }
  return parameters
}

function requireFunctionName(value: unknown, path: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolRequestValidationError(`${path}.name is required`)
  }
  return value.trim()
}

function normalizeFunctionDefinition(value: JsonRecord, path: string): JsonRecord {
  const name = requireFunctionName(value.name, path)
  const normalized: JsonRecord = {
    name,
    parameters: normalizeParameters(
      value.parameters
      ?? value.input_schema
      ?? value.inputSchema
      ?? value.parameters_json_schema
      ?? value.parametersJsonSchema
    )
  }
  if (typeof value.description === 'string') normalized.description = value.description
  if (typeof value.strict === 'boolean') normalized.strict = value.strict
  return normalized
}

function normalizeTool(value: unknown, index: number): unknown {
  if (!isRecord(value)) {
    throw new ToolRequestValidationError(`tools[${index}] must be an object`)
  }
  if (value.type && value.type !== 'function') {
    throw new ToolRequestValidationError(`tools[${index}].type must be "function"`)
  }

  const definition = isRecord(value.function)
    ? { ...value.function, name: value.function.name ?? value.name }
    : value

  return {
    type: 'function',
    function: normalizeFunctionDefinition(definition, `tools[${index}].function`)
  }
}

function normalizeToolChoice(value: unknown): unknown {
  if (value === true) return 'required'
  if (value === false) return 'none'
  if (value === 'any') return 'required'
  if (typeof value === 'string' || value == null) return value
  if (!isRecord(value)) return value

  const nested = isRecord(value.function) ? value.function : null
  const name = nested?.name ?? value.name
  if (typeof name !== 'string' || !name.trim()) {
    if (value.type === 'any' || value.type === 'required') return 'required'
    if (value.type === 'auto' || value.type === 'none') return value.type
    return value
  }
  return {
    type: 'function',
    function: { name: name.trim() }
  }
}

function normalizeArguments(value: unknown) {
  if (typeof value === 'string') return value
  if (value == null) return '{}'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeToolCall(value: unknown, messageIndex: number, callIndex: number): JsonRecord | unknown {
  if (!isRecord(value)) return value
  const definition = isRecord(value.function) ? value.function : value
  const name = definition.name
  if (typeof name !== 'string' || !name.trim()) return value
  return {
    id: typeof value.id === 'string' && value.id.trim()
      ? value.id
      : `call_legacy_${messageIndex}_${callIndex}`,
    type: 'function',
    function: {
      name: name.trim(),
      arguments: normalizeArguments(definition.arguments ?? value.arguments)
    }
  }
}

function normalizeMessages(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const pendingCalls: Array<{ id: string; name: string }> = []

  return value.map((entry, messageIndex) => {
    if (!isRecord(entry)) return entry
    const message: JsonRecord = { ...entry }

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call, callIndex) => normalizeToolCall(call, messageIndex, callIndex))
      : []

    if (isRecord(message.function_call)) {
      toolCalls.push(normalizeToolCall(message.function_call, messageIndex, toolCalls.length))
      delete message.function_call
    }

    if (toolCalls.length) {
      message.tool_calls = toolCalls
      for (const call of toolCalls) {
        if (!isRecord(call) || !isRecord(call.function)) continue
        if (typeof call.id === 'string' && typeof call.function.name === 'string') {
          pendingCalls.push({ id: call.id, name: call.function.name })
        }
      }
    }

    if (message.role === 'function' || message.role === 'tool') {
      const name = typeof message.name === 'string' ? message.name : null
      let pendingIndex = name ? pendingCalls.findIndex(call => call.name === name) : 0
      if (pendingIndex < 0) pendingIndex = 0
      const pending = pendingCalls.splice(pendingIndex, 1)[0]
      message.role = 'tool'
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id.trim()) {
        message.tool_call_id = pending?.id ?? `call_legacy_result_${messageIndex}`
      }
    }

    return message
  })
}

export function normalizeOpenAIChatRequest(value: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(value)) return { value, changed: false }
  const hasTools = Array.isArray(value.tools)
  const hasLegacyFunctions = Array.isArray(value.functions)
  const hasLegacyFunctionChoice = value.function_call !== undefined
  const hasMessages = Array.isArray(value.messages)
  if (!hasTools && !hasLegacyFunctions && !hasLegacyFunctionChoice && !hasMessages) {
    return { value, changed: false }
  }

  const normalized: JsonRecord = { ...value }
  let changed = false

  if (hasTools) {
    normalized.tools = (value.tools as unknown[]).map(normalizeTool)
    changed = JSON.stringify(normalized.tools) !== JSON.stringify(value.tools)
  } else if (hasLegacyFunctions) {
    normalized.tools = (value.functions as unknown[]).map((definition, index) => {
      if (!isRecord(definition)) {
        throw new ToolRequestValidationError(`functions[${index}] must be an object`)
      }
      return {
        type: 'function',
        function: normalizeFunctionDefinition(definition, `functions[${index}]`)
      }
    })
    changed = true
  }

  if (hasLegacyFunctions) {
    delete normalized.functions
    changed = true
  }

  if (value.tool_choice !== undefined) {
    const toolChoice = normalizeToolChoice(value.tool_choice)
    normalized.tool_choice = toolChoice
    if (JSON.stringify(toolChoice) !== JSON.stringify(value.tool_choice)) changed = true
  } else if (hasLegacyFunctionChoice) {
    normalized.tool_choice = normalizeToolChoice(value.function_call)
    changed = true
  }

  if (hasLegacyFunctionChoice) {
    delete normalized.function_call
    changed = true
  }

  if (hasMessages) {
    const messages = normalizeMessages(value.messages)
    normalized.messages = messages
    if (JSON.stringify(messages) !== JSON.stringify(value.messages)) changed = true
  }

  return { value: changed ? normalized : value, changed }
}

export function normalizeOpenAIChatRequestBody(rawBody: string): {
  body: string
  parsed: JsonRecord | null
  changed: boolean
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { body: rawBody, parsed: null, changed: false }
  }

  const normalized = normalizeOpenAIChatRequest(parsed)
  return {
    body: normalized.changed ? JSON.stringify(normalized.value) : rawBody,
    parsed: isRecord(normalized.value) ? normalized.value : null,
    changed: normalized.changed
  }
}
