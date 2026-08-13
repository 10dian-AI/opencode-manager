import { toggleAccountChineseModels } from '../../utils/accounts'
import type { Account } from '../../utils/db'

type BulkAccountAction = 'refresh' | 'risk-control-check' | 'enable' | 'disable' | 'enable-chinese-models' | 'disable-chinese-models'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody<{ ids?: unknown; action?: unknown }>(event)
  const ids = parseAccountIds(body?.ids)
  const action = parseBulkAction(body?.action)
  const fetchedAccounts = await getAccountsByIds(ids)
  const byId = new Map(fetchedAccounts.map(account => [account.id, account]))
  const accounts = ids.map(id => byId.get(id))
  const missingIds = ids.filter((_, index) => !accounts[index])
  if (missingIds.length) {
    throw createError({
      statusCode: 404,
      statusMessage: `Account not found: ${missingIds.join(', ')}`
    })
  }

  if (action === 'risk-control-check') {
    const eligibleIds = accounts
      .filter(account => Boolean(account?.upstream_api_key))
      .map(account => account!.id)
    const results = await checkAccountRiskControlsByIds(eligibleIds)
    return {
      action,
      processed: results.length,
      skipped: ids.length - eligibleIds.length,
      blocked: results.filter(result => result.blocked).length,
      accounts: results.map(result => toPublicAccount(result.account))
    }
  }

  if (action === 'disable') {
    const eligibleIds = accounts
      .filter(account => account?.status !== 'disabled')
      .map(account => account!.id)
    const updated = await Promise.all(
      eligibleIds.map(id => updateAccountSettings(id, { status: 'disabled' }))
    )
    return {
      action,
      processed: updated.length,
      skipped: ids.length - eligibleIds.length,
      blocked: 0,
      accounts: updated.map(toPublicAccount)
    }
  }

  if (action === 'enable') {
    const eligibleIds = accounts
      .filter(account => account?.status === 'disabled')
      .map(account => account!.id)
    await Promise.all(eligibleIds.map(id => updateAccountSettings(id, { status: 'pending' })))
    const updated = await refreshAccountsByIds(eligibleIds)
    return {
      action,
      processed: updated.length,
      skipped: ids.length - eligibleIds.length,
      blocked: 0,
      accounts: updated.map(toPublicAccount)
    }
  }

  if (action === 'enable-chinese-models' || action === 'disable-chinese-models') {
    const enable = action === 'enable-chinese-models'
    const eligibleIds = accounts
      .filter(account => enable
        ? !account?.chinese_models_enabled_at
        : Boolean(account?.chinese_models_enabled_at))
      .map(account => account!.id)
    const results = await Promise.allSettled(
      eligibleIds.map(id => toggleAccountChineseModels(id, enable))
    )
    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length
    const updatedAccounts = results
      .filter((r): r is PromiseFulfilledResult<Account> => r.status === 'fulfilled')
      .map(r => toPublicAccount(r.value))
    return {
      action,
      processed: succeeded,
      skipped: ids.length - eligibleIds.length,
      blocked: 0,
      failed,
      accounts: updatedAccounts
    }
  }

  const updated = await refreshAccountsByIds(ids)
  return {
    action,
    processed: updated.length,
    skipped: 0,
    blocked: 0,
    accounts: updated.map(toPublicAccount)
  }
})

function parseAccountIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'ids is required' })
  }
  if (value.length > 1000 || value.some(id => !Number.isSafeInteger(id) || Number(id) <= 0)) {
    throw createError({ statusCode: 400, statusMessage: 'ids must contain valid account IDs' })
  }
  return [...new Set(value as number[])]
}

function parseBulkAction(value: unknown): BulkAccountAction {
  if (
    value !== 'refresh' &&
    value !== 'risk-control-check' &&
    value !== 'enable' &&
    value !== 'disable' &&
    value !== 'enable-chinese-models' &&
    value !== 'disable-chinese-models'
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid bulk action' })
  }
  return value
}
