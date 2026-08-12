import type { Account, AccountStatus } from './db'
import { resolveRefreshedAccountEmail } from './account-identity'
import { AccountOperationQueue } from './account-operation-queue'
import { AccountPollSchedule, ERROR_REFRESH_INTERVAL_MS } from './account-polling'
import { getAccountRefreshSettings } from './account-refresh-settings'
import {
  beginAccountRefreshProgress,
  clearAccountRefreshProgress,
  flushAccountRefreshProgress,
  type AccountRefreshProgressReporter
} from './account-refresh-progress'
import { validateAuthCookieValue } from './auth-cookie'
import { AuthCookieExpiredError, buildAuthCookie, type OpenCodeAccountInfo } from './opencode'
import { createAccountFetch } from './account-fetch'
import { ensureAccountIpAssignment } from './ip-pool'
import {
  discoverChineseModelsServerId,
  enableOpenCodeChineseModels
} from './opencode-chinese-models'
import {
  inspectRiskControlResponse,
  isProtectedAccountDisabledReason,
  RISK_CONTROL_DISABLED_REASON
} from './account-risk-control'
import {
  cacheAvailableReferralRewards,
  consumeCachedReferralReward,
  flushCachedReferralRewards,
  getCachedReferralRewards,
  hydrateCachedReferralRewards,
  removeCachedReferralRewards,
  selectCachedReferralReward,
  retainCachedReferralRewardAccounts
} from './referral-reward-cache'

const accountRefreshes = new Map<number, Promise<Account>>()
const accountOperations = new AccountOperationQueue()
const accountPollSchedule = new AccountPollSchedule()
let accountPollScheduleHydrated = false
const REFRESH_CONCURRENCY = 4
const RISK_CONTROL_CHECK_MODEL = process.env.RISK_CONTROL_CHECK_MODEL || 'glm-5.2'
const AUTO_APPLY_REFERRAL_REWARDS = process.env.AUTO_APPLY_REFERRAL_REWARDS === 'true'
const AUTO_CANCEL_SUBSCRIPTION_RENEWAL = process.env.AUTO_CANCEL_SUBSCRIPTION_RENEWAL === 'true'
const AUTO_ENABLE_CHINESE_MODELS = process.env.AUTO_ENABLE_CHINESE_MODELS !== 'false'

let accountPollScheduleHydration: Promise<void> | null = null

function runAccountOperation<T>(id: number, operation: () => Promise<T>) {
  return accountOperations.run(id, async () => {
    const result = await withAdvisoryLock(`account-operation:${id}`, async () => {
      try {
        return await operation()
      } finally {
        await Promise.all([
          flushAccountRefreshProgress(id),
          flushCachedReferralRewards(id)
        ])
      }
    })
    return result as T
  })
}

function ensureAccountPollSchedule(now = Date.now()): Promise<void> {
  if (accountPollScheduleHydrated) return Promise.resolve()
  if (accountPollScheduleHydration) return accountPollScheduleHydration

  const hydration = listAccounts()
    .then(accounts => {
      accountPollSchedule.hydrate(accounts, now)
      accountPollScheduleHydrated = true
      accountPollScheduleHydration = null
    })
    .catch(error => {
      // Clear the memo so a transient database failure can be retried.
      accountPollScheduleHydration = null
      throw error
    })
  accountPollScheduleHydration = hydration
  return hydration
}

export async function updateAccountPollSchedule(account: Account) {
  await ensureAccountPollSchedule()
  accountPollSchedule.schedule(account)
}

export async function removeAccountPollSchedule(id: number) {
  await ensureAccountPollSchedule()
  accountPollSchedule.remove(id)
  removeCachedReferralRewards(id)
  clearAccountRefreshProgress(id)
}

export async function rebuildAccountPollSchedule() {
  const accounts = await listAccounts()
  accountPollSchedule.hydrate(accounts)
  retainCachedReferralRewardAccounts(accounts.map(account => account.id))
  accountPollScheduleHydrated = true
}

