export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const subscriptions = await listProxySubscriptions()
  return {
    subscriptions: subscriptions.map(subscription => ({
      ...subscription,
      url: redactSubscriptionUrl(subscription.url)
    }))
  }
})
