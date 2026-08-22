import { describe, expect, test } from 'bun:test'
import { parseSubscriptionBody } from '../server/utils/subscription'
import { redactSubscriptionError, redactSubscriptionUrl } from '../server/utils/proxy-subscriptions'

function base64(value: string) {
  return Buffer.from(value, 'utf8').toString('base64')
}

describe('proxy subscription parsing', () => {
  test('parses a base64 encoded URI list and canonicalizes supported nodes', () => {
    const ssCredential = base64('aes-128-gcm:secret')
    const body = [
      `ss://${ssCredential}@hk.example.com:8388#%F0%9F%87%AD%F0%9F%87%B0%20Hong%20Kong`,
      'trojan://password@jp.example.com:443?sni=edge.example.com#Japan',
      'http://user:pass@us.example.com:8080#United%20States',
      'socks5://user:pass@sg.example.com:1080#Singapore',
      'vmess://unsupported#Tokyo'
    ].join('\n')

    const nodes = parseSubscriptionBody(base64(body))

    expect(nodes).toHaveLength(5)
    expect(nodes[0]).toMatchObject({ protocol: 'ss', supported: true, region: 'HK' })
    expect(nodes[0]!.uri).toBe('ss://aes-128-gcm:secret@hk.example.com:8388')
    expect(nodes[1]).toMatchObject({ protocol: 'trojan', supported: true, region: 'JP' })
    expect(nodes[1]!.uri).toBe('trojan://password@jp.example.com:443/?sni=edge.example.com')
    expect(nodes[2]!.uri).toBe('http://user:pass@us.example.com:8080/')
    expect(nodes[3]!.uri).toBe('socks5://user:pass@sg.example.com:1080')
    expect(nodes[4]).toMatchObject({ protocol: 'vmess', supported: false })
  })

  test('parses legacy whole-payload Shadowsocks links', () => {
    const legacy = base64('aes-256-gcm:p@ssword@127.0.0.1:8388')
    const [node] = parseSubscriptionBody(`ss://${legacy}#Tokyo`)

    expect(node).toMatchObject({ protocol: 'ss', supported: true, region: 'JP' })
    expect(node!.uri).toBe('ss://aes-256-gcm:p%40ssword@127.0.0.1:8388')
  })

  test('parses Clash YAML and marks unsupported protocols without dropping them', () => {
    const nodes = parseSubscriptionBody(`
proxies:
  - name: 🇸🇬 SG-SS
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: chacha20-ietf-poly1305
    password: test-pass
  - name: London Trojan
    type: trojan
    server: 5.6.7.8
    port: 443
    password: trojan-pass
    sni: edge.example.com
    skip-cert-verify: true
  - name: HK HTTP
    type: http
    server: 9.8.7.6
    port: 8080
    username: user
    password: pass
  - name: Tokyo VLESS
    type: vless
    server: example.com
    port: 443
`)

    expect(nodes).toHaveLength(4)
    expect(nodes[0]).toMatchObject({ protocol: 'ss', supported: true, region: 'SG' })
    expect(nodes[1]!.uri).toBe('trojan://trojan-pass@5.6.7.8:443/?sni=edge.example.com&allowInsecure=1')
    expect(nodes[2]!.uri).toBe('http://user:pass@9.8.7.6:8080/')
    expect(nodes[3]).toMatchObject({ protocol: 'vless', supported: false, region: 'JP' })
  })

  test('redacts credentials and tokens from subscription URLs and client errors', () => {
    const url = 'https://client:secret@sub.example.com/api/v1/token?token=abc123&device=desktop#profile'

    expect(redactSubscriptionUrl(url)).toBe(
      'https://***:***@sub.example.com/***?token=***&device=***#***'
    )
    const message = redactSubscriptionError(`GET ${url} failed; token=abc123`, url)
    expect(message).toContain('https://***:***@sub.example.com/***?token=***&device=***#***')
    expect(message).not.toContain('client')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('abc123')
    expect(message).not.toContain('/api/v1/token')
  })
})