export function deleteManagedAccount(id: number) {
  return runAccountOperation(id, async () => {
    const result = await deleteAccount(id)
    await Promise.resolve(removeAccountPollSchedule(id)).catch(() => {})
    return result
  })
}

export async function deleteManagedAccounts(ids: number[]) {
  const uniqueIds = [...new Set(ids)]
  const result = await withAccountLocks(uniqueIds, () => deleteAccounts(uniqueIds))
  await Promise.allSettled(uniqueIds.map(removeAccountPollSchedule))
  return result
}

export async function deleteManagedNonMemberAccounts() {
  const ids = (await listAccounts())
    .filter(account => account.subscription_status !== null && account.subscription_status !== 'active')
    .map(account => account.id)
  if (!ids.length) return { changes: 0 }
  return withAccountLocks(ids, async () => {
    const current = await getAccountsByIds(ids)
    const eligibleIds = current
      .filter(account => account.subscription_status !== null && account.subscription_status !== 'active')
      .map(account => account.id)
    if (!eligibleIds.length) return { changes: 0 }
    const result = await deleteAccounts(eligibleIds)
    await Promise.allSettled(eligibleIds.map(removeAccountPollSchedule))
    return result
  })
}

export function updateAccountSettings(
  id: number,
  body: {
    name?: string
    auth_cookie?: string
    status?: AccountStatus
  }
) {
  return runAccountOperation(id, async () => {
    const account = await getAccount(id)
    if (!account) {
      throw createError({ statusCode: 404, statusMessage: 'Account not found' })
    }
    const nextAuthCookie = body.auth_cookie === undefined
      ? undefined
      : validateAuthCookieValue(body.auth_cookie)
    const credentialChanged = nextAuthCookie !== undefined && nextAuthCookie !== account.auth_cookie

    const updated = (await updateAccount(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(nextAuthCookie !== undefined ? { auth_cookie: nextAuthCookie } : {}),
      ...(credentialChanged
        ? {
            email: null,
            workspace_id: null,
            workspace_name: null,
            upstream_api_key: null,
            referral_code: null,
            risk_control_checked_at: null,
            risk_control_detected_at: null,
            ...(account.disabled_reason === RISK_CONTROL_DISABLED_REASON ||
              account.disabled_reason === 'auth_expired'
              ? {
                  status: 'pending' as AccountStatus,
                  disabled_reason: null,
                  auto_enable_at: null,
                  last_error: null
                }
              : {})
          }
        : {}),
      ...(body.status !== undefined
        ? body.status === 'disabled'
          ? { status: body.status, disabled_reason: 'manual', auto_enable_at: null }
          : { status: body.status, disabled_reason: null, auto_enable_at: null }
        : {})
    }))!
    if (credentialChanged) {
      removeCachedReferralRewards(id)
    }
    await updateAccountPollSchedule(updated)
    return updated
  })
}

