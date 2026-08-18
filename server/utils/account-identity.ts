export function resolveRefreshedAccountEmail(
  refreshedEmail: string | null,
  existingEmail: string | null
) {
  return refreshedEmail || existingEmail || null
}

export interface CredentialResetSource {
  disabled_reason: string | null
  is_abandoned: boolean
  abandoned_reason: string | null
  chinese_models_manual_off_at: string | null
}

/**
 * Clear all data that belongs to the previous credential while preserving only
 * explicit operator policy attached to the managed slot itself.
 */
export function accountCredentialResetState(account: CredentialResetSource) {
  const manuallyDisabled = account.disabled_reason === 'manual'
  const manuallyAbandoned = account.abandoned_reason === 'manual'
  return {
    email: null,
    workspace_id: null,
    workspace_name: null,
    balance: null,
    rolling_usage: null,
    rolling_reset_sec: null,
    weekly_usage: null,
    weekly_reset_sec: null,
    monthly_usage: null,
    monthly_reset_sec: null,
    rolling_reset_at: null,
    weekly_reset_at: null,
    monthly_reset_at: null,
    next_quota_refresh_at: null,
    quota_refreshed_at: null,
    referral_code: null,
    last_referral_reward_id: null,
    last_referral_reward_applied_at: null,
    subscription_status: null,
    cancelled_subscription_id: null,
    subscription_cancelled_at: null,
    subscription_cancel_checked_at: null,
    subscription_ends_at: null,
    subscription_cancel_error: null,
    chinese_models_enabled_at: null,
    chinese_models_enable_error: null,
    chinese_models_checked_at: null,
    // This is an explicit operator preference, so keep it across credential replacement.
    chinese_models_manual_off_at: account.chinese_models_manual_off_at,
    upstream_api_key: null,
    status: manuallyDisabled ? 'disabled' as const : 'pending' as const,
    disabled_reason: manuallyDisabled ? 'manual' : null,
    is_abandoned: manuallyAbandoned ? account.is_abandoned : false,
    abandoned_reason: manuallyAbandoned ? 'manual' : null,
    auto_enable_at: null,
    risk_control_checked_at: null,
    risk_control_detected_at: null,
    last_error: null,
    last_synced_at: null
  }
}
