export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const subscription = await getProxySubscription(id)
  if (!subscription) {
    throw createError({ statusCode: 404, statusMessage: '订阅不存在' })
  }
  const body = await readBody<{ node_ids?: unknown }>(event)
  const nodeIds = Array.isArray(body?.node_ids) ? body.node_ids : []
  const startedAt = Date.now()
  const accountsBefore = new Map((await listAccounts()).map(account => [account.id, {
    name: account.name,
    ip_pool_id: account.ip_pool_id
  }]))
  try {
    const result = await importSubscriptionNodes(id, nodeIds)
    await logOperation({
      operation: 'proxy_subscription_import',
      trigger_type: 'manual',
      status: 'success',
      detail: `从订阅「${subscription.name || redactSubscriptionUrl(subscription.url)}」导入 ${result.created.length} 个节点，跳过 ${result.skipped} 个重复、${result.unsupported} 个不支持，自动绑定 ${result.assigned} 个账号`,
      request_detail: { subscription_id: id, url: redactSubscriptionUrl(subscription.url), node_ids: nodeIds },
      response_detail: {
        created: result.created.map(entry => ({
          id: entry.id,
          name: entry.name,
          proxy_url: redactProxyUrl(entry.proxy_url)
        })),
        skipped_duplicates: result.skipped,
        unsupported_selected: result.unsupported,
        assigned_accounts: result.assigned,
        assignment_changes: result.changes.map(change => ({
          account_id: change.accountId,
          account_name: accountsBefore.get(change.accountId)?.name ?? null,
          from_ip_pool_id: accountsBefore.get(change.accountId)?.ip_pool_id ?? null,
          to_ip_pool_id: change.ipPoolId
        }))
      },
      duration_ms: Date.now() - startedAt
    })
    return {
      created: result.created.length,
      skipped: result.skipped,
      unsupported: result.unsupported,
      assigned: result.assigned
    }
  } catch (error: any) {
    const message = error?.statusMessage || (error instanceof Error ? error.message : String(error))
    await logOperation({
      operation: 'proxy_subscription_import',
      trigger_type: 'manual',
      status: 'error',
      detail: `从订阅「${subscription.name || redactSubscriptionUrl(subscription.url)}」导入节点失败`,
      error_message: message,
      request_detail: { subscription_id: id, url: redactSubscriptionUrl(subscription.url), node_ids: nodeIds },
      response_detail: error,
      duration_ms: Date.now() - startedAt
    })
    if (error?.statusCode) throw error
    throw createError({ statusCode: 400, statusMessage: message || '导入失败' })
  }
})