async function mapConcurrent<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>) {
  const results: R[] = []
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await callback(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function expandAccountWorkspacesOnce(id: number): Promise<Account[]> {
  const account = await ensureAccountIpAssignment(id)
  if (!account) return []

  try {
    const infos = await fetchOpenCodeAccounts(
      account.auth_cookie,
      account.workspace_id,
      await createAccountFetch(account)
    )
    const workspaceInfos = infos.filter(
      (info): info is OpenCodeAccountInfo & { workspaceId: string } => Boolean(info.workspaceId)
    )
    if (!workspaceInfos.length) return [account]

    const primary = workspaceInfos[0]!
    const additional = workspaceInfos.slice(1)
    const expanded = [
      (await updateAccount(account.id, {
        workspace_id: primary.workspaceId,
        workspace_name: primary.workspaceName
      }))!
    ]

    for (const info of additional) {
      const created = await createAccount({
        name: account.name || undefined,
        auth_cookie: account.auth_cookie,
        workspace_id: info.workspaceId,
        workspace_name: info.workspaceName,
        allow_existing_cookie: true
      })
      expanded.push(created)
    }
    return expanded
  } catch {
    // Keep the original pending account so the normal refresh path records the upstream error.
    return [account]
  }
}

export async function enableAccountChineseModels(id: number): Promise<Account> {
  const account = await ensureAccountIpAssignment(id)
  if (!account) throw createError({ statusCode: 404, statusMessage: 'Account not found' })

  try {
    const fetchImpl = await createAccountFetch(account)
    const info = await fetchOpenCodeAccount(
      account.auth_cookie,
      account.workspace_id,
      fetchImpl
    )
    const workspaceId = info.workspaceId || account.workspace_id
    if (!workspaceId) throw new Error('无法获取账号的 workspace ID')

    const response = await fetchImpl(`https://opencode.ai/workspace/${workspaceId}/go`, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh',
        cookie: buildAuthCookie(account.auth_cookie),
        referer: 'https://opencode.ai/zh/go',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    })
    if (!response.ok) throw new Error(`获取 workspace 页面失败（${response.status}）`)
    const serverId = await discoverChineseModelsServerId(await response.text(), fetchImpl)
    if (!serverId) throw new Error('无法识别开启中国模型所需的服务操作')

    await enableOpenCodeChineseModels(account.auth_cookie, workspaceId, serverId, fetchImpl)
    return (await updateAccount(id, {
      workspace_id: workspaceId,
      chinese_models_enabled_at: new Date().toISOString(),
      chinese_models_enable_error: null
    }))!
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateAccount(id, { chinese_models_enable_error: message }).catch(() => {})
    throw createError({ statusCode: 502, statusMessage: message })
  }
}

async function autoEnableChineseModels(accounts: Account[]) {
  if (!AUTO_ENABLE_CHINESE_MODELS) return
  await mapConcurrent(accounts, REFRESH_CONCURRENCY, async account => {
    try {
      await enableAccountChineseModels(account.id)
    } catch {
      // Import and account refresh remain successful; the saved error is shown
      // in the account list and the user can retry with the globe action.
    }
  })
}

export async function expandAccountWorkspacesByIds(ids: number[]) {
  const expanded = await mapConcurrent(ids, REFRESH_CONCURRENCY, expandAccountWorkspaces)
  await ensureStableIpAssignments()
  const accounts = await mapConcurrent(
    expanded.flat(),
    REFRESH_CONCURRENCY,
    async account => (await getAccount(account.id)) || account
  )
  await autoEnableChineseModels(accounts)
  return getAccountsByIds(accounts.map(account => account.id))
}

function quotaFromInfo(info: Awaited<ReturnType<typeof fetchOpenCodeAccount>>, now: Date) {
  const rollingResetAt = resetAtFromSeconds(info.rollingResetSec, now)
  const weeklyResetAt = resetAtFromSeconds(info.weeklyResetSec, now)
  const monthlyResetAt = resetAtFromSeconds(info.monthlyResetSec, now)
  const quota = analyzeQuota({
    rollingUsage: info.rollingUsage,
    rollingResetAt,
    weeklyUsage: info.weeklyUsage,
    weeklyResetAt,
    monthlyUsage: info.monthlyUsage,
    monthlyResetAt
  })
  return { rollingResetAt, weeklyResetAt, monthlyResetAt, quota }
}

interface RefreshAccountOptions {
  skipReferralRewards?: boolean
  throwOnError?: boolean
  progress?: AccountRefreshProgressReporter
}

function cacheReferralRewards(accountId: number, info: OpenCodeAccountInfo) {
  cacheAvailableReferralRewards(accountId, {
    rewardIds: info.availableReferralRewardIds,
    usedRewardIds: info.usedReferralRewardIds,
    workspaceId: info.workspaceId,
    applyServerId: info.referralApplyServerId
  })
}

export function refreshAccount(id: number): Promise<Account> {
  const pending = accountRefreshes.get(id)
  if (pending) return pending

  const progress = beginAccountRefreshProgress(id)
  const refresh = runAccountOperation(id, () => refreshAccountOnce(id, { progress }))
    .then(async account => {
      if (account.status === 'error') {
        progress.fail(account.last_error || '账号刷新失败')
      } else {
        progress.complete()
      }
      await updateAccountPollSchedule(account)
      return account
    })
    .catch(error => {
      progress.fail(error instanceof Error ? error.message : String(error))
      throw error
    })
    .finally(() => {
      if (accountRefreshes.get(id) === refresh) accountRefreshes.delete(id)
    })
  accountRefreshes.set(id, refresh)
  return refresh
}

async function refreshAccountOnce(id: number, options: RefreshAccountOptions): Promise<Account> {
  const account = await ensureAccountIpAssignment(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'Account not found' })
  }
  const fetchImpl = await createAccountFetch(account)

  try {
    options.progress?.update('workspace', '正在加载 workspace 页面')
    let info = await fetchOpenCodeAccount(
      account.auth_cookie,
      account.workspace_id,
      fetchImpl,
      stage => {
        options.progress?.update(
          'workspace',
          stage === 'route-modules'
            ? '正在更新共享 JS 路由缓存'
            : '正在加载 workspace 页面'
        )
      }
    )
    cacheReferralRewards(id, info)
    options.progress?.update('referral', '正在检查推广额度')
    let referralError: string | null = null
    const attemptedRewards = new Set<string>()

    while (
      !options.skipReferralRewards &&
      AUTO_APPLY_REFERRAL_REWARDS &&
      !isProtectedAccountDisabledReason(account.disabled_reason) &&
      info.subscriptionStatus === 'active' &&
      attemptedRewards.size < 20
    ) {
      const currentQuota = quotaFromInfo(info, new Date()).quota
      if (!currentQuota.exhausted.length) break

      const referralId = info.availableReferralRewardIds.find(id => !attemptedRewards.has(id))
      if (!referralId) break
      if (!info.workspaceId || !info.referralApplyServerId) {
        referralError = 'Available referral reward found, but the apply action could not be resolved'
        break
      }

      // Safety check: ensure we're making progress
      const previousSize = attemptedRewards.size
      attemptedRewards.add(referralId)
      if (attemptedRewards.size === previousSize) {
        // This should never happen, but guards against infinite loop if Set logic fails
        referralError = 'Referral reward loop detected - aborting'
        break
      }

      options.progress?.update(
        'referral',
        `正在使用推广额度（${attemptedRewards.size}/20）`
      )
      try {
        await applyOpenCodeReferralReward(
          account.auth_cookie,
          info.workspaceId,
          referralId,
          info.referralApplyServerId,
          fetchImpl
        )
        consumeCachedReferralReward(id, referralId)
      } catch (error) {
        const latest = await fetchOpenCodeAccount(account.auth_cookie, info.workspaceId, fetchImpl)
        cacheReferralRewards(id, latest)
        if (latest.availableReferralRewardIds.includes(referralId)) throw error
        // Another process applied the same reward after this refresh began.
        info = latest
      }

      const appliedAt = new Date().toISOString()
      await updateAccount(id, {
        last_referral_reward_id: referralId,
        last_referral_reward_applied_at: appliedAt
      })
      info = await fetchOpenCodeAccount(account.auth_cookie, info.workspaceId, fetchImpl)
      cacheReferralRewards(id, info)
    }

    const workspaceId = info.workspaceId || account.workspace_id
    options.progress?.update('subscription', '正在检查订阅与自动续费')
    const subscriptionUpdate: Partial<Account> = {}
    if (
      AUTO_CANCEL_SUBSCRIPTION_RENEWAL &&
      info.subscriptionStatus === 'active' &&
      info.liteSubscriptionId &&
      workspaceId
    ) {
      const checkedAt = account.subscription_cancel_checked_at
        ? new Date(account.subscription_cancel_checked_at).getTime()
        : 0
      const checkExpired = !Number.isFinite(checkedAt) || Date.now() - checkedAt >= 24 * 60 * 60 * 1000
      const shouldCheck =
        account.cancelled_subscription_id !== info.liteSubscriptionId ||
        !account.subscription_cancelled_at ||
        checkExpired

      if (shouldCheck) {
        if (!info.billingPortalServerId) {
          subscriptionUpdate.subscription_cancel_error =
            'Active subscription found, but the billing portal action could not be resolved'
        } else {
          try {
            const cancellation = await cancelOpenCodeSubscriptionRenewal(
              account.auth_cookie,
              workspaceId,
              info.liteSubscriptionId,
              info.billingPortalServerId,
              fetchImpl
            )
            const cancelledAt = new Date().toISOString()
            subscriptionUpdate.cancelled_subscription_id = info.liteSubscriptionId
            subscriptionUpdate.subscription_cancelled_at =
              cancellation.alreadyCancelled &&
              account.cancelled_subscription_id === info.liteSubscriptionId &&
              account.subscription_cancelled_at
                ? account.subscription_cancelled_at
                : cancelledAt
            subscriptionUpdate.subscription_cancel_checked_at = cancelledAt
            subscriptionUpdate.subscription_ends_at = cancellation.currentPeriodEnd
            subscriptionUpdate.subscription_cancel_error = null
          } catch (error) {
            subscriptionUpdate.subscription_cancel_error =
              error instanceof Error ? error.message : String(error)
          }
        }
      }
    }

    let upstreamApiKey = account.upstream_api_key
    options.progress?.update(
      'api-key',
      upstreamApiKey ? '正在验证已缓存的 API Key' : '正在获取 API Key'
    )
    if (workspaceId && !upstreamApiKey) {
      try {
        upstreamApiKey = await fetchOpenCodeApiKey(account.auth_cookie, workspaceId, fetchImpl) || upstreamApiKey
      } catch (error) {
        if (error instanceof AuthCookieExpiredError) throw error
        // Quota and membership refresh must still succeed if the keys page is temporarily unavailable.
      }
    }
    options.progress?.update('finalizing', '正在计算额度并保存账号状态')
    const now = new Date()
    const { rollingResetAt, weeklyResetAt, monthlyResetAt, quota } = quotaFromInfo(info, now)
    const currentAccount = (await getAccount(id)) || account
    const membershipKnown = info.subscriptionStatus !== null
    const isMember = membershipKnown
      ? info.subscriptionStatus === 'active'
      : currentAccount.subscription_status === 'active'
    const protectedDisabledReason = currentAccount.status === 'disabled' &&
      currentAccount.disabled_reason !== 'auth_expired' &&
      isProtectedAccountDisabledReason(currentAccount.disabled_reason)
      ? currentAccount.disabled_reason
      : null
    const status: AccountStatus = protectedDisabledReason
      ? 'disabled'
      : (membershipKnown && !isMember) || quota.exhausted.length
        ? 'disabled'
        : 'active'
    const disabledReason = protectedDisabledReason
      ? protectedDisabledReason
      : membershipKnown && !isMember
        ? 'expired'
        : quota.exhausted.length
          ? `quota:${quota.exhausted.join(',')}`
          : null
    return (await updateAccount(id, {
      email: resolveRefreshedAccountEmail(info.email, account.email),
      workspace_id: info.workspaceId,
      workspace_name: info.workspaceName,
      balance: info.balance,
      rolling_usage: info.rollingUsage,
      rolling_reset_sec: info.rollingResetSec,
      weekly_usage: info.weeklyUsage,
      weekly_reset_sec: info.weeklyResetSec,
      monthly_usage: info.monthlyUsage,
      monthly_reset_sec: info.monthlyResetSec,
      rolling_reset_at: rollingResetAt,
      weekly_reset_at: weeklyResetAt,
      monthly_reset_at: monthlyResetAt,
      next_quota_refresh_at: quota.nextRefreshAt,
      quota_refreshed_at: now.toISOString(),
      referral_code: info.referralCode,
      subscription_status: info.subscriptionStatus ?? currentAccount.subscription_status,
      ...subscriptionUpdate,
      upstream_api_key: upstreamApiKey,
      status,
      disabled_reason: disabledReason,
      auto_enable_at: disabledReason?.startsWith('quota:') ? quota.autoEnableAt : null,
      last_error: protectedDisabledReason === RISK_CONTROL_DISABLED_REASON
        ? currentAccount.last_error
        : referralError,
      last_synced_at: now.toISOString()
    }))!
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const currentAccount = (await getAccount(id)) || account
    const cookieExpired = err instanceof AuthCookieExpiredError
    const preserveDisabled = currentAccount.status === 'disabled' &&
      isProtectedAccountDisabledReason(currentAccount.disabled_reason)

    let failedAccount: Account
    try {
      failedAccount = (await updateAccount(id, {
        status: preserveDisabled || cookieExpired ? 'disabled' : 'error',
        disabled_reason: preserveDisabled
          ? currentAccount.disabled_reason
          : cookieExpired
            ? 'auth_expired'
            : currentAccount.disabled_reason,
        last_error: currentAccount.disabled_reason === RISK_CONTROL_DISABLED_REASON
          ? currentAccount.last_error || message
          : message,
        last_synced_at: new Date().toISOString()
      }))!
    } catch (updateError) {
      // If account update fails, log but re-throw original error
      console.error('Failed to update account error state:', updateError)
      throw err
    }
    if (options.throwOnError) throw err
    return failedAccount
  }
}

