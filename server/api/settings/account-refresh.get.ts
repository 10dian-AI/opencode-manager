export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return getAccountRefreshSettings()
})
