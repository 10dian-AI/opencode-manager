import { listPublicIpPoolEntries, listIpPoolEntries, createIpPoolEntries, normalizeProxyUrl } from '~/server/utils/ip-pool'
import { ensureStableIpAssignments } from '~/server/utils/db'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readBody<{ name?: string; proxy_urls?: unknown }>(event)
  if (typeof body?.proxy_urls !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'proxy_urls is required' })
  }

  let proxyUrls: string[]
  try {
    proxyUrls = [...new Set(
      body.proxy_urls
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(normalizeProxyUrl)
    )]
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Invalid proxy URL'
    })
  }
  if (!proxyUrls.length) {
    throw createError({ statusCode: 400, statusMessage: 'At least one proxy URL is required' })
  }

  const existing = new Set((await listIpPoolEntries()).map(entry => entry.proxy_url))
  const pending = proxyUrls.filter(proxyUrl => !existing.has(proxyUrl))
  const created = await createIpPoolEntries(pending.map((proxyUrl, index) => ({
    name: body.name
      ? pending.length === 1 ? body.name : `${body.name} ${index + 1}`
      : undefined,
    proxy_url: proxyUrl
  })))
  const changes = await ensureStableIpAssignments()
  return {
    created: created.length,
    skipped: proxyUrls.length - created.length,
    assigned: changes.filter(change => change.ipPoolId !== null).length,
    entries: await listPublicIpPoolEntries()
  }
})
