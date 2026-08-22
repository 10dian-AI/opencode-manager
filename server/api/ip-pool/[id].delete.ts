export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const startedAt = Date.now()
  const entry = await getIpPoolEntry(id)
  const requestDetail = {
    proxy_id: id,
    entry: entry ? {
      name: entry.name,
      proxy_url: redactProxyUrl(entry.proxy_url),
      enabled: entry.enabled,
      subscription_id: entry.subscription_id,
      region: entry.region,
      health: entry.health
    } : null
  }
  try {
    if (!entry) throw createError({ statusCode: 404, statusMessage: 'Proxy not found' })
    const accountsBefore = new Map((await listAccounts()).map(account => [account.id, {
      name: account.name,
      ip_pool_id: account.ip_pool_id
    }]))
    const result = await deleteIpPoolEntry(id)
    if (!result.changes) throw createError({ statusCode: 404, statusMessage: 'Proxy not found' })
    const changes = await ensureStableIpAssignments()
    const response = { ok: true, reassigned: changes.length }
    await logOperation({
      operation: 'ip_pool_delete',
      trigger_type: 'manual',
      status: 'success',
      detail: `代理 #${id} 已删除${changes.length ? `，迁移 ${changes.length} 个账号绑定` : ''}`,
      request_detail: requestDetail,
      response_detail: {
        ...response,
        assignment_changes: changes.map(change => ({
          account_id: change.accountId,
          account_name: accountsBefore.get(change.accountId)?.name ?? null,
          from_ip_pool_id: accountsBefore.get(change.accountId)?.ip_pool_id ?? null,
          to_ip_pool_id: change.ipPoolId
        }))
      },
      duration_ms: Date.now() - startedAt
    })
    return response
  } catch (error: any) {
    const message = error?.statusMessage || (error instanceof Error ? error.message : '删除失败')
    await logOperation({
      operation: 'ip_pool_delete',
      trigger_type: 'manual',
      status: 'error',
      detail: `代理 #${id} 删除失败`,
      error_message: message,
      request_detail: requestDetail,
      response_detail: error,
      duration_ms: Date.now() - startedAt
    })
    throw error
  }
})
