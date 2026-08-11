import { updateIpPoolEntry, listPublicIpPoolEntries, isUniqueViolation } from '~/server/utils/ip-pool'
import { ensureStableIpAssignments } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody<{
    name?: string | null
    proxy_url?: unknown
    enabled?: boolean
  }>(event)

  try {
    const updated = await updateIpPoolEntry(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(typeof body.proxy_url === 'string' && body.proxy_url.trim()
        ? { proxy_url: body.proxy_url }
        : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {})
    })
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Proxy not found' })
    const changes = await ensureStableIpAssignments()
    return {
      entry: (await listPublicIpPoolEntries()).find(entry => entry.id === id),
      reassigned: changes.length
    }
  } catch (error: any) {
    if (error?.statusCode) throw error
    throw createError({
      statusCode: isUniqueViolation(error) ? 409 : 400,
      statusMessage: error instanceof Error ? error.message : 'Invalid proxy'
    })
  }
})
