import { describe, expect, test } from 'bun:test'
import { detectRegion } from '../server/utils/region'

describe('proxy node region detection', () => {
  test('prefers flag emoji and recognizes Chinese and English location names', () => {
    expect(detectRegion('🇭🇰 高速节点')).toBe('HK')
    expect(detectRegion('新加坡 IPLC')).toBe('SG')
    expect(detectRegion('Tokyo premium')).toBe('JP')
    expect(detectRegion('Los Angeles 01')).toBe('US')
  })

  test('returns null when no region signal is available', () => {
    expect(detectRegion('Premium Node 01')).toBeNull()
    expect(detectRegion(null)).toBeNull()
  })
})
