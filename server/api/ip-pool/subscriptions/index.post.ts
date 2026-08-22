export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readBody<{ name?: string; url?: unknown }>(event)
  const startedAt = Date.now()
  const requestDetail = {
    name: body?.name ?? null,
    url: typeof body?.url === 'string' ? redactSubscriptionUrl(body.url) : body?.url
  }

  let subscription
  try {
    subscription = await createProxySubscription({ name: body?.name, url: body?.url })
  } catch (error: any) {
    const rawMessage = error?.statusMessage || (isUniqueViolation(error)
      ? '该订阅链接已存在'
      : error instanceof Error ? error.message : '创建订阅失败')
    const message = typeof body?.url === 'string'
      ? redactSubscriptionError(rawMessage, body.url)
      : rawMessage
    await logOperation({
      operation: 'proxy_subscription_create',
      trigger_type: 'manual',
      status: 'error',
      detail: '创建代理订阅失败',
      error_message: message,
      request_detail: requestDetail,
      response_detail: error,
      duration_ms: Date.now() - startedAt
    })
    if (error?.statusCode) throw error
    throw createError({
      statusCode: isUniqueViolation(error) ? 409 : 400,
      statusMessage: message
    })
  }

  try {
    const nodes = await refreshProxySubscription(subscription)
    await logOperation({
      operation: 'proxy_subscription_create',
      trigger_type: 'manual',
      status: 'success',
      detail: `订阅「${subscription.name || redactSubscriptionUrl(subscription.url)}」创建成功，解析出 ${nodes.length} 个节点（${nodes.filter(node => node.supported).length} 个可用）`,
      request_detail: requestDetail,
      response_detail: {
        subscription_id: subscription.id,
        total_nodes: nodes.length,
        supported_nodes: nodes.filter(node => node.supported).length,
        nodes: nodes.map(node => ({
          name: node.name,
          protocol: node.protocol,
          region: node.region,
          supported: node.supported,
          unsupported_reason: node.unsupported_reason
        }))
      },
      duration_ms: Date.now() - startedAt
    })
    const subscriptionSummary = (await listProxySubscriptions())
      .find(item => item.id === subscription.id)
    const publicSubscription = subscriptionSummary
      ? { ...subscriptionSummary, url: redactSubscriptionUrl(subscriptionSummary.url) }
      : undefined
    return {
      subscription: publicSubscription,
      node_count: nodes.length,
      supported_count: nodes.filter(node => node.supported).length
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error)
    const message = redactSubscriptionError(rawMessage, subscription.url)
    await recordSubscriptionError(subscription.id, message)
    await logOperation({
      operation: 'proxy_subscription_create',
      trigger_type: 'manual',
      status: 'error',
      detail: `订阅「${subscription.name || redactSubscriptionUrl(subscription.url)}」已创建，但首次拉取节点失败`,
      error_message: message,
      request_detail: requestDetail,
      response_detail: { subscription_id: subscription.id, error: message },
      duration_ms: Date.now() - startedAt
    })
    throw createError({
      statusCode: 502,
      statusMessage: `订阅已创建，但拉取节点失败：${message}`
    })
  }
})
