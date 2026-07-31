export default defineEventHandler(async (event) => {
  await requireApiKey(event)
  return proxyChatCompletions(event)
})
