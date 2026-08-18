export interface OpenAIErrorShape {
  message: string
  type: string
  code: string | number
}

export function normalizeOpenAIError(error: unknown, fallbackMessage = 'Internal server error') {
  const source = error as {
    statusCode?: unknown
    statusMessage?: unknown
    message?: unknown
    data?: { error?: Partial<OpenAIErrorShape> }
  }
  const statusCode = Number(source?.statusCode) || 500
  const provided = source?.data?.error
  const message = typeof provided?.message === 'string'
    ? provided.message
    : typeof source?.statusMessage === 'string'
      ? source.statusMessage
      : typeof source?.message === 'string'
        ? source.message
        : fallbackMessage
  return {
    statusCode,
    error: {
      message,
      type: typeof provided?.type === 'string'
        ? provided.type
        : statusCode >= 500 ? 'server_error' : 'invalid_request_error',
      code: provided?.code ?? statusCode
    } satisfies OpenAIErrorShape
  }
}
