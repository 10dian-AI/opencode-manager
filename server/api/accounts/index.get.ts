export default defineEventHandler(async (event) => {
  await requireAuth(event)
  return (await listAccounts()).map(toPublicAccount)
})