export async function refreshAllAccounts() {
  const accounts = (await listAccounts()).filter(a => a.disabled_reason !== 'manual')
  return mapConcurrent(accounts, REFRESH_CONCURRENCY, account => refreshAccount(account.id))
}

export async function refreshAccountsByIds(ids: number[]) {
  return mapConcurrent(ids, REFRESH_CONCURRENCY, async (id) => {
    try {
      return await refreshAccount(id)
    } catch (error) {
      console.error(`Failed to refresh account ${id}:`, error)
      const account = await getAccount(id)
      if (account) return account
      throw error
    }
  })
}

export interface RiskControlCheckResult {
  account: Account
  blocked: boolean
  upstreamStatus: number
  errorType: string | null
  message: string | null
}

export async function markAccountRiskControlled(
  id: number,
  message: string | null
): Promise<Account | undefined> {
  const account = await getAccount(id)
  if (!account) return undefined

  const now = new Date().toISOString()
  const updated = (await updateAccount(id, {
    status: 'disabled',
    disabled_reason: RISK_CONTROL_DISABLED_REASON,
    auto_enable_at: null,
    risk_control_checked_at: now,
    risk_control_detected_at: account.disabled_reason === RISK_CONTROL_DISABLED_REASON
      ? account.risk_control_detected_at || now
      : now,
    last_error: message || 'Request blocked by upstream provider.'
  }))!
  await updateAccountPollSchedule(updated)
  return updated
}

