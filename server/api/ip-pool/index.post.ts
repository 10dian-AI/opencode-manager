export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readBody<{ name?: string; proxy_urls?: unknown }>(event)
  const startedAt = Date.now()
  const requestDetail = {
    name: body?.name ?? null,
    proxy_urls: typeof body?.proxy_urls === 'string'
      ? body.proxy_urls.split(/\r?\n/).filter(Boolean).map(redactProxyInput)
      : body?.proxy_urls
  }
  try {
    if (typeof body?.proxy_urls !== 'string') {
      throw createError({ statusCode: 400, statusMessage: 'proxy_urls is required' })
    }
    const proxyUrls = [...new Set(
      body.proxy_urls
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(normalizeProxyUrl)
    )]
    if (!proxyUrls.length) {
      throw createError({ statusCode: 400, statusMessage: 'At least one proxy URL is required' })
    }

    const accountsBefore = new Map((await listAccounts()).map(account => [account.id, account.ip_pool_id]))
    const existing = new Set((await listIpPoolEntries()).map(entry => entry.proxy_url))
    const pending = proxyUrls.filter(proxyUrl => !existing.has(proxyUrl))
    const created = await createIpPoolEntries(pending.map((proxyUrl, index) => ({
      name: body.name
        ? pending.length === 1 ? body.name : `${body.name} ${index + 1}`
        : undefined,
      proxy_url: proxyUrl
    })))
    const changes = await ensureStableIpAssignments()
    const result = {
      created: created.length,
      skipped: proxyUrls.length - created.length,
      assigned: changes.filter(change => change.ipPoolId !== null).length,
      entries: await listPublicIpPoolEntries()
    }
    await logOperation({
      operation: 'ip_pool_create',
      trigger_type: 'manual',
      status: 'success',
      detail: `添加 ${created.length} 个代理，跳过 ${result.skipped} 个重复地址，变更 ${changes.length} 个账号绑定`,
      request_detail: requestDetail,
      response_detail: {
        ...result,
        created_entries: created.map(entry => ({
          id: entry.id,
          name: entry.name,
          proxy_url: redactProxyUrl(entry.proxy_url)
        })),
        assignment_changes: changes.map(change => ({
          account_id: change.accountId,
          from_ip_pool_id: accountsBefore.get(change.accountId) ?? null,
          to_ip_pool_id: change.ipPoolId
        }))
      },
      duration_ms: Date.now() - startedAt
    })
    return result
  } catch (error: any) {
    const message = error?.statusMessage || (error instanceof Error ? error.message : 'Invalid proxy URL')
    await logOperation({
      operation: 'ip_pool_create',
      trigger_type: 'manual',
      status: 'error',
      detail: '添加代理失败',
      error_message: message,
      request_detail: requestDetail,
      response_detail: error,
      duration_ms: Date.now() - startedAt
    })
    if (error?.statusCode) throw error
    throw createError({
      statusCode: 400,
      statusMessage: message
    })
  }
})
