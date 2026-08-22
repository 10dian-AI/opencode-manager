import { describe, expect, test } from 'bun:test'
import {
  normalizeProxyUrl,
  planStableIpAssignments,
  redactProxyUrl
} from '../server/utils/ip-pool'

describe('IP pool proxy URLs', () => {
  test('normalizes common proxy list formats', () => {
    expect(normalizeProxyUrl('1.2.3.4:8080')).toBe('http://1.2.3.4:8080/')
    expect(normalizeProxyUrl('user:pass@1.2.3.4:8080')).toBe(
      'http://user:pass@1.2.3.4:8080/'
    )
    expect(normalizeProxyUrl('1.2.3.4:8080:user:pass')).toBe(
      'http://user:pass@1.2.3.4:8080/'
    )
    expect(normalizeProxyUrl('sk5://user:pass@1.2.3.4:1080')).toBe(
      'socks5://user:pass@1.2.3.4:1080'
    )
    expect(normalizeProxyUrl('socks5h://1.2.3.4:1080')).toBe(
      'socks5h://1.2.3.4:1080'
    )
  })

  test('never exposes proxy passwords in public data', () => {
    expect(redactProxyUrl('http://user:secret@1.2.3.4:8080/')).toBe(
      'http://user:***@1.2.3.4:8080/'
    )
    expect(redactProxyUrl('trojan://secret@example.com:443')).toBe(
      'trojan://***@example.com:443'
    )
  })
})

describe('stable chunk assignment', () => {
  test('keeps existing assignments and fills the least loaded proxy by chunks', () => {
    const changes = planStableIpAssignments(
      [
        { id: 1, ip_pool_id: 1 },
        { id: 2, ip_pool_id: 1 },
        { id: 3, ip_pool_id: null },
        { id: 4, ip_pool_id: null },
        { id: 5, ip_pool_id: null }
      ],
      [{ id: 1, enabled: 1 }, { id: 2, enabled: 1 }],
      2
    )

    expect(changes).toEqual([
      { accountId: 3, ipPoolId: 2 },
      { accountId: 4, ipPoolId: 2 },
      { accountId: 5, ipPoolId: 1 }
    ])
  })

  test('moves only accounts whose proxy is no longer enabled', () => {
    const changes = planStableIpAssignments(
      [
        { id: 1, ip_pool_id: 1 },
        { id: 2, ip_pool_id: 1 },
        { id: 3, ip_pool_id: 2 },
        { id: 4, ip_pool_id: 2 }
      ],
      [{ id: 1, enabled: 0 }, { id: 2, enabled: 1 }, { id: 3, enabled: 1 }],
      2
    )

    expect(changes).toEqual([
      { accountId: 1, ipPoolId: 3 },
      { accountId: 2, ipPoolId: 3 }
    ])
  })

  test('falls back to direct mode when there are no enabled proxies', () => {
    expect(planStableIpAssignments(
      [{ id: 1, ip_pool_id: 1 }, { id: 2, ip_pool_id: null }],
      [{ id: 1, enabled: 0 }],
      5
    )).toEqual([{ accountId: 1, ipPoolId: null }])
  })

  test('accepts the boolean enabled column returned by PostgreSQL', () => {
    expect(planStableIpAssignments(
      [{ id: 1, ip_pool_id: 1 }, { id: 2, ip_pool_id: null }],
      [{ id: 1, enabled: false }, { id: 2, enabled: true }],
      2
    )).toEqual([
      { accountId: 1, ipPoolId: 2 },
      { accountId: 2, ipPoolId: 2 }
    ])
  })

  test('never assigns accounts to nodes marked down', () => {
    expect(planStableIpAssignments(
      [{ id: 1, ip_pool_id: 1 }, { id: 2, ip_pool_id: null }],
      [
        { id: 1, enabled: true, health: 'down', region: 'HK' },
        { id: 2, enabled: true, health: 'healthy', region: 'HK' }
      ],
      2
    )).toEqual([
      { accountId: 1, ipPoolId: 2 },
      { accountId: 2, ipPoolId: 2 }
    ])
  })

  test('moves accounts from a failed node to a healthy node in the same region first', () => {
    expect(planStableIpAssignments(
      [
        { id: 1, ip_pool_id: 1 },
        { id: 2, ip_pool_id: 3 }
      ],
      [
        { id: 1, enabled: true, health: 'down', region: 'JP' },
        { id: 2, enabled: true, health: 'healthy', region: 'JP' },
        { id: 3, enabled: true, health: 'healthy', region: 'US' }
      ],
      5
    )).toEqual([{ accountId: 1, ipPoolId: 2 }])
  })

  test('falls back to another region when no same-region node is healthy', () => {
    expect(planStableIpAssignments(
      [{ id: 1, ip_pool_id: 1 }],
      [
        { id: 1, enabled: true, health: 'down', region: 'HK' },
        { id: 2, enabled: true, health: 'healthy', region: 'JP' },
        { id: 3, enabled: true, health: 'healthy', region: 'US' }
      ],
      5
    )).toEqual([{ accountId: 1, ipPoolId: 2 }])
  })
})
