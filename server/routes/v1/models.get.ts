export default defineEventHandler(async (event) => {
  await requireApiKey(event)
  return proxyModels(event)
})
