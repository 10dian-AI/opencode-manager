import { describe, expect, test } from 'bun:test'
import type { Account } from '../server/utils/db'
import { classifyAccounts } from '../server/utils/account-stats'

function account(input: Partial<Account> & Pick<Account, 'id'>): Account {
  return {
    id: input.id,
    status: 'active',
    subscription_status: 'active',
    upstream_api_key: `sk-${input.id}`,
    is_abandoned: false,
    abandoned_reason: null,
    disabled_reason: null,
    monthly_usage: 20,
    ...input
  } as Account
}

describe('account category counters', () => {
  test('counts every main-pool category independently without subtraction', () => {
    const result = classifyAccounts([
      account({ id: 1, subscription_status: 'active' }),
      account({ id: 2, subscription_status: 'inactive', status: 'disabled' }),
      account({ id: 3, subscription_status: null, status: 'pending' }),
      account({ id: 4, disabled_reason: 'risk_control', status: 'disabled' })
    ])

    expect(result).toMatchObject({
      total: 4,
      poolTotal: 4,
      members: 2,
      nonMembers: 1,
      membershipUnknown: 1,
      riskControlled: 1,
      notRiskControlled: 3
    })
  })

  test('counts abandoned totals and reasons separately from the main pool', () => {
    const result = classifyAccounts([
      account({
        id: 1,
        is_abandoned: true,
        abandoned_reason: 'risk_control',
        disabled_reason: 'risk_control',
        monthly_usage: 100
      }),
      account({
        id: 2,
        is_abandoned: true,
        abandoned_reason: 'monthly_limit',
        monthly_usage: 100
      }),
      account({
        id: 3,
        is_abandoned: true,
        abandoned_reason: 'manual',
        monthly_usage: 10
      }),
      account({ id: 4 })
    ])

    expect(result).toMatchObject({
      total: 4,
      poolTotal: 1,
      members: 1,
      riskControlled: 0,
      notRiskControlled: 1,
      abandoned: 3,
      abandonedRiskControlled: 1,
      abandonedMonthlyExhausted: 1
    })
  })
})
