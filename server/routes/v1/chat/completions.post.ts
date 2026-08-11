import { requireApiKey } from '~/server/utils/auth'
import { proxyChatCompletions } from '~/server/utils/proxy'

export default defineEventHandler(async (event) => {
  try {
    const apiKeyInfo = await requireApiKey(event)
    return await proxyChatCompletions(event, apiKeyInfo)
  } catch (error) {
    // Ensure OpenAI-compatible error format
    const statusCode = (error as any)?.statusCode || 500
    const message = (error as any)?.message || 'Internal server error'

    return {
      error: {
        message,
        type: 'server_error',
        code: statusCode
      }
    }
  }
})
