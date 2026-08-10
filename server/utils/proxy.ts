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
import { createCallLog } from './call-logs'

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
  // Replace "opencode go" references with more official language
  const officialMessage = message
    .replace(/opencode go/gi, 'OpenCode Manager')
    .replace(/go service/gi, 'service')

  return new Response(JSON.stringify({
    error: { message: officialMessage, type: 'server_error', code }
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

export async function proxyChatCompletions(
  event: H3Event,
  apiKeyInfo?: { key: string; keyId: number | null; keyPrefix: string }
): Promise<Response> {
  const requestLifecycle = createProxyRequestLifecycle(event)
  const upstreamTimeoutSignal = AbortSignal.timeout(PROXY_UPSTREAM_TIMEOUT_MS)
  const upstreamSignal = AbortSignal.any([requestLifecycle.signal, upstreamTimeoutSignal])

  const startTime = Date.now()
  const callerIp = getHeader(event, 'x-forwarded-for') || getHeader(event, 'x-real-ip') || event.node.req.socket?.remoteAddress || null
  let logData: {
    modelName: string | null
    accountId: number | null
    accountName: string | null
    isStream: boolean
    promptTokens: number | null
    completionTokens: number | null
    cachedPromptTokens: number | null
    createdPromptTokens: number | null
    firstTokenTime: number | null
    statusCode: number | null
    errorMessage: string | null
  } = {
    modelName: null,
    accountId: null,
    accountName: null,
    isStream: false,
    promptTokens: null,
    completionTokens: null,
    cachedPromptTokens: null,
    createdPromptTokens: null,
    firstTokenTime: null,
    statusCode: null,
    errorMessage: null
  }

  try {
    return await proxyWorkers.run(async () => {
      const body = await readRawBody(event)
      if (!body) {
        logData.statusCode = 400
        logData.errorMessage = 'Request body is required'
        return jsonError(400, 'Request body is required', 'invalid_request')
      }

      // Extract model name and stream flag from request body
      try {
        const requestData = JSON.parse(body.toString())
        logData.modelName = requestData.model || null
        logData.isStream = Boolean(requestData.stream)
      } catch {}

      const slot = await waitForAccountSlot(upstreamSignal)
      if (!slot) {
        logData.statusCode = 503
        logData.errorMessage = '号池中暂无可用账号，请稍后重试'
        return jsonError(503, '号池中暂无可用账号，请稍后重试', 'pool_unavailable')
      }
      const { account, release: releaseAccountSlot } = slot
      logData.accountId = account.id
      logData.accountName = account.name || account.email || null

      try {
        try {
          const fetchImpl = await createAccountFetch(account)
          const firstTokenStartTime = Date.now()
          let firstTokenRecorded = false

          const response = await fetchImpl(`${GO_BASE}/chat/completions`, {
            method: 'POST',
            headers: upstreamHeaders(event, account.upstream_api_key!),
            body,
            signal: upstreamSignal
          })

          logData.statusCode = response.status

          if (response.status === 401 || response.status === 403) {
            logData.errorMessage = `Upstream API key rejected (status ${response.status})`
            await invalidateUpstreamApiKey(
              account.id,
              `Upstream API key rejected (status ${response.status}); cached key cleared.`
            ).catch(() => {})
          } else if (ACCOUNT_ERROR_STATUSES.has(response.status) || response.status >= 500) {
            logData.errorMessage = `Upstream error (status ${response.status})`
            refreshAfterUpstreamError(account.id)
          }

          // For streaming responses, wrap the body to track tokens
          if (logData.isStream && response.body && response.ok) {
            const reader = response.body.getReader()
            let released = false
            const decoder = new TextDecoder()

            const finish = () => {
              if (released) return
              released = true
              upstreamSignal?.removeEventListener('abort', abort)
              void releaseAccountSlot()
            }
            const abort = () => {
              finish()
              void reader.cancel(upstreamSignal?.reason).catch(() => {})
            }
            upstreamSignal?.addEventListener('abort', abort, { once: true })
            if (upstreamSignal?.aborted) abort()

            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const chunk = await reader.read()
                  if (chunk.done) {
                    finish()
                    controller.close()
                    // Log the streaming call
                    await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
                  } else {
                    // Record first token time
                    if (!firstTokenRecorded) {
                      logData.firstTokenTime = Date.now() - firstTokenStartTime
                      firstTokenRecorded = true
                    }

                    // Try to extract token usage from SSE data
                    const text = decoder.decode(chunk.value, { stream: true })
                    const lines = text.split('\n')
                    for (const line of lines) {
                      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                        try {
                          const data = JSON.parse(line.slice(6))
                          if (data.usage) {
                            logData.promptTokens = data.usage.prompt_tokens || null
                            logData.completionTokens = data.usage.completion_tokens || null
                            logData.cachedPromptTokens = data.usage.prompt_tokens_details?.cached_tokens || null
                            logData.createdPromptTokens = data.usage.prompt_tokens_details?.created_tokens || null
                          }
                        } catch {}
                      }
                    }

                    controller.enqueue(chunk.value)
                  }
                } catch (error) {
                  finish()
                  controller.error(error)
                  await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
                }
              },
              async cancel(reason) {
                finish()
                await reader.cancel(reason).catch(() => {})
                await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
              }
            })

            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            })
          } else {
            // For non-streaming responses, extract usage from response body
            if (response.ok && !logData.isStream) {
              const clonedResponse = response.clone()
              try {
                const data = await clonedResponse.json()
                if (data.usage) {
                  logData.promptTokens = data.usage.prompt_tokens || null
                  logData.completionTokens = data.usage.completion_tokens || null
                  logData.cachedPromptTokens = data.usage.prompt_tokens_details?.cached_tokens || null
                  logData.createdPromptTokens = data.usage.prompt_tokens_details?.created_tokens || null
                }
                logData.firstTokenTime = Date.now() - firstTokenStartTime
              } catch {}
            }

            const result = responseHoldingAccountSlot(response, releaseAccountSlot, upstreamSignal)
            await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
            return result
          }
        } catch (error) {
          await releaseAccountSlot()
          throw error
        }
      } catch {
        if (requestLifecycle.signal.aborted) throw new ProxyRequestAbortedError()
        if (upstreamTimeoutSignal.aborted) {
          logData.statusCode = 504
          logData.errorMessage = '上游请求超时'
          return jsonError(504, '上游请求超时', 'upstream_timeout')
        }
        refreshAfterUpstreamError(account.id)
        logData.statusCode = 502
        logData.errorMessage = '上游请求失败'
        return jsonError(502, '上游请求失败', 'upstream_error')
      }
    }, {
      signal: upstreamSignal,
      queueTimeoutMs: PROXY_QUEUE_TIMEOUT_MS
    })
  } catch (error) {
    if (error instanceof ProxyRequestAbortedError) {
      logData.statusCode = 499
      logData.errorMessage = '客户端已关闭请求'
      await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
      return jsonError(499, '客户端已关闭请求', 'client_closed_request')
    }
    if (error instanceof ProxyQueueTimeoutError) {
      logData.statusCode = 503
      logData.errorMessage = '代理队列等待超时，请稍后重试'
      await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
      return jsonError(503, '代理队列等待超时，请稍后重试', 'proxy_queue_timeout')
    }
    if (error instanceof ProxyPoolSaturatedError) {
      logData.statusCode = 503
      logData.errorMessage = '代理队列已满，请稍后重试'
      await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
      return jsonError(503, '代理队列已满，请稍后重试', 'proxy_saturated')
    }
    logData.statusCode = 500
    logData.errorMessage = '代理服务失败'
    await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
    return jsonError(500, '代理服务失败', 'proxy_worker_error')
  }
}

