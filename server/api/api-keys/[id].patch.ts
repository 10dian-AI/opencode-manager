export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid key ID' })
  }
  const body = await readBody<{ affinity_enabled?: boolean }>(event)
  if (typeof body?.affinity_enabled !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'affinity_enabled (boolean) is required' })
  }
  const updated = await updateManagedApiKeyAffinity(id, body.affinity_enabled)
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'API key not found' })
  return {
    id: String(updated.id),
    name: updated.name,
    prefix: updated.key_prefix,
    affinity_enabled: updated.affinity_enabled,
    source: 'web' as const,
    created_at: updated.created_at
  }
})
