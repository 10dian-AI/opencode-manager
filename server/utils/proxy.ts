import type { H3Event } from 'h3'
import {
  AdaptiveProxyWorkerController,
  ProxyPoolSaturatedError,
  ProxyQueueTimeoutError,
  ProxyRequestAbortedError,
  ProxyWorkerPool
} from './proxy-worker-pool'
import { createProxyRequestLifecycle } from './proxy-request-lifecycle'
import { createAccountFetch } from './account-fetch'
import { invalidateUpstreamApiKey } from './accounts'

const GO_BASE = 'https://opencode.ai/zen/go/v1'
const ACCOUNT_ERROR_STATUSES = new Set([401, 403, 408, 409, 429])
const PROXY_MIN_WORKERS = positiveInteger(
  process.env.PROXY_MIN_WORKERS || process.env.PROXY_WORKERS,
  4
)
const PROXY_MAX_WORKERS = Math.max(
  PROXY_MIN_WORKERS,
  positiveInteger(process.env.PROXY_MAX_WORKERS, 32)
)
const PROXY_QUEUE_LIMIT = positiveInteger(process.env.PROXY_QUEUE_LIMIT, 8192)
const PROXY_QUEUE_TIMEOUT_MS = positiveInteger(process.env.PROXY_QUEUE_TIMEOUT_MS, 30_000)
const PROXY_UPSTREAM_TIMEOUT_MS = positiveInteger(process.env.PROXY_UPSTREAM_TIMEOUT_MS, 10 * 60_000)
const PROXY_ACCOUNT_CONCURRENCY = positiveInteger(process.env.PROXY_ACCOUNT_CONCURRENCY, 2)
const proxyWorkers = new ProxyWorkerPool(PROXY_MIN_WORKERS, PROXY_QUEUE_LIMIT)
const proxyWorkerController = new AdaptiveProxyWorkerController(proxyWorkers, {
  minWorkers: PROXY_MIN_WORKERS,
  maxWorkers: PROXY_MAX_WORKERS
})
proxyWorkerController.start()

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function jsonError(status: number, message: string, code: string) {
  return new Response(JSON.stringify({
    error: { message, type: 'server_error', code }
  }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function upstreamHeaders(event: H3Event, apiKey?: string) {
  const headers = new Headers()
  const contentType = getHeader(event, 'content-type')
  const accept = getHeader(event, 'accept')
  if (contentType) headers.set('content-type', contentType)
  if (accept) headers.set('accept', accept)
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
  return headers
}

function refreshAfterUpstreamError(accountId: number) {
  void refreshAccount(accountId).catch(() => {
    // The in-memory polling schedule will retry this account later.
  })
}

async function waitForAccountSlot(signal: AbortSignal) {
  while (!signal.aborted) {
    const accounts = await getProxyCandidates()
    if (!accounts.length) return null
    const first = await reserveProxyCandidate()
    if (!first) return null
    const start = accounts.findIndex(account => account.id === first.id)
    for (let attempt = 0; attempt < accounts.length; attempt++) {
      const account = accounts[(Math.max(0, start) + attempt) % accounts.length]!
      const release = await tryAcquireAccountProxySlot(
        account.id,
        PROXY_ACCOUNT_CONCURRENCY,
        PROXY_UPSTREAM_TIMEOUT_MS + 60_000
      )
      if (release) return { account, release }
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(finish, 25)
      const abort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(signal.reason || new ProxyRequestAbortedError())
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  throw signal.reason || new ProxyRequestAbortedError()
}

function responseHoldingAccountSlot(
  response: Response,
  release: () => Promise<void>,
  signal?: AbortSignal
) {
  if (!response.body) {
    void release()
    return response
  }
  const reader = response.body.getReader()
  let released = false
  const finish = () => {
    if (released) return
    released = true
    signal?.removeEventListener('abort', abort)
    void release()
  }
  const abort = () => {
    finish()
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          finish()
          controller.close()
        } else {
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish()
      await reader.cancel(reason).catch(() => {})
    }
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

export async function proxyChatCompletions(event: H3Event): Promise<Response> {
  const requestLifecycle = createProxyRequestLifecycle(event)
  const upstreamTimeoutSignal = AbortSignal.timeout(PROXY_UPSTREAM_TIMEOUT_MS)
  const upstreamSignal = AbortSignal.any([requestLifecycle.signal, upstreamTimeoutSignal])
  try {
    return await proxyWorkers.run(async () => {
      const body = await readRawBody(event)
      if (!body) return jsonError(400, 'Request body is required', 'invalid_request')

      const slot = await waitForAccountSlot(upstreamSignal)
      if (!slot) {
        return jsonError(503, 'No active OpenCode Go accounts are available', 'pool_unavailable')
      }
      const { account, release: releaseAccountSlot } = slot

      try {
        try {
          const fetchImpl = await createAccountFetch(account)
          const response = await fetchImpl(`${GO_BASE}/chat/completions`, {
            method: 'POST',
            headers: upstreamHeaders(event, account.upstream_api_key!),
            body,
            signal: upstreamSignal
          })
          if (response.status === 401 || response.status === 403) {
            await invalidateUpstreamApiKey(
              account.id,
              `Upstream API key rejected (status ${response.status}); cached key cleared.`
            ).catch(() => {})
          } else if (ACCOUNT_ERROR_STATUSES.has(response.status) || response.status >= 500) {
            refreshAfterUpstreamError(account.id)
          }
          return responseHoldingAccountSlot(response, releaseAccountSlot, upstreamSignal)
        } catch (error) {
          await releaseAccountSlot()
          throw error
        }
      } catch {
        if (requestLifecycle.signal.aborted) throw new ProxyRequestAbortedError()
        if (upstreamTimeoutSignal.aborted) {
          return jsonError(504, 'Upstream request timed out', 'upstream_timeout')
        }
        refreshAfterUpstreamError(account.id)
        return jsonError(502, 'Upstream request failed', 'upstream_error')
      }
    }, {
      signal: upstreamSignal,
      queueTimeoutMs: PROXY_QUEUE_TIMEOUT_MS
    })
  } catch (error) {
    if (error instanceof ProxyRequestAbortedError) {
      return jsonError(499, 'Client closed the request', 'client_closed_request')
    }
    if (error instanceof ProxyQueueTimeoutError) {
      return jsonError(503, 'Proxy worker queue wait timed out', 'proxy_queue_timeout')
    }
    if (error instanceof ProxyPoolSaturatedError) {
      return jsonError(503, 'Proxy worker queue is full', 'proxy_saturated')
    }
    return jsonError(500, 'Proxy worker failed', 'proxy_worker_error')
  }
}

export async function proxyModels(event: H3Event): Promise<Response> {
  const lifecycle = createProxyRequestLifecycle(event)
  const timeout = AbortSignal.timeout(Math.min(PROXY_UPSTREAM_TIMEOUT_MS, 60_000))
  const signal = AbortSignal.any([lifecycle.signal, timeout])
  let release: (() => Promise<void>) | null = null
  try {
    const slot = await waitForAccountSlot(signal)
    if (!slot) {
      return jsonError(503, 'No active OpenCode Go accounts are available', 'pool_unavailable')
    }
    const { account } = slot
    release = slot.release
    const fetchImpl = await createAccountFetch(account)
    const response = await fetchImpl(`${GO_BASE}/models`, {
      headers: upstreamHeaders(event, account.upstream_api_key || undefined),
      signal
    })
    if (response.status === 401 || response.status === 403) {
      await invalidateUpstreamApiKey(
        account.id,
        `Upstream API key rejected (status ${response.status}); cached key cleared.`
      ).catch(() => {})
    } else if (!response.ok) {
      refreshAfterUpstreamError(account.id)
    }
    return responseHoldingAccountSlot(response, release, signal)
  } catch {
    if (release) await release()
    if (lifecycle.signal.aborted) {
      return jsonError(499, 'Client closed the request', 'client_closed_request')
    }
    if (timeout.aborted) {
      return jsonError(504, 'Upstream request timed out', 'upstream_timeout')
    }
    return jsonError(502, 'Failed to load upstream models', 'upstream_error')
  }
}
