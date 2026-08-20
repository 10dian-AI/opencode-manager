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
import { selectAffinityAccountId } from './proxy-affinity'
import { invalidateUpstreamApiKey, markAccountRiskControlled } from './accounts'
import { createCallLog } from './call-logs'
import { headersForLog, serializeLogPayload } from './log-payload'

const GO_BASE = 'https://opencode.ai/zen/go/v1'
const ACCOUNT_ERROR_STATUSES = new Set([401, 403, 408, 409, 429])
const UPSTREAM_ERROR_DETAIL_MAX_LENGTH = 1500
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
    error: {
      message: officialMessage,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code
    }
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

async function readClonedResponseBody(response: Response) {
  try {
    return await response.clone().text()
  } catch {
    return ''
  }
}

function describeUpstreamError(response: Response, raw: string): string {
  const requestId = response.headers.get('x-request-id') || response.headers.get('request-id')
  const compact = raw.replace(/\s+/g, ' ').trim()
  let detail = ''
  if (compact) {
    try {
      const payload = JSON.parse(raw) as {
        error?: { message?: unknown; type?: unknown; code?: unknown } | string
        message?: unknown
      }
      const error = typeof payload.error === 'object' && payload.error !== null
        ? payload.error
        : null
      const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message.trim()
        : typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : typeof payload.message === 'string' && payload.message.trim()
            ? payload.message.trim()
            : null
      const type = typeof error?.type === 'string' && error.type.trim() ? error.type.trim() : null
      const code = typeof error?.code === 'string' && error.code.trim() ? error.code.trim() : null
      detail = [message, type && `type=${type}`, code && `code=${code}`]
        .filter(Boolean)
        .join(' | ')
    } catch {}
    if (!detail) detail = compact
  }

  const parts = [
    detail && detail.slice(0, UPSTREAM_ERROR_DETAIL_MAX_LENGTH),
    requestId && `request_id=${requestId.trim()}`
  ]
    .filter(Boolean)
  return parts.join(' | ')
}

function formatUpstreamError(status: number, detail: string) {
  return `Upstream error (status ${status})${detail ? `: ${detail}` : ''}`
}

function appendUpstreamErrorDetail(message: string, detail: string) {
  return detail ? `${message}: ${detail}` : message
}

function responseLogDetail(response: Response, body: string | null) {
  return serializeLogPayload({
    status: response.status,
    status_text: response.statusText || null,
    headers: headersForLog(response.headers),
    body
  })
}

function localResponseLogDetail(status: number, code: string, message: string, cause?: unknown) {
  return serializeLogPayload({
    status,
    headers: { 'content-type': 'application/json' },
    body: {
      error: {
        message,
        code
      },
      cause: cause ?? null
    }
  })
}

function refreshAfterUpstreamError(accountId: number) {
  void refreshAccount(accountId).catch(() => {
    // The in-memory polling schedule will retry this account later.
  })
}

/**
 * Extract the affinity key from an OpenAI-compatible request body.
 * Checks `user` (session_id by convention) first, then custom extension fields.
 */
function extractAffinityKey(body: string): string | null {
  try {
    const data = JSON.parse(body)
    if (typeof data.user === 'string' && data.user.trim()) return data.user.trim()
    if (typeof data?.metadata?.prompt_cache_key === 'string' && data.metadata.prompt_cache_key.trim()) {
      return data.metadata.prompt_cache_key.trim()
    }
  } catch {}
  return null
}