async function invalidateUpstreamApiKeyOnce(
  id: number,
  message: string | null
): Promise<Account | undefined> {
  const account = await getAccount(id)
  if (!account) return undefined
  const updated = await updateAccount(id, {
    upstream_api_key: null,
    status: account.disabled_reason === 'manual' ? 'disabled' : 'error',
    disabled_reason: account.disabled_reason === 'manual' ? 'manual' : null,
    last_error: message || 'The cached upstream API key was rejected and has been cleared.'
  })
  if (updated) await updateAccountPollSchedule(updated)
  return updated
}

export function invalidateUpstreamApiKey(id: number, message: string | null) {
  return runAccountOperation(id, () => invalidateUpstreamApiKeyOnce(id, message))
}

export function checkAccountRiskControl(id: number): Promise<RiskControlCheckResult> {
  return runAccountOperation(id, async () => {
    const account = await ensureAccountIpAssignment(id)
    if (!account) {
      throw createError({ statusCode: 404, statusMessage: 'Account not found' })
    }
    if (!account.upstream_api_key) {
      throw createError({ statusCode: 409, statusMessage: 'Account does not have an upstream API key' })
    }

    const fetchImpl = await createAccountFetch(account)
    const response = await fetchImpl('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${account.upstream_api_key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: RISK_CONTROL_CHECK_MODEL,
        messages: [{ role: 'user', content: 'Reply OK' }],
        max_tokens: 1,
        stream: false
      }),
      signal: AbortSignal.timeout(60_000)
    })
    const inspection = await inspectRiskControlResponse(response)
    await response.body?.cancel().catch(() => {})
    const checkedAt = new Date().toISOString()

    let updated: Account
    if (inspection.blocked) {
      updated = (await markAccountRiskControlled(id, inspection.message))!
    } else if (response.status === 401 || response.status === 403) {
      updated = (await invalidateUpstreamApiKeyOnce(
        id,
        `Upstream API key rejected (status ${response.status}); cached key cleared.`
      ))!
    } else if (response.ok && account.disabled_reason === RISK_CONTROL_DISABLED_REASON) {
      updated = (await updateAccount(id, {
        status: 'active',
        disabled_reason: null,
        auto_enable_at: null,
        risk_control_checked_at: checkedAt,
        last_error: null
      }))!
      await updateAccountPollSchedule(updated)
    } else {
      updated = (await updateAccount(id, { risk_control_checked_at: checkedAt }))!
      await updateAccountPollSchedule(updated)
    }

    return {
      account: updated,
      blocked: inspection.blocked,
      upstreamStatus: response.status,
      errorType: inspection.errorType,
      message: inspection.message
    }
  })
}

