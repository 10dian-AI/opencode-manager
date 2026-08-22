export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const id = Number(getRouterParam(event, 'id'))
  const subscription = await getProxySubscription(id)
  if (!subscription) {
    throw createError({ statusCode: 404, statusMessage: '订阅不存在' })
  }
  const nodes = await listSubscriptionNodes(id)
  return {
    subscription: { ...subscription, url: redactSubscriptionUrl(subscription.url) },
    nodes: nodes.map(({ uri: _uri, ...node }) => node)
  }
})
