export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const subscription = await getProxySubscription(id)
  if (!subscription) {
    throw createError({ statusCode: 404, statusMessage: '订阅不存在' })
  }
  const startedAt = Date.now()
  try {
    const nodes = await refreshProxySubscription(subscription)
    await logOperation({
      operation: 'proxy_subscription_refresh',
      trigger_type: 'manual',
      status: 'success',
      detail: `订阅「${subscription.name || redactSubscriptionUrl(subscription.url)}」刷新成功，共 ${nodes.length} 个节点（${nodes.filter(node => node.supported).length} 个可用）`,
      request_detail: { subscription_id: id, url: redactSubscriptionUrl(subscription.url) },
      response_detail: {
        total_nodes: nodes.length,
        supported_nodes: nodes.filter(node => node.supported).length,
        unsupported_nodes: nodes
          .filter(node => !node.supported)
          .map(node => ({ name: node.name, protocol: node.protocol, reason: node.unsupported_reason }))
      },
      duration_ms: Date.now() - startedAt
    })
    const storedNodes = await listSubscriptionNodes(id)
    return {
      node_count: nodes.length,
      supported_count: nodes.filter(node => node.supported).length,
      nodes: storedNodes.map(({ uri: _uri, ...node }) => node)
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error)
    const message = redactSubscriptionError(rawMessage, subscription.url)
    await recordSubscriptionError(id, message)
    await logOperation({
      operation: 'proxy_subscription_refresh',
      trigger_type: 'manual',
      status: 'error',
      detail: `订阅「${subscription.name || redactSubscriptionUrl(subscription.url)}」刷新失败`,
      error_message: message,
      request_detail: { subscription_id: id, url: redactSubscriptionUrl(subscription.url) },
      response_detail: { error: message },
      duration_ms: Date.now() - startedAt
    })
    throw createError({ statusCode: 502, statusMessage: `刷新订阅失败：${message}` })
  }
})
