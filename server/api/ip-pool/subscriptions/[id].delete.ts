export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const subscription = await getProxySubscription(id)
  if (!subscription) {
    throw createError({ statusCode: 404, statusMessage: '订阅不存在' })
  }
  const startedAt = Date.now()
  const requestDetail = {
    subscription_id: id,
    name: subscription.name,
    url: redactSubscriptionUrl(subscription.url)
  }
  try {
    await deleteProxySubscription(id)
    await logOperation({
      operation: 'proxy_subscription_delete',
      trigger_type: 'manual',
      status: 'success',
      detail: `订阅「${subscription.name || redactSubscriptionUrl(subscription.url)}」已删除，已导入的代理节点保留在 IP 池中`,
      request_detail: requestDetail,
      response_detail: { deleted: true, imported_proxies_retained: true },
      duration_ms: Date.now() - startedAt
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除订阅失败'
    await logOperation({
      operation: 'proxy_subscription_delete',
      trigger_type: 'manual',
      status: 'error',
      detail: `订阅「${subscription.name || redactSubscriptionUrl(subscription.url)}」删除失败`,
      error_message: message,
      request_detail: requestDetail,
      response_detail: error,
      duration_ms: Date.now() - startedAt
    })
    throw error
  }
})
