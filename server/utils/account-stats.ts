import type { Account } from './db'

export interface AccountCategoryStats {
  total: number
  poolTotal: number
  members: number
  nonMembers: number
  membershipUnknown: number
  riskControlled: number
  notRiskControlled: number
  abandoned: number
  abandonedRiskControlled: number
  abandonedMonthlyExhausted: number
  error: number
  disabled: number
  pending: number
  availableAccounts: Account[]
}

/** Classify every account in one pass so all counters share one DB snapshot. */
export function classifyAccounts(accounts: Account[]): AccountCategoryStats {
  const result: AccountCategoryStats = {
    total: accounts.length,
    poolTotal: 0,
    members: 0,
    nonMembers: 0,
    membershipUnknown: 0,
    riskControlled: 0,
    notRiskControlled: 0,
    abandoned: 0,
    abandonedRiskControlled: 0,
    abandonedMonthlyExhausted: 0,
    error: 0,
    disabled: 0,
    pending: 0,
    availableAccounts: []
  }

  for (const account of accounts) {
    if (account.status === 'disabled') result.disabled++
    if (account.status === 'pending') result.pending++
    if (account.status === 'error' || account.disabled_reason === 'risk_control') result.error++

    if (account.is_abandoned) {
      result.abandoned++
      if (account.abandoned_reason === 'risk_control') result.abandonedRiskControlled++
      if (account.abandoned_reason === 'monthly_limit') result.abandonedMonthlyExhausted++
      continue
    }

    result.poolTotal++
    if (account.subscription_status === 'active') result.members++
    else if (account.subscription_status === null) result.membershipUnknown++
    else result.nonMembers++

    if (account.disabled_reason === 'risk_control') result.riskControlled++
    else result.notRiskControlled++

    if (
      account.status === 'active' &&
      account.subscription_status === 'active' &&
      Boolean(account.upstream_api_key)
    ) result.availableAccounts.push(account)
  }

  return result
}