async function logCallCompletion(
  apiKeyInfo: { key: string; keyId: number | null; keyPrefix: string } | undefined,
  logData: {
    modelName: string | null
    accountId: number | null
    accountName: string | null
    isStream: boolean
    promptTokens: number | null
    completionTokens: number | null
    cachedPromptTokens: number | null
    createdPromptTokens: number | null
    firstTokenTime: number | null
    statusCode: number | null
    errorMessage: string | null
  },
  callerIp: string | null,
  startTime: number
) {
  const endTime = Date.now()
  const responseTimeMs = endTime - startTime
  const throughput = logData.completionTokens && logData.firstTokenTime
    ? (logData.completionTokens / (responseTimeMs - logData.firstTokenTime)) * 1000
    : null

  try {
    await createCallLog({
      timestamp: new Date(startTime).toISOString(),
      api_key_id: apiKeyInfo?.keyId || null,
      api_key_prefix: apiKeyInfo?.keyPrefix || null,
      model_name: logData.modelName,
      account_id: logData.accountId,
      account_name: logData.accountName,
      is_stream: logData.isStream,
      prompt_tokens: logData.promptTokens,
      completion_tokens: logData.completionTokens,
      cached_prompt_tokens: logData.cachedPromptTokens,
      created_prompt_tokens: logData.createdPromptTokens,
      throughput,
      first_token_time_ms: logData.firstTokenTime,
      response_time_ms: responseTimeMs,
      caller_ip: callerIp,
      status_code: logData.statusCode,
      error_message: logData.errorMessage
    })
  } catch (error) {
    // Log silently fails to not affect the main request
    console.error('Failed to log call:', error)
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
      return jsonError(503, 'No active accounts are available in the pool', 'pool_unavailable')
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
