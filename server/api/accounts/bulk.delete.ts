export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody<{ ids?: unknown }>(event)
  const ids = parseAccountIds(body?.ids)
  const existing = new Set((await getAccountsByIds(ids)).map(account => account.id))
  const missingIds = ids.filter(id => !existing.has(id))
  if (missingIds.length) {
    throw createError({
      statusCode: 404,
      statusMessage: `Account not found: ${missingIds.join(', ')}`
    })
  }

  const { changes } = await deleteAccounts(ids)
  for (const id of ids) await removeAccountPollSchedule(id)

  return { ok: true, deleted: changes }
})

function parseAccountIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'ids is required' })
  }
  if (value.length > 1000 || value.some(id => !Number.isSafeInteger(id) || Number(id) <= 0)) {
    throw createError({ statusCode: 400, statusMessage: 'ids must contain valid account IDs' })
  }
  return [...new Set(value as number[])]
}
