export default defineNuxtRouteMiddleware(async (to) => {
  const { authenticated, check } = useAuth()

  if (authenticated.value === null) {
    await check()
  }

  if (to.path === '/login') {
    if (authenticated.value) return navigateTo('/', { replace: true })
    return
  }

  if (!authenticated.value) {
    return navigateTo({
      path: '/login',
      query: to.fullPath === '/' ? undefined : { redirect: to.fullPath }
    }, { replace: true })
  }
})
