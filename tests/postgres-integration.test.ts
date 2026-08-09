import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  checkLoginRateLimit,
  clearLoginFailures,
  closeDb,
  createAccount,
  deleteAccount,
  getDb,
  recordLoginFailure,
  tryAcquireAccountProxySlot,
  withAdvisoryLock,
  withAuthCookieLocks
} from '../server/utils/db'

const databaseName = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL).pathname.slice(1)
  : ''
const destructiveOptIn = process.env.RUN_DESTRUCTIVE_DB_TESTS === 'true'
const integrationDescribe = process.env.DATABASE_URL && destructiveOptIn && /_test$/i.test(databaseName)
  ? describe
  : describe.skip

integrationDescribe('PostgreSQL integration', () => {
  beforeAll(async () => {
    const db = await getDb()
    await db.query('TRUNCATE accounts, sessions, api_keys, ip_pool, app_settings, auth_login_attempts, account_proxy_slots RESTART IDENTITY CASCADE')
  })

  afterAll(async () => {
    await closeDb()
  })

  test('initializes the coordination tables', async () => {
    const db = await getDb()
    const result = await db.query<{ name: string }>(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name
    `, [['account_proxy_slots', 'auth_login_attempts']])

    expect(result.rows.map(row => row.name)).toEqual([
      'account_proxy_slots',
      'auth_login_attempts'
    ])
  })

  test('serializes distributed operations without exhausting a one-connection pool', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const started = new Promise<void>(resolve => { firstStarted = resolve })
    const first = withAdvisoryLock('integration-lock', async () => {
      order.push('first-start')
      firstStarted()
      await gate
      order.push('first-end')
    })
    await started
    const second = withAdvisoryLock('integration-lock', async () => {
      order.push('second')
    })
    await Bun.sleep(25)
    releaseFirst()
    await Promise.all([first, second])

    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  test('deduplicates external cookie imports while allowing workspace expansion', async () => {
    const cookie = `integration-cookie-${Date.now()}`
    const account = await withAuthCookieLocks([cookie], () => createAccount({ auth_cookie: cookie }))

    let duplicateStatus: number | undefined
    try {
      await withAuthCookieLocks([cookie], () => createAccount({ auth_cookie: cookie }))
    } catch (error) {
      duplicateStatus = (error as { statusCode?: number }).statusCode
    }
    expect(duplicateStatus).toBe(409)

    const workspace = await createAccount({
      auth_cookie: cookie,
      workspace_id: 'wrk_INTEGRATION',
      allow_existing_cookie: true
    })
    expect(workspace.workspace_id).toBe('wrk_INTEGRATION')

    await deleteAccount(account.id)
    await deleteAccount(workspace.id)
  })

  test('shares and releases account proxy slots', async () => {
    const first = await tryAcquireAccountProxySlot(1001, 1, 5_000)
    expect(first).toBeFunction()
    expect(await tryAcquireAccountProxySlot(1001, 1, 5_000)).toBeNull()
    await first!()
    const second = await tryAcquireAccountProxySlot(1001, 1, 5_000)
    expect(second).toBeFunction()
    await second!()
  })

  test('blocks repeated login failures and clears them after success', async () => {
    const identifier = `integration-${Date.now()}`
    for (let attempt = 0; attempt < 9; attempt++) {
      await recordLoginFailure(identifier)
    }
    let failureStatus: number | undefined
    let checkStatus: number | undefined
    try {
      await recordLoginFailure(identifier)
    } catch (error) {
      failureStatus = (error as { statusCode?: number }).statusCode
    }
    try {
      await checkLoginRateLimit(identifier)
    } catch (error) {
      checkStatus = (error as { statusCode?: number }).statusCode
    }
    expect(failureStatus).toBe(429)
    expect(checkStatus).toBe(429)
    await clearLoginFailures(identifier)
    expect(await checkLoginRateLimit(identifier)).toBeUndefined()
  })
})
