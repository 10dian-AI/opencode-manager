import { deleteIpPoolEntry } from '~/server/utils/ip-pool'
import { ensureStableIpAssignments } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const result = await deleteIpPoolEntry(id)
  if (!result.changes) throw createError({ statusCode: 404, statusMessage: 'Proxy not found' })
  const changes = await ensureStableIpAssignments()
  return { ok: true, reassigned: changes.length }
})
