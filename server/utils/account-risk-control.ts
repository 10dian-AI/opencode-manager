import { analyzeQuota } from './quota'

export const RISK_CONTROL_DISABLED_REASON = 'risk_control'

export interface RiskControlInspection {
  blocked: boolean
  errorType: string | null
  message: string | null
}

export interface RiskControlRestoreSnapshot {
  subscription_status: string | null
  rolling_usage: number | null
  rolling_reset_at: string | null
  weekly_usage: number | null
  weekly_reset_at: string | null
  monthly_usage: number | null
  monthly_reset_at: string | null
}

export function isProtectedAccountDisabledReason(reason: string | null | undefined) {
  return reason === 'manual' ||
    reason === 'auth_expired' ||
    reason === RISK_CONTROL_DISABLED_REASON
}

export function resolveRiskControlRestoreState(account: RiskControlRestoreSnapshot) {
  const quota = analyzeQuota({
    rollingUsage: account.rolling_usage,
    rollingResetAt: account.rolling_reset_at,
    weeklyUsage: account.weekly_usage,
    weeklyResetAt: account.weekly_reset_at,
    monthlyUsage: account.monthly_usage,
    monthlyResetAt: account.monthly_reset_at
  })
  const membershipExpired =
    account.subscription_status !== null && account.subscription_status !== 'active'
  const disabledReason = membershipExpired
    ? 'expired'
    : quota.exhausted.length
      ? `quota:${quota.exhausted.join(',')}`
      : null

  return {
    status: disabledReason ? 'disabled' as const : 'active' as const,
    disabledReason,
    autoEnableAt: disabledReason?.startsWith('quota:') ? quota.autoEnableAt : null,
    monthlyExhausted:
      typeof account.monthly_usage === 'number' && account.monthly_usage >= 100
  }
}

export async function inspectRiskControlResponse(
  response: Response
): Promise<RiskControlInspection> {
  if (response.status !== 401) {
    return { blocked: false, errorType: null, message: null }
  }

  const body = await response.clone().json().catch(() => null) as {
    error?: { type?: unknown; message?: unknown }
  } | null
  const errorType = typeof body?.error?.type === 'string' ? body.error.type : null
  const message = typeof body?.error?.message === 'string' ? body.error.message : null
  const blocked = errorType?.toLowerCase() === 'autherror' &&
    message?.toLowerCase().includes('request blocked by upstream provider') === true

  return { blocked, errorType, message }
}
