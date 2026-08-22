import { createHash } from 'node:crypto'
import tls, { type TLSSocket } from 'node:tls'
import { encodeTunnelAddress } from './tunnel-address'
import { abortReason, type TunnelConnect } from './tunnel-fetch'
import { wrapTargetTls } from './socks-fetch'

const CONNECT_TIMEOUT_MS = 10_000
const CRLF = Buffer.from('\r\n')
const CMD_CONNECT = 0x01

export interface TrojanConfig {
  host: string
  port: number
  password: string
  servername: string
  allowInsecure: boolean
}

function decodeCredential(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Parses `trojan://password@host:port?sni=...&allowInsecure=...#name`.
 * Certificates are verified by default; `allowInsecure=1` / `skip-cert-verify=1`
 * disable verification because many airport deployments use self-signed certs.
 * ws/grpc transports are not supported and are rejected on connect.
 */
export function parseTrojanUrl(uri: string): TrojanConfig {
  const url = new URL(uri)
  if (url.protocol !== 'trojan:') throw new Error('Not a Trojan URL')
  const transport = (url.searchParams.get('type') || 'tcp').toLowerCase()
  if (transport && transport !== 'tcp' && transport !== 'none') {
    throw new Error(`Unsupported Trojan transport: ${transport}`)
  }
  const password = decodeCredential(url.username)
  if (!password || !url.hostname || !url.port) {
    throw new Error('Trojan password, host and port are required')
  }
  const allowInsecure = ['1', 'true', 'yes'].includes(
    (url.searchParams.get('allowInsecure') ||
      url.searchParams.get('skip-cert-verify') ||
      url.searchParams.get('allow_insecure') ||
      '').toLowerCase()
  )
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  return {
    host,
    port: Number(url.port),
    password,
    servername: url.searchParams.get('sni') || url.searchParams.get('peer') || host,
    allowInsecure
  }
}

/** sha224(password) hex + CRLF + CONNECT + address + CRLF, per the Trojan spec. */
export function encodeTrojanHeader(password: string, hostname: string, port: number): Buffer {
  const digest = createHash('sha224').update(password, 'utf8').digest('hex')
  return Buffer.concat([
    Buffer.from(digest, 'ascii'),
    CRLF,
    Buffer.from([CMD_CONNECT]),
    encodeTunnelAddress(hostname, port),
    CRLF
  ])
}

export function createTrojanConnect(uri: string): TunnelConnect {
  const config = parseTrojanUrl(uri)

  return async (url, signal) => {
    if (signal.aborted) throw abortReason(signal)

    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const tlsSocket = tls.connect({
        host: config.host,
        port: config.port,
        servername: config.servername,
        rejectUnauthorized: !config.allowInsecure,
        ALPNProtocols: ['http/1.1'],
        timeout: CONNECT_TIMEOUT_MS
      })
      let settled = false
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        tlsSocket.removeListener('secureConnect', onSecure)
        tlsSocket.removeListener('error', onError)
        tlsSocket.removeListener('timeout', onTimeout)
      }
      const onSecure = () => {
        if (settled) return
        settled = true
        cleanup()
        tlsSocket.setNoDelay()
        resolve(tlsSocket)
      }
      const onError = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onTimeout = () => {
        if (settled) return
        settled = true
        cleanup()
        tlsSocket.destroy()
        reject(new Error(`Trojan server ${config.host}:${config.port} connect timed out`))
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        tlsSocket.destroy()
        reject(abortReason(signal))
      }
      tlsSocket.once('secureConnect', onSecure)
      tlsSocket.once('error', onError)
      tlsSocket.once('timeout', onTimeout)
      signal.addEventListener('abort', onAbort, { once: true })
    })

    const targetPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    socket.write(encodeTrojanHeader(config.password, url.hostname, targetPort))

    if (url.protocol !== 'https:') return socket
    return wrapTargetTls(socket, url, signal)
  }
}