async function waitForAccountSlotAffinity(signal: AbortSignal, affinityKey: string) {
  while (!signal.aborted) {
    const accounts = await getProxyCandidates()
    if (!accounts.length) return null
    const affinityAccountId = selectAffinityAccountId(
      affinityKey,
      accounts.map(account => account.id)
    )
    const start = accounts.findIndex(account => account.id === affinityAccountId)
    // Try affinity account first, then fall back to the rest in order
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
      const finish = () => { signal.removeEventListener('abort', abort); resolve() }
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

async function waitForAccountSlot(signal: AbortSignal) {
  while (!signal.aborted) {
    const accounts = await getProxyCandidates()
    if (!accounts.length) return null
    // Candidates are ordered by subscription end time. Prefer the account
    // expiring soonest and fall back only when its concurrency slots are busy.
    for (const account of accounts) {
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
  apiKeyInfo?: { key: string; keyId: number | null; keyPrefix: string; affinityEnabled?: boolean }
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
    requestDetail: string | null
    responseDetail: string | null
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
    errorMessage: null,
    requestDetail: null,
    responseDetail: null
  }

  try {
    return await proxyWorkers.run(async () => {
      const body = await readRawBody(event)
      const requestBody = body?.toString() || null
      logData.requestDetail = serializeLogPayload({
        method: event.node.req.method || 'POST',
        incoming_url: event.node.req.url || null,
        headers: headersForLog(event.node.req.headers || {}),
        body: requestBody
      })
      if (!body) {
        logData.statusCode = 400
        logData.errorMessage = 'Request body is required'
        logData.responseDetail = localResponseLogDetail(400, 'invalid_request', 'Request body is required')
        return jsonError(400, 'Request body is required', 'invalid_request')
      }

      // Extract model name, stream flag, and affinity key from request body
      let affinityKey: string | null = null
      try {
        const requestData = JSON.parse(body.toString())
        logData.modelName = requestData.model || null
        logData.isStream = Boolean(requestData.stream)
        if (apiKeyInfo?.affinityEnabled) {
          affinityKey = extractAffinityKey(body.toString())
        }
      } catch {}

      const slot = affinityKey
        ? await waitForAccountSlotAffinity(upstreamSignal, affinityKey)
        : await waitForAccountSlot(upstreamSignal)
      if (!slot) {
        logData.statusCode = 503
        logData.errorMessage = '号池中暂无可用账号，请稍后重试'
        logData.responseDetail = localResponseLogDetail(503, 'pool_unavailable', logData.errorMessage)
        return jsonError(503, '号池中暂无可用账号，请稍后重试', 'pool_unavailable')
      }
      const { account, release: releaseAccountSlot } = slot
      logData.accountId = account.id
      logData.accountName = account.name || account.email || null

      try {
        const fetchImpl = await createAccountFetch(account)
        const firstTokenStartTime = Date.now()
        let firstTokenRecorded = false
        const requestHeaders = upstreamHeaders(event, account.upstream_api_key!)
        logData.requestDetail = serializeLogPayload({
          method: 'POST',
          incoming_url: event.node.req.url || null,
          upstream_url: `${GO_BASE}/chat/completions`,
          incoming_headers: headersForLog(event.node.req.headers || {}),
          upstream_headers: headersForLog(requestHeaders),
          body: requestBody
        })

        const response = await fetchImpl(`${GO_BASE}/chat/completions`, {
          method: 'POST',
          headers: requestHeaders,
          body,
          signal: upstreamSignal
        })

        logData.statusCode = response.status
        const upstreamResponseBody = !response.ok
          ? await readClonedResponseBody(response)
          : ''
        const upstreamErrorDetail = !response.ok
          ? describeUpstreamError(response, upstreamResponseBody)
          : ''
        logData.responseDetail = !response.ok
          ? responseLogDetail(response, upstreamResponseBody || null)
          : null

        if (response.status === 401) {
          logData.errorMessage = appendUpstreamErrorDetail(
            'Upstream account returned 401 and was abandoned',
            upstreamErrorDetail
          )
          await markAccountRiskControlled(
            account.id,
            'Upstream account returned 401 and was abandoned.'
          ).catch(() => {})
        } else if (response.status === 403) {
          logData.errorMessage = appendUpstreamErrorDetail(
            'Upstream API key rejected (status 403)',
            upstreamErrorDetail
          )
          await invalidateUpstreamApiKey(
            account.id,
            'Upstream API key rejected (status 403); cached key cleared.'
          ).catch(() => {})
        } else if (ACCOUNT_ERROR_STATUSES.has(response.status) || response.status >= 500) {
          logData.errorMessage = formatUpstreamError(response.status, upstreamErrorDetail)
          refreshAfterUpstreamError(account.id)
        }
        if (!response.ok && !logData.errorMessage) {
          logData.errorMessage = formatUpstreamError(response.status, upstreamErrorDetail)
        }

        // For streaming responses, wrap the body to track tokens
        if (logData.isStream && response.body && response.ok) {
          const reader = response.body.getReader()
          let released = false
          let logged = false
          const decoder = new TextDecoder()
          let sseBuffer = ''
          const responseBodyParts: string[] = []

          const logOnce = () => {
            if (logged) return
            logged = true
            void logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
          }
          const finalizeResponseLog = () => {
            logData.responseDetail = responseLogDetail(response, responseBodyParts.join('') || null)
          }
          const processSseLine = (line: string) => {
            if (!line.startsWith('data: ') || line.includes('[DONE]')) return
            if (!firstTokenRecorded) {
              logData.firstTokenTime = Date.now() - firstTokenStartTime
              firstTokenRecorded = true
            }
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
          const consumeSseText = (text: string, flush = false) => {
            sseBuffer += text
            const lines = sseBuffer.split(/\r?\n/)
            const tail = lines.pop() || ''
            if (flush) {
              if (tail) lines.push(tail)
              sseBuffer = ''
            } else {
              sseBuffer = tail
            }
            for (const line of lines) processSseLine(line)
          }
          const finish = () => {
            if (released) return
            released = true
            upstreamSignal.removeEventListener('abort', abort)
            void releaseAccountSlot()
          }
          const abort = () => {
            finish()
            void reader.cancel(upstreamSignal.reason).catch(() => {})
          }
          upstreamSignal.addEventListener('abort', abort, { once: true })
          if (upstreamSignal.aborted) abort()

          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read()
                if (chunk.done) {
                  const tail = decoder.decode()
                  if (tail) responseBodyParts.push(tail)
                  consumeSseText(tail, true)
                  finalizeResponseLog()
                  finish()
                  controller.close()
                  logOnce()
                } else {
                  const text = decoder.decode(chunk.value, { stream: true })
                  responseBodyParts.push(text)
                  consumeSseText(text)
                  controller.enqueue(chunk.value)
                }
              } catch (error) {
                finalizeResponseLog()
                finish()
                controller.error(error)
                logOnce()
              }
            },
            async cancel(reason) {
              finalizeResponseLog()
              finish()
              await reader.cancel(reason).catch(() => {})
              logOnce()
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
              const responseBody = await clonedResponse.text()
              logData.responseDetail = responseLogDetail(response, responseBody || null)
              const data = JSON.parse(responseBody)
              if (data.usage) {
                logData.promptTokens = data.usage.prompt_tokens || null
                logData.completionTokens = data.usage.completion_tokens || null
                logData.cachedPromptTokens = data.usage.prompt_tokens_details?.cached_tokens || null
                logData.createdPromptTokens = data.usage.prompt_tokens_details?.created_tokens || null
              }
              logData.firstTokenTime = Date.now() - firstTokenStartTime
            } catch {}
          }
          if (!logData.responseDetail) {
            logData.responseDetail = responseLogDetail(response, null)
          }

          const result = responseHoldingAccountSlot(response, releaseAccountSlot, upstreamSignal)
          void logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
          return result
        }
      } catch (error) {
        await releaseAccountSlot()
        throw error
      }
    }, {
      signal: upstreamSignal,
      queueTimeoutMs: PROXY_QUEUE_TIMEOUT_MS
    })
  } catch (error) {
    if (error instanceof ProxyRequestAbortedError) {
      logData.statusCode = 499
      logData.errorMessage = '客户端已关闭请求'
      logData.responseDetail = localResponseLogDetail(499, 'client_closed_request', logData.errorMessage, error)
      await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
      return jsonError(499, '客户端已关闭请求', 'client_closed_request')
    }
    if (upstreamTimeoutSignal.aborted) {
      logData.statusCode = 504
      logData.errorMessage = '上游请求超时'
      logData.responseDetail = localResponseLogDetail(504, 'upstream_timeout', logData.errorMessage, error)
      await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
      return jsonError(504, '上游请求超时', 'upstream_timeout')
    }
    if (error instanceof ProxyQueueTimeoutError) {
      logData.statusCode = 503
      logData.errorMessage = '代理队列等待超时，请稍后重试'
      logData.responseDetail = localResponseLogDetail(503, 'proxy_queue_timeout', logData.errorMessage, error)
      await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
      return jsonError(503, '代理队列等待超时，请稍后重试', 'proxy_queue_timeout')
    }
    if (error instanceof ProxyPoolSaturatedError) {
      logData.statusCode = 503
      logData.errorMessage = '代理队列已满，请稍后重试'
      logData.responseDetail = localResponseLogDetail(503, 'proxy_saturated', logData.errorMessage, error)
      await logCallCompletion(apiKeyInfo, logData, callerIp, startTime)
      return jsonError(503, '代理队列已满，请稍后重试', 'proxy_saturated')
    }
    logData.statusCode = 500
    logData.errorMessage = '代理服务失败'
    logData.responseDetail = localResponseLogDetail(500, 'proxy_worker_error', logData.errorMessage, error)
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
    requestDetail: string | null
    responseDetail: string | null
  },
  callerIp: string | null,
  startTime: number
) {
  const endTime = Date.now()
  const responseTimeMs = endTime - startTime
  const generationTimeMs = logData.firstTokenTime === null
    ? null
    : responseTimeMs - logData.firstTokenTime
  const throughput = logData.completionTokens && generationTimeMs && generationTimeMs > 0
    ? (logData.completionTokens / generationTimeMs) * 1000
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
      error_message: logData.errorMessage,
      request_detail: logData.requestDetail,
      response_detail: logData.responseDetail
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
    const releaseSlot = slot.release
    release = releaseSlot
    const fetchImpl = await createAccountFetch(account)
    const response = await fetchImpl(`${GO_BASE}/models`, {
      headers: upstreamHeaders(event, account.upstream_api_key || undefined),
      signal
    })
    if (response.status === 401) {
      await markAccountRiskControlled(
        account.id,
        'Upstream account returned 401 and was abandoned.'
      ).catch(() => {})
    } else if (response.status === 403) {
      await invalidateUpstreamApiKey(
        account.id,
        'Upstream API key rejected (status 403); cached key cleared.'
      ).catch(() => {})
    } else if (!response.ok) {
      refreshAfterUpstreamError(account.id)
    }
    return responseHoldingAccountSlot(response, releaseSlot, signal)
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
