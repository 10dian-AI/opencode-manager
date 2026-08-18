import { describe, expect, test } from 'bun:test'
import {
  analyzeQuota,
  effectiveRemainingAmount,
  QUOTA_LIMITS_USD,
  remainingAmount,
  remainingPercent,
  resetAtFromSeconds,
  usedAmount
} from '../server/utils/quota'

describe('quota accounting', () => {
  test('uses the configured 12/30/60 dollar windows', () => {
    expect(QUOTA_LIMITS_USD).toEqual({ rolling: 12, weekly: 30, monthly: 60 })
    expect(usedAmount(50, QUOTA_LIMITS_USD.rolling)).toBe(6)
    expect(usedAmount(25, QUOTA_LIMITS_USD.weekly)).toBe(7.5)
    expect(usedAmount(10, QUOTA_LIMITS_USD.monthly)).toBe(6)
  })

  test('calculates clamped remaining quota', () => {
    expect(remainingPercent(25)).toBe(75)
    expect(remainingPercent(120)).toBe(0)
    expect(remainingAmount(25, 12)).toBe(9)
    expect(remainingAmount(null, 12)).toBe(0)
  })

  test('uses the most constrained known quota window', () => {
    expect(effectiveRemainingAmount({
      rollingUsage: 50,
      weeklyUsage: 10,
      monthlyUsage: 25
    })).toBe(6)
    expect(effectiveRemainingAmount({
      rollingUsage: null,
      weeklyUsage: 50,
      monthlyUsage: null
    })).toBe(15)
    expect(effectiveRemainingAmount({
      rollingUsage: null,
      weeklyUsage: null,
      monthlyUsage: null
    })).toBe(0)
  })

  test('records absolute reset nodes and chooses the exhausted window release', () => {
    const now = new Date('2026-07-13T00:00:00.000Z')
    const rollingResetAt = resetAtFromSeconds(60, now)
    const weeklyResetAt = resetAtFromSeconds(120, now)
    const monthlyResetAt = resetAtFromSeconds(180, now)
    const quota = analyzeQuota({
      rollingUsage: 100,
      rollingResetAt,
      weeklyUsage: 100,
      weeklyResetAt,
      monthlyUsage: 50,
      monthlyResetAt
    })

    expect(quota.exhausted).toEqual(['rolling', 'weekly'])
    expect(quota.nextRefreshAt).toBe(rollingResetAt)
    expect(quota.autoEnableAt).toBe(weeklyResetAt)
  })
})
