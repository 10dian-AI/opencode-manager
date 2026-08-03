import { describe, expect, test } from 'bun:test'
import {
  AccountPollSchedule,
  ERROR_REFRESH_INTERVAL_MS,
  type PollableAccount
} from '../server/utils/account-polling'

const NOW = new Date('2026-07-13T12:00:00.000Z').getTime()

function account(id: number, values: Partial<PollableAccount> = {}): PollableAccount {
  return {
    id,
    status: 'active',
    disabled_reason: null,
    next_quota_refresh_at: null,
    auto_enable_at: null,
    last_synced_at: new Date(NOW).toISOString(),
    ...values
  }
}

describe('account polling schedule', () => {
  test('hydrates once and returns only due quota accounts', () => {
    const schedule = new AccountPollSchedule()
    schedule.hydrate([
      account(1, { next_quota_refresh_at: new Date(NOW - 1).toISOString() }),
      account(2, { next_quota_refresh_at: new Date(NOW + 60_000).toISOString() })
    ], NOW)

    expect(schedule.takeDue('quota', NOW)).toEqual([1])
    expect(schedule.takeDue('quota', NOW + 60_000)).toEqual([2])
    expect(schedule.takeDue('quota', NOW + 60_000)).toEqual([])
  })

  test('rescheduling invalidates stale heap entries', () => {
    const schedule = new AccountPollSchedule()
    schedule.hydrate([account(1, { next_quota_refresh_at: new Date(NOW + 1_000).toISOString() })], NOW)
    schedule.schedule(account(1, { next_quota_refresh_at: new Date(NOW + 5_000).toISOString() }), NOW)

    expect(schedule.takeDue('quota', NOW + 1_000)).toEqual([])
    expect(schedule.takeDue('quota', NOW + 5_000)).toEqual([1])
  })

  test('keeps manually disabled accounts out of both polling queues', () => {
    const schedule = new AccountPollSchedule()
    schedule.hydrate([account(1, {
      disabled_reason: 'manual',
      next_quota_refresh_at: new Date(NOW - 1).toISOString(),
      last_synced_at: new Date(NOW - 60 * 60 * 1000).toISOString()
    })], NOW)

    expect(schedule.takeDue('quota', NOW)).toEqual([])
    expect(schedule.takeDue('membership', NOW)).toEqual([])
    expect(schedule.takeDue('error', NOW + ERROR_REFRESH_INTERVAL_MS)).toEqual([])
  })

  test('schedules membership checks from the last sync time', () => {
    const schedule = new AccountPollSchedule()
    schedule.hydrate([account(1)], NOW)

    expect(schedule.takeDue('membership', NOW + 14 * 60_000)).toEqual([])
    expect(schedule.takeDue('membership', NOW + 15 * 60_000)).toEqual([1])
  })

  test('retries error accounts five minutes after their last failed sync', () => {
    const schedule = new AccountPollSchedule()
    schedule.hydrate([account(1, { status: 'error' })], NOW)

    expect(schedule.takeDue('error', NOW + ERROR_REFRESH_INTERVAL_MS - 1)).toEqual([])
    expect(schedule.takeDue('error', NOW + ERROR_REFRESH_INTERVAL_MS)).toEqual([1])
  })

  test('hydrates overdue error accounts as immediately due', () => {
    const schedule = new AccountPollSchedule()
    schedule.hydrate([account(1, {
      status: 'error',
      last_synced_at: new Date(NOW - ERROR_REFRESH_INTERVAL_MS).toISOString()
    })], NOW)

    expect(schedule.takeDue('error', NOW)).toEqual([1])
  })

  test('successful rescheduling clears a pending error retry', () => {
    const schedule = new AccountPollSchedule()
    schedule.hydrate([account(1, { status: 'error' })], NOW)
    schedule.schedule(account(1, { status: 'active' }), NOW + 1_000)

    expect(schedule.takeDue('error', NOW + ERROR_REFRESH_INTERVAL_MS)).toEqual([])
  })
})