export function checkAccountRiskControlsByIds(ids: number[]) {
  return mapConcurrent(ids, REFRESH_CONCURRENCY, checkAccountRiskControl)
}

export async function checkAllAccountRiskControls() {
  const accounts = (await listAccounts()).filter(account =>
    Boolean(account.upstream_api_key) &&
    account.disabled_reason !== 'manual' &&
    (account.status === 'active' || account.disabled_reason === RISK_CONTROL_DISABLED_REASON)
  )
  return mapConcurrent(accounts, REFRESH_CONCURRENCY, account => checkAccountRiskControl(account.id))
}

export async function refreshDueAccounts(now = new Date()) {
  const settings = await getAccountRefreshSettings()
  const nowMs = now.getTime()
  const ids = (await listAccounts()).filter(account => {
    if (account.disabled_reason === 'manual' || account.disabled_reason === 'auth_expired') return false
    const quotaDue = [account.next_quota_refresh_at, account.auto_enable_at].some(value => {
      if (!value) return false
      const timestamp = new Date(value).getTime()
      return Number.isFinite(timestamp) && timestamp <= nowMs
    })
    if (quotaDue) return true
    if (!settings.auto_refresh_errors || account.status !== 'error') return false
    const lastSynced = account.last_synced_at ? new Date(account.last_synced_at).getTime() : 0
    return !Number.isFinite(lastSynced) || lastSynced + ERROR_REFRESH_INTERVAL_MS <= nowMs
  }).map(account => account.id)
  return refreshScheduledAccounts([...new Set(ids)])
}

