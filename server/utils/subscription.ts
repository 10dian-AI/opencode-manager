import { parse as parseYaml } from 'yaml'
import { detectRegion } from './region'
import { isSupportedShadowsocksCipher } from './ss-transport'
import { parseTrojanUrl } from './trojan-transport'

export interface SubscriptionNode {
  name: string
  protocol: string
  /** Canonical internal URI; empty string for unsupported protocols. */
  uri: string
  region: string | null
  supported: boolean
  unsupported_reason: string | null
}

const FETCH_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Protocols this panel can actually dial out through. */
const SUPPORTED_PROTOCOLS = new Set(['ss', 'trojan', 'http', 'https', 'socks5'])

function decodeBase64(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, '')
  if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const decoded = Buffer.from(padded, 'base64')
    return decoded.length ? decoded : null
  } catch {
    return null
  }
}

function decodeMaybeBase64Text(value: string): string | null {
  const decoded = decodeBase64(value)
  if (!decoded) return null
  const text = decoded.toString('utf8')
  // Reject content that is clearly not text (control characters other than
  // whitespace) so random prose is not misdetected as base64.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return null
  return text
}

function decodeCredential(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function splitHostPort(server: string): { host: string; port: number } | null {
  const trimmed = server.trim()
  const bracket = trimmed.match(/^\[([^\]]+)]:(\d+)$/)
  if (bracket) return { host: bracket[1]!, port: Number(bracket[2]) }
  const index = trimmed.lastIndexOf(':')
  if (index <= 0) return null
  const host = trimmed.slice(0, index)
  const port = Number(trimmed.slice(index + 1))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function canonicalSsUri(method: string, password: string, host: string, port: number) {
  const hostPart = host.includes(':') ? `[${host}]` : host
  return `ss://${encodeURIComponent(method)}:${encodeURIComponent(password)}@${hostPart}:${port}`
}

function canonicalUrlUri(uri: string) {
  const url = new URL(uri)
  url.hash = ''
  if (['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
    url.pathname = ''
    url.search = ''
  }
  return url.toString()
}

function parseSsUri(uri: string): { node: Omit<SubscriptionNode, 'region'> } {
  const body = uri.slice('ss://'.length)
  const hashIndex = body.indexOf('#')
  const withoutFragment = hashIndex >= 0 ? body.slice(0, hashIndex) : body
  const name = hashIndex >= 0 ? decodeCredential(body.slice(hashIndex + 1)) : ''

  const queryIndex = withoutFragment.indexOf('?')
  const main = (queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment).replace(/\/$/, '')
  const query = queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : ''
  const plugin = new URLSearchParams(query).get('plugin')
  if (plugin) {
    return {
      node: {
        name: name || main,
        protocol: 'ss',
        uri: '',
        supported: false,
        unsupported_reason: `带插件的 SS 节点暂不支持（plugin=${plugin}）`
      }
    }
  }

  let method = ''
  let password = ''
  let server = ''

  const atIndex = main.lastIndexOf('@')
  if (atIndex >= 0) {
    const userinfo = main.slice(0, atIndex)
    server = main.slice(atIndex + 1)
    const decodedUserinfo = decodeMaybeBase64Text(userinfo)
    const credentials = decodedUserinfo && decodedUserinfo.includes(':')
      ? decodedUserinfo
      : decodeCredential(userinfo)
    const colonIndex = credentials.indexOf(':')
    if (colonIndex > 0) {
      method = credentials.slice(0, colonIndex)
      password = credentials.slice(colonIndex + 1)
    }
  } else {
    // Legacy form: the whole "method:password@host:port" is base64 encoded.
    const decoded = decodeMaybeBase64Text(main)
    if (decoded) {
      const decodedAt = decoded.lastIndexOf('@')
      if (decodedAt >= 0) {
        const credentials = decoded.slice(0, decodedAt)
        server = decoded.slice(decodedAt + 1)
        const colonIndex = credentials.indexOf(':')
        if (colonIndex > 0) {
          method = credentials.slice(0, colonIndex)
          password = credentials.slice(colonIndex + 1)
        }
      }
    }
  }

  const target = splitHostPort(server)
  if (!method || !target) {
    return {
      node: {
        name: name || 'ss 节点',
        protocol: 'ss',
        uri: '',
        supported: false,
        unsupported_reason: 'SS 链接无法解析'
      }
    }
  }
  if (!isSupportedShadowsocksCipher(method)) {
    return {
      node: {
        name: name || `${target.host}:${target.port}`,
        protocol: 'ss',
        uri: '',
        supported: false,
        unsupported_reason: `不支持的加密方式：${method}`
      }
    }
  }
  return {
    node: {
      name: name || `${target.host}:${target.port}`,
      protocol: 'ss',
      uri: canonicalSsUri(method, password, target.host, target.port),
      supported: true,
      unsupported_reason: null
    }
  }
}

function parseGenericUri(uri: string): Omit<SubscriptionNode, 'region'> | null {
  const schemeMatch = uri.match(/^([a-z0-9+.-]+):\/\//i)
  if (!schemeMatch) return null
  const scheme = schemeMatch[1]!.toLowerCase()

  if (scheme === 'ss') return parseSsUri(uri).node

  if (scheme === 'trojan') {
    let name = ''
    try {
      const url = new URL(uri)
      name = url.hash ? decodeCredential(url.hash.slice(1)) : ''
      const config = parseTrojanUrl(uri)
      return {
        name: name || `${config.host}:${config.port}`,
        protocol: 'trojan',
        uri: canonicalUrlUri(uri),
        supported: true,
        unsupported_reason: null
      }
    } catch (error) {
      return {
        name: name || 'trojan 节点',
        protocol: 'trojan',
        uri: '',
        supported: false,
        unsupported_reason: error instanceof Error ? error.message : 'Trojan 链接无法解析'
      }
    }
  }

  if (['http', 'https', 'socks5', 'socks5h'].includes(scheme)) {
    try {
      const url = new URL(uri)
      if (!url.hostname || !url.port) throw new Error('缺少主机或端口')
      const name = url.hash ? decodeCredential(url.hash.slice(1)) : ''
      return {
        name: name || `${url.hostname}:${url.port}`,
        protocol: scheme === 'socks5h' ? 'socks5' : scheme,
        uri: canonicalUrlUri(uri),
        supported: true,
        unsupported_reason: null
      }
    } catch {
      return {
        name: scheme,
        protocol: scheme,
        uri: '',
        supported: false,
        unsupported_reason: '链接无法解析'
      }
    }
  }

  const KNOWN_UNSUPPORTED: Record<string, string> = {
    vmess: 'VMess 协议暂不支持，请使用 ss/trojan/socks5/http 节点',
    vless: 'VLESS 协议暂不支持，请使用 ss/trojan/socks5/http 节点',
    hy2: 'Hysteria2 协议暂不支持',
    hysteria2: 'Hysteria2 协议暂不支持',
    hysteria: 'Hysteria 协议暂不支持',
    tuic: 'TUIC 协议暂不支持',
    snell: 'Snell 协议暂不支持',
    wireguard: 'WireGuard 协议暂不支持',
    ssr: 'SSR 协议暂不支持'
  }
  let name = scheme
  try {
    const url = new URL(uri)
    if (url.hash) name = decodeCredential(url.hash.slice(1)) || scheme
  } catch {
    // keep scheme as name
  }
  return {
    name,
    protocol: scheme,
    uri: '',
    supported: false,
    unsupported_reason: KNOWN_UNSUPPORTED[scheme] || `暂不支持的协议：${scheme}`
  }
}

function parseClashProxy(raw: unknown): Omit<SubscriptionNode, 'region'> | null {
  if (!raw || typeof raw !== 'object') return null
  const proxy = raw as Record<string, unknown>
  const type = String(proxy.type || '').toLowerCase()
  const name = String(proxy.name || '')
  const server = String(proxy.server || '')
  const port = Number(proxy.port)
  if (!type || !server || !Number.isInteger(port)) return null

  if (type === 'ss') {
    const method = String(proxy.cipher || '')
    const password = String(proxy.password ?? '')
    if (proxy.plugin) {
      return { name, protocol: 'ss', uri: '', supported: false, unsupported_reason: `带插件的 SS 节点暂不支持（plugin=${proxy.plugin}）` }
    }
    if (!isSupportedShadowsocksCipher(method)) {
      return { name, protocol: 'ss', uri: '', supported: false, unsupported_reason: `不支持的加密方式：${method}` }
    }
    return { name, protocol: 'ss', uri: canonicalSsUri(method, password, server, port), supported: true, unsupported_reason: null }
  }

  if (type === 'trojan') {
    const params = new URLSearchParams()
    if (proxy.sni) params.set('sni', String(proxy.sni))
    if (proxy['skip-cert-verify']) params.set('allowInsecure', '1')
    const hostPart = server.includes(':') ? `[${server}]` : server
    const uri = canonicalUrlUri(
      `trojan://${encodeURIComponent(String(proxy.password ?? ''))}@${hostPart}:${port}${params.size ? `?${params}` : ''}`
    )
    return { name, protocol: 'trojan', uri, supported: true, unsupported_reason: null }
  }

  if (type === 'http' || type === 'https') {
    const scheme = type === 'https' || proxy.tls === true ? 'https' : 'http'
    const auth = proxy.username
      ? `${encodeURIComponent(String(proxy.username))}:${encodeURIComponent(String(proxy.password ?? ''))}@`
      : ''
    const hostPart = server.includes(':') ? `[${server}]` : server
    return {
      name,
      protocol: scheme,
      uri: canonicalUrlUri(`${scheme}://${auth}${hostPart}:${port}`),
      supported: true,
      unsupported_reason: null
    }
  }

  if (type === 'socks5' || type === 'socks') {
    const auth = proxy.username
      ? `${encodeURIComponent(String(proxy.username))}:${encodeURIComponent(String(proxy.password ?? ''))}@`
      : ''
    const hostPart = server.includes(':') ? `[${server}]` : server
    return {
      name,
      protocol: 'socks5',
      uri: canonicalUrlUri(`socks5://${auth}${hostPart}:${port}`),
      supported: true,
      unsupported_reason: null
    }
  }

  return {
    name: name || type,
    protocol: type,
    uri: '',
    supported: false,
    unsupported_reason: `暂不支持的协议：${type}`
  }
}

function withRegion(node: Omit<SubscriptionNode, 'region'>): SubscriptionNode {
  return { ...node, region: detectRegion(node.name) }
}

/**
 * Parses a subscription body into node descriptors. Handles the three shapes
 * seen in the wild: base64-encoded URI lists, Clash YAML, and plain URI text.
 */
export function parseSubscriptionBody(body: string): SubscriptionNode[] {
  const trimmed = body.trim()
  if (!trimmed) return []

  // 1. Clash YAML ("proxies:" list).
  if (/^proxies\s*:/m.test(trimmed) || /^\s*-\s*name\s*:/m.test(trimmed)) {
    try {
      const document = parseYaml(trimmed) as { proxies?: unknown } | unknown
      const list = Array.isArray(document)
        ? document
        : (document && typeof document === 'object' && Array.isArray((document as { proxies?: unknown }).proxies)
            ? (document as { proxies: unknown[] }).proxies
            : null)
      if (list) {
        return list
          .map(entry => parseClashProxy(entry))
          .filter((entry): entry is Omit<SubscriptionNode, 'region'> => entry !== null)
          .map(withRegion)
      }
    } catch {
      // fall through to URI parsing
    }
  }

  // 2. Base64 blob containing URI lines.
  const singleLine = trimmed.replace(/\s+/g, '')
  const decoded = decodeMaybeBase64Text(singleLine)
  if (decoded && /^[a-z0-9+.-]+:\/\//im.test(decoded)) {
    return parseUriLines(decoded)
  }

  // 3. Plain URI lines.
  return parseUriLines(trimmed)
}

function parseUriLines(text: string): SubscriptionNode[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[a-z0-9+.-]+:\/\//i.test(line))
    .map(line => parseGenericUri(line))
    .filter((entry): entry is Omit<SubscriptionNode, 'region'> => entry !== null)
    .map(withRegion)
}

/** Fetches and parses a subscription URL. */
export async function fetchSubscription(url: string): Promise<SubscriptionNode[]> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // Some airports gate subscriptions behind a UA check.
      'user-agent': 'clash.meta/1.18.0',
      accept: '*/*'
    }
  })
  if (!response.ok) {
    throw new Error(`订阅请求失败：HTTP ${response.status} ${response.statusText}`.trim())
  }
  const body = await response.text()
  if (body.length > MAX_BODY_BYTES) {
    throw new Error('订阅内容过大（超过 4MB），已中止解析')
  }
  const nodes = parseSubscriptionBody(body)
  if (!nodes.length) {
    throw new Error('订阅内容中没有识别到可用节点')
  }
  return nodes
}

export function isSupportedNode(node: Pick<SubscriptionNode, 'protocol' | 'supported'>) {
  return node.supported && SUPPORTED_PROTOCOLS.has(node.protocol)
}
