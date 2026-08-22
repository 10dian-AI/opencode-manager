import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { encodeTrojanHeader, parseTrojanUrl } from '../server/utils/trojan-transport'

describe('Trojan transport helpers', () => {
  test('parses SNI and allowInsecure options', () => {
    expect(parseTrojanUrl(
      'trojan://p%40ss@example.com:443?sni=edge.example.com&allowInsecure=1'
    )).toEqual({
      host: 'example.com',
      port: 443,
      password: 'p@ss',
      servername: 'edge.example.com',
      allowInsecure: true
    })
  })

  test('rejects transports that are not raw TCP', () => {
    expect(() => parseTrojanUrl('trojan://pass@example.com:443?type=ws')).toThrow(
      'Unsupported Trojan transport'
    )
  })

  test('encodes the password digest and target address header', () => {
    const header = encodeTrojanHeader('secret', 'api.example.com', 443)
    const digest = createHash('sha224').update('secret').digest('hex')

    expect(header.subarray(0, 56).toString()).toBe(digest)
    expect(header.subarray(56, 59)).toEqual(Buffer.from('\r\n\x01'))
    expect(header.subarray(-2)).toEqual(Buffer.from('\r\n'))
  })
})
