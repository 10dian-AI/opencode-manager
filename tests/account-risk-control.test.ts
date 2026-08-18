import { describe, expect, test } from 'bun:test'
import {
  inspectRiskControlResponse,
  isProtectedAccountDisabledReason,
  resolveRiskControlRestoreState
} from '../server/utils/account-risk-control'

describe('account risk control', () => {
  test('recognizes the upstream provider AuthError without consuming the response', async () => {
    const body = {
      type: 'error',
      error: {
        type: 'AuthError',
        message: 'Request blocked by upstream provider.'
      }
    }
    const response = Response.json(body, { status: 401 })

    await expect(inspectRiskControlResponse(response)).resolves.toEqual({
      blocked: true,
      errorType: 'AuthError',
      message: 'Request blocked by upstream provider.'
    })
    await expect(response.json()).resolves.toEqual(body)
  })

  test('does not classify unrelated 401 responses as risk control', async () => {
    const response = Response.json({
      error: { type: 'AuthError', message: 'Invalid API key' }
    }, { status: 401 })

    expect((await inspectRiskControlResponse(response)).blocked).toBe(false)
  })

  test('recognizes explicit provider blocks returned as 403 or with normalized auth types', async () => {
    const forbidden = Response.json({
      error: { type: 'Authentication_Error', message: 'Request was blocked by the upstream provider.' }
    }, { status: 403 })

    await expect(inspectRiskControlResponse(forbidden)).resolves.toMatchObject({
      blocked: true,
      errorType: 'Authentication_Error'
    })
  })

  test('does not treat every 403 as risk control', async () => {
    const forbidden = Response.json({
      error: { type: 'AuthError', message: 'Permission denied' }
    }, { status: 403 })

    expect((await inspectRiskControlResponse(forbidden)).blocked).toBe(false)
  })
  test('preserves manual and risk-control disabled states during account refresh', () => {
    expect(isProtectedAccountDisabledReason('manual')).toBe(true)
    expect(isProtectedAccountDisabledReason('risk_control')).toBe(true)
    expect(isProtectedAccountDisabledReason('auth_expired')).toBe(true)
    expect(isProtectedAccountDisabledReason('quota:weekly')).toBe(false)
    expect(isProtectedAccountDisabledReason(null)).toBe(false)
  })
  test('restores risk-controlled accounts according to their cached quota state', () => {
    const base = {
      subscription_status: 'active',
      rolling_reset_at: '2026-08-18T01:00:00.000Z',
      weekly_reset_at: '2026-08-19T00:00:00.000Z',
      monthly_reset_at: '2026-09-01T00:00:00.000Z'
    }

    expect(resolveRiskControlRestoreState({
      ...base,
      rolling_usage: 100,
      weekly_usage: 20,
      monthly_usage: 10
    })).toMatchObject({
      status: 'disabled',
      disabledReason: 'quota:rolling',
      monthlyExhausted: false
    })

    expect(resolveRiskControlRestoreState({
      ...base,
      rolling_usage: 20,
      weekly_usage: 20,
      monthly_usage: 100
    })).toMatchObject({
      status: 'disabled',
      disabledReason: 'quota:monthly',
      monthlyExhausted: true
    })

    expect(resolveRiskControlRestoreState({
      ...base,
      subscription_status: 'inactive',
      rolling_usage: 20,
      weekly_usage: 20,
      monthly_usage: 20
    })).toMatchObject({
      status: 'disabled',
      disabledReason: 'expired'
    })
  })
})
