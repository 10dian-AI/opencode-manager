export default defineEventHandler(async (event) => {
  try {
    const apiKeyInfo = await requireApiKey(event)
    return await proxyChatCompletions(event, apiKeyInfo)
  } catch (error) {
    const statusCode = Number((error as any)?.statusCode) || 500
    const message = (error as any)?.statusMessage || (error as any)?.message || 'Internal server error'
    setResponseStatus(event, statusCode)
    return {
      error: {
        message,
        type: 'server_error',
        code: statusCode
      }
    }
  }
})
