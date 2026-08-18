import { normalizeOpenAIError } from '../../utils/openai-errors'

export default defineEventHandler(async (event) => {
  try {
    await requireApiKey(event)
    return await proxyModels(event)
  } catch (error) {
    const normalized = normalizeOpenAIError(error)
    setResponseStatus(event, normalized.statusCode)
    return { error: normalized.error }
  }
})