function expandAccountWorkspaces(id: number): Promise<Account[]> {
  return runAccountOperation(id, () => expandAccountWorkspacesOnce(id))
}

export async function refreshDueMembershipAccounts(now = new Date()) {
  const nowMs = now.getTime()
  const ids = (await listAccounts()).filter(account => {
    if (
      account.status === 'error' ||
      account.disabled_reason === 'manual' ||
      account.disabled_reason === 'auth_expired'
    ) return false
    const lastSynced = account.last_synced_at ? new Date(account.last_synced_at).getTime() : 0
    return !Number.isFinite(lastSynced) || lastSynced + 15 * 60 * 1000 <= nowMs
  }).map(account => account.id)
  return refreshScheduledAccounts(ids, { skipErrors: true })
}

async function refreshScheduledAccounts(
  ids: number[],
  options: { skipErrors?: boolean } = {}
) {
  const checked = await mapConcurrent(ids, REFRESH_CONCURRENCY, async id => {
    const account = await getAccount(id)
    if (!account) {
      accountPollSchedule.remove(id)
      return null
    }
    if (account.disabled_reason === 'manual') {
      accountPollSchedule.schedule(account)
      return null
    }
    if (account.disabled_reason === 'auth_expired') {
      accountPollSchedule.schedule(account)
      return null
    }
    if (
      options.skipErrors &&
      (account.status === 'error' || account.disabled_reason === 'auth_expired')
    ) {
      // Error retries are controlled exclusively by auto_refresh_errors.
      accountPollSchedule.schedule(account)
      return null
    }
    return id
  })
  const existingIds = checked.filter((id): id is number => id !== null)
  return mapConcurrent(existingIds, REFRESH_CONCURRENCY, id => refreshAccount(id))
}

