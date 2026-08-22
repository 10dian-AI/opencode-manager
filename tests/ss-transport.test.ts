import { describe, expect, test } from 'bun:test'
import { hkdfSync } from 'node:crypto'
import {
  evpBytesToKey,
  hkdfSha1,
  isSupportedShadowsocksCipher,
  parseShadowsocksUrl
} from '../server/utils/ss-transport'

describe('Shadowsocks transport helpers', () => {
  test('accepts all implemented AEAD ciphers', () => {
    expect(isSupportedShadowsocksCipher('aes-128-gcm')).toBe(true)
    expect(isSupportedShadowsocksCipher('AES-256-GCM')).toBe(true)
    expect(isSupportedShadowsocksCipher('chacha20-ietf-poly1305')).toBe(true)
    expect(isSupportedShadowsocksCipher('rc4-md5')).toBe(false)
  })

  test('derives the OpenSSL-compatible master key', () => {
    expect(evpBytesToKey('password', 32).toString('hex')).toBe(
      '5f4dcc3b5aa765d61d8327deb882cf992b95990a9151374abd8ff8c5a7a0fe08'
    )
  })

  test('matches the platform HKDF-SHA1 implementation', () => {
    const ikm = Buffer.from('input key material')
    const salt = Buffer.from('salt')
    const info = Buffer.from('ss-subkey')
    const expected = Buffer.from(hkdfSync('sha1', ikm, salt, info, 32))
    expect(hkdfSha1(ikm, salt, info, 32)).toEqual(expected)
  })

  test('parses canonical SS URLs with encoded credentials', () => {
    expect(parseShadowsocksUrl('ss://aes-256-gcm:p%40ss@127.0.0.1:8388')).toEqual({
      host: '127.0.0.1',
      port: 8388,
      method: 'aes-256-gcm',
      password: 'p@ss'
    })
  })
})
