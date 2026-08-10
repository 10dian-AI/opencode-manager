export default defineEventHandler(async (event) => {
  const apiKeyInfo = await requireApiKey(event)
  return proxyChatCompletions(event, apiKeyInfo)
})
