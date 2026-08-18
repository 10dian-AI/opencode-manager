import { normalizeOpenAIError } from '../../../utils/openai-errors'

export default defineEventHandler(async (event) => {
  try {
    const apiKeyInfo = await requireApiKey(event)
    return await proxyChatCompletions(event, apiKeyInfo)
  } catch (error) {
    const normalized = normalizeOpenAIError(error)
    setResponseStatus(event, normalized.statusCode)
    return { error: normalized.error }
  }
})
