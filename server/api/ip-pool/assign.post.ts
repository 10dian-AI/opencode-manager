import { ensureStableIpAssignments } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const changes = await ensureStableIpAssignments()
  return {
    changed: changes.length,
    assigned: changes.filter(change => change.ipPoolId !== null).length,
    unassigned: changes.filter(change => change.ipPoolId === null).length
  }
})
