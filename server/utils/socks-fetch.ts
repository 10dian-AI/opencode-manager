import type { Socket } from 'node:net'
import tls, { type TLSSocket } from 'node:tls'
import { SocksClient, type SocksProxy } from 'socks'
import {
  abortReason,
  createTunnelFetch,
  type TransportSocket,
  type TunnelConnect
} from './tunnel-fetch'

const SOCKS_CONNECT_TIMEOUT_MS = 10_000

function decodeCredential(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseProxy(proxyUrl: string): SocksProxy {
  const url = new URL(proxyUrl)
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: Number(url.port),
    type: 5,
    userId: url.username ? decodeCredential(url.username) : undefined,
    password: url.password ? decodeCredential(url.password) : undefined
  }
}

/**
 * Wraps an established tunnel socket in TLS towards the target host. Shared
 * by every tunnel transport (SOCKS5, Shadowsocks, Trojan).
 */
export function wrapTargetTls(
  socket: Socket,
  url: URL,
  signal: AbortSignal
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername: url.hostname,
      ALPNProtocols: ['http/1.1']
    })
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      secureSocket.removeListener('secureConnect', onSecure)
      secureSocket.removeListener('error', onError)
    }
    const onSecure = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(secureSocket.setNoDelay())
    }
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      secureSocket.destroy()
      reject(abortReason(signal))
    }
    secureSocket.once('secureConnect', onSecure)
    secureSocket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createSocksConnect(proxyUrl: string): TunnelConnect {
  const proxy = parseProxy(proxyUrl)
  return async (url, signal): Promise<TransportSocket> => {
    if (signal.aborted) throw abortReason(signal)

    const connection = SocksClient.createConnection({
      command: 'connect',
      proxy,
      timeout: SOCKS_CONNECT_TIMEOUT_MS,
      destination: {
        host: url.hostname,
        port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      }
    })

    const socket = await new Promise<Socket>((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void connection.then(({ socket }) => {
        signal.removeEventListener('abort', onAbort)
        if (settled || signal.aborted) {
          socket.destroy()
          if (!settled) reject(abortReason(signal))
          return
        }
        settled = true
        resolve(socket.setNoDelay())
      }, (error) => {
        signal.removeEventListener('abort', onAbort)
        if (settled) return
        settled = true
        reject(error)
      })
    })

    if (url.protocol !== 'https:') return socket
    return wrapTargetTls(socket, url, signal)
  }
}

export function createSocksProxyFetch(proxyUrl: string): typeof fetch {
  return createTunnelFetch(createSocksConnect(proxyUrl))
}
