import { getDb } from './db'

const AUTO_REFRESH_ERRORS_KEY = 'auto_refresh_error_accounts'
const DEFAULT_AUTO_REFRESH_ERRORS = true

export interface AccountRefreshSettings {
  auto_refresh_errors: boolean
  error_refresh_interval_minutes: number
}

export async function getAccountRefreshSettings(): Promise<AccountRefreshSettings> {
  const db = await getDb()
  const { rows } = await db.query<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [AUTO_REFRESH_ERRORS_KEY]
  )
  const stored = rows[0]?.value
  return {
    auto_refresh_errors: stored === undefined
      ? DEFAULT_AUTO_REFRESH_ERRORS
      : stored === 'true',
    error_refresh_interval_minutes: 5
  }
}

export async function setAutoRefreshErrors(enabled: boolean) {
  const db = await getDb()
  await db.query(`
    INSERT INTO app_settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `, [AUTO_REFRESH_ERRORS_KEY, String(enabled)])
  return getAccountRefreshSettings()
}