export function useAccountReferralReward(id: number, referralId: string) {
  return runAccountOperation(id, () => useAccountReferralRewardOnce(id, referralId))
}

async function useAccountReferralRewardOnce(id: number, referralId: string) {
  const account = await ensureAccountIpAssignment(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'Account not found' })
  }
  const fetchImpl = await createAccountFetch(account)

  const cached = await hydrateCachedReferralRewards(id)
  if (!cached) {
    throw createError({ statusCode: 409, statusMessage: 'Referral reward cache is unavailable' })
  }
  const selected = selectCachedReferralReward(id, referralId)
  if (!selected) {
    throw createError({ statusCode: 409, statusMessage: 'Selected referral reward is no longer available' })
  }
  if (!selected.workspaceId || !selected.applyServerId) {
    throw createError({ statusCode: 502, statusMessage: 'Referral reward action could not be resolved' })
  }

  await applyOpenCodeReferralReward(
    account.auth_cookie,
    selected.workspaceId,
    selected.rewardId,
    selected.applyServerId,
    fetchImpl
  )
  consumeCachedReferralReward(id, selected.rewardId)
  await updateAccount(id, {
    last_referral_reward_id: selected.rewardId,
    last_referral_reward_applied_at: new Date().toISOString(),
    last_error: null
  })

  let refreshed = true
  let refreshedAccount: Account
  try {
    refreshedAccount = await refreshAccountOnce(id, {
      skipReferralRewards: true,
      throwOnError: true
    })
  } catch {
    refreshed = false
    refreshedAccount = (await getAccount(id))!
  }
  await updateAccountPollSchedule(refreshedAccount)
  return {
    account: refreshedAccount,
    rewardId: selected.rewardId,
    rewardIds: getCachedReferralRewards(id)?.rewardIds ?? [],
    usedRewardIds: getCachedReferralRewards(id)?.usedRewardIds ?? [],
    refreshed
  }
}

export function cancelAccountRenewal(id: number) {
  return runAccountOperation(id, () => cancelAccountRenewalOnce(id))
}

async function cancelAccountRenewalOnce(id: number) {
  const account = await ensureAccountIpAssignment(id)
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'Account not found' })
  }
  const fetchImpl = await createAccountFetch(account)

  const info = await fetchOpenCodeAccount(account.auth_cookie, account.workspace_id, fetchImpl)
  if (info.subscriptionStatus !== 'active') {
    throw createError({ statusCode: 409, statusMessage: 'Account does not have an active subscription' })
  }
  if (!info.workspaceId || !info.liteSubscriptionId || !info.billingPortalServerId) {
    throw createError({ statusCode: 502, statusMessage: 'Subscription cancellation action could not be resolved' })
  }

  const cancellation = await cancelOpenCodeSubscriptionRenewal(
    account.auth_cookie,
    info.workspaceId,
    info.liteSubscriptionId,
    info.billingPortalServerId,
    fetchImpl
  )
  const checkedAt = new Date().toISOString()
  await updateAccount(id, {
    cancelled_subscription_id: info.liteSubscriptionId,
    subscription_cancelled_at:
      cancellation.alreadyCancelled && account.subscription_cancelled_at
        ? account.subscription_cancelled_at
        : checkedAt,
    subscription_cancel_checked_at: checkedAt,
    subscription_ends_at: cancellation.currentPeriodEnd,
    subscription_cancel_error: null
  })

  const refreshedAccount = await refreshAccountOnce(id, { skipReferralRewards: true })
  await updateAccountPollSchedule(refreshedAccount)
  return {
    account: refreshedAccount,
    alreadyCancelled: cancellation.alreadyCancelled,
    currentPeriodEnd: cancellation.currentPeriodEnd
  }
}
