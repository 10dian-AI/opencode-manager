export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody<{
    name?: string | null
    proxy_url?: unknown
    enabled?: boolean
  }>(event)
  const startedAt = Date.now()
  const current = await getIpPoolEntry(id)
  const requestDetail = {
    proxy_id: id,
    before: current ? {
      name: current.name,
      proxy_url: redactProxyUrl(current.proxy_url),
      enabled: current.enabled,
      subscription_id: current.subscription_id,
      region: current.region,
      health: current.health
    } : null,
    changes: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.proxy_url !== undefined ? { proxy_url: redactProxyInput(body.proxy_url) } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {})
    }
  }

  try {
    if (!current) throw createError({ statusCode: 404, statusMessage: 'Proxy not found' })
    const accountsBefore = new Map((await listAccounts()).map(account => [account.id, {
      name: account.name,
      ip_pool_id: account.ip_pool_id
    }]))
    const updated = await updateIpPoolEntry(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(typeof body.proxy_url === 'string' && body.proxy_url.trim()
        ? { proxy_url: body.proxy_url }
        : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {})
    })
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Proxy not found' })
    const changes = await ensureStableIpAssignments()
    const result = {
      entry: (await listPublicIpPoolEntries()).find(entry => entry.id === id),
      reassigned: changes.length
    }
    await logOperation({
      operation: 'ip_pool_update',
      trigger_type: 'manual',
      status: 'success',
      detail: `代理 #${id} 已更新${changes.length ? `，迁移 ${changes.length} 个账号绑定` : ''}`,
      request_detail: requestDetail,
      response_detail: {
        ...result,
        assignment_changes: changes.map(change => ({
          account_id: change.accountId,
          account_name: accountsBefore.get(change.accountId)?.name ?? null,
          from_ip_pool_id: accountsBefore.get(change.accountId)?.ip_pool_id ?? null,
          to_ip_pool_id: change.ipPoolId
        }))
      },
      duration_ms: Date.now() - startedAt
    })
    return result
  } catch (error: any) {
    const message = error?.statusMessage || (error instanceof Error ? error.message : 'Invalid proxy')
    await logOperation({
      operation: 'ip_pool_update',
      trigger_type: 'manual',
      status: 'error',
      detail: `代理 #${id} 更新失败`,
      error_message: message,
      request_detail: requestDetail,
      response_detail: error,
      duration_ms: Date.now() - startedAt
    })
    if (error?.statusCode) throw error
    throw createError({
      statusCode: isUniqueViolation(error) ? 409 : 400,
      statusMessage: isUniqueViolation(error) ? '该代理地址已存在' : message
    })
  }
})
