import { expect, test } from 'bun:test'
import { ERROR_REFRESH_INTERVAL_MS } from '../server/utils/account-refresh-policy'

test('error account retry policy uses a five second delay', () => {
  expect(ERROR_REFRESH_INTERVAL_MS).toBe(5_000)
})
