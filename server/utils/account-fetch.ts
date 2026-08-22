import {
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher
} from 'undici-client'
import type { Account } from './db'
import { getIpPoolEntry } from './ip-pool'
import { createSocksProxyFetch } from './socks-fetch'
import { createShadowsocksConnect, parseShadowsocksUrl } from './ss-transport'
import { createTrojanConnect, parseTrojanUrl } from './trojan-transport'
import { createTunnelFetch } from './tunnel-fetch'

interface ProxyTransport {
  proxyUrl: string
  fetch: typeof fetch
  close: () => void | Promise<void>
}

const proxyTransports = new Map<number, ProxyTransport>()

function isSocksProxy(proxyUrl: string) {
  return ['socks5:', 'socks5h:'].includes(new URL(proxyUrl).protocol)
}

function proxyFetch(dispatcher: Dispatcher): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const source = await undiciFetch(input as any, { ...(init as any), dispatcher })
    const response = new Response(source.body as unknown as ReadableStream<Uint8Array> | null, {
      status: source.status,
      statusText: source.statusText,
      headers: source.headers as unknown as HeadersInit
    })
    Object.defineProperties(response, {
      url: { configurable: true, value: source.url },
      redirected: { configurable: true, value: source.redirected }
    })
    return response
  }) as typeof fetch
}

function createSocksTransport(proxyUrl: string): ProxyTransport {
  return {
    proxyUrl,
    fetch: createSocksProxyFetch(proxyUrl),
    close: () => {}
  }
}

function createHttpTransport(proxyUrl: string): ProxyTransport {
  // undici's ProxyAgent is used on every runtime (Node and Bun): it handles
  // http:// and https:// proxies plus proxy auth consistently, whereas Bun's
  // fetch({proxy}) has edge cases with https proxies and encoded credentials.
  const agent = new ProxyAgent(proxyUrl)
  return {
    proxyUrl,
    fetch: proxyFetch(agent),
    close: () => agent.close()
  }
}

function createTunnelTransport(proxyUrl: string): ProxyTransport {
  const protocol = new URL(proxyUrl).protocol
  if (protocol === 'ss:') {
    parseShadowsocksUrl(proxyUrl) // fail fast on invalid config
    return {
      proxyUrl,
      fetch: createTunnelFetch(createShadowsocksConnect(proxyUrl)),
      close: () => {}
    }
  }
  if (protocol === 'trojan:') {
    parseTrojanUrl(proxyUrl)
    return {
      proxyUrl,
      fetch: createTunnelFetch(createTrojanConnect(proxyUrl)),
      close: () => {}
    }
  }
  throw new Error(`Unsupported proxy protocol: ${protocol}`)
}

function buildProxyTransport(proxyUrl: string) {
  const protocol = new URL(proxyUrl).protocol
  if (isSocksProxy(proxyUrl)) return createSocksTransport(proxyUrl)
  if (['ss:', 'trojan:'].includes(protocol)) return createTunnelTransport(proxyUrl)
  return createHttpTransport(proxyUrl)
}

function fetchThroughProxy(proxyId: number, proxyUrl: string): typeof fetch {
  let transport = proxyTransports.get(proxyId)
  if (!transport || transport.proxyUrl !== proxyUrl) {
    if (transport) {
      // Properly await close to ensure cleanup
      Promise.resolve(transport.close()).catch((error) => {
        console.error(`Failed to close proxy transport ${proxyId}:`, error)
      })
    }
    transport = buildProxyTransport(proxyUrl)
    proxyTransports.set(proxyId, transport)
  }
  return transport.fetch
}

export function createProxyFetch(proxyId: number, proxyUrl: string) {
  return fetchThroughProxy(proxyId, proxyUrl)
}

export async function createAccountFetch(
  account: Pick<Account, 'ip_pool_id'>
): Promise<typeof fetch> {
  if (account.ip_pool_id === null) return fetch
  const entry = await getIpPoolEntry(account.ip_pool_id)
  if (!entry || !entry.enabled) {
    throw createError({
      statusCode: 500,
      statusMessage: 'The account has no available outbound proxy'
    })
  }
  return fetchThroughProxy(entry.id, entry.proxy_url)
}

export async function closeProxyFetchAgents() {
  const transports = [...proxyTransports.values()]
  proxyTransports.clear()
  await Promise.all(transports.map(transport => transport.close()))
}
