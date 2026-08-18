import { describe, expect, test } from 'bun:test'
import {
  accountCredentialResetState,
  resolveRefreshedAccountEmail
} from '../server/utils/account-identity'

describe('account identity refresh', () => {
  test('preserves the known email when a refresh cannot parse it', () => {
    expect(resolveRefreshedAccountEmail(null, 'known@example.com')).toBe('known@example.com')
  })

  test('uses a newly parsed email when one is available', () => {
    expect(resolveRefreshedAccountEmail('new@example.com', 'known@example.com')).toBe('new@example.com')
  })

  test('clears credential-owned state while preserving explicit slot policy', () => {
    const reset = accountCredentialResetState({
      disabled_reason: 'manual',
      is_abandoned: true,
      abandoned_reason: 'manual',
      chinese_models_manual_off_at: '2026-08-18T00:00:00.000Z'
    })

    expect(reset).toMatchObject({
      email: null,
      workspace_id: null,
      balance: null,
      rolling_usage: null,
      subscription_status: null,
      cancelled_subscription_id: null,
      chinese_models_enabled_at: null,
      upstream_api_key: null,
      status: 'disabled',
      disabled_reason: 'manual',
      is_abandoned: true,
      abandoned_reason: 'manual',
      chinese_models_manual_off_at: '2026-08-18T00:00:00.000Z',
      last_synced_at: null
    })
  })

  test('removes automatic disabled and abandoned state for a new credential', () => {
    expect(accountCredentialResetState({
      disabled_reason: 'risk_control',
      is_abandoned: true,
      abandoned_reason: 'risk_control',
      chinese_models_manual_off_at: null
    })).toMatchObject({
      status: 'pending',
      disabled_reason: null,
      is_abandoned: false,
      abandoned_reason: null,
      risk_control_detected_at: null
    })
  })
})
