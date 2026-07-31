export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readBody<{ block_size?: unknown }>(event)
  try {
    const blockSize = await setIpPoolBlockSize(body?.block_size)
    const changes = await ensureStableIpAssignments()
    return { block_size: blockSize, assigned: changes.length }
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Invalid block size'
    })
  }
})
