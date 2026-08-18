import type { Account, AccountStatus } from './db'
import { accountCredentialResetState, resolveRefreshedAccountEmail } from './account-identity'
import { AccountOperationQueue } from './account-operation-queue'
import { ERROR_REFRESH_INTERVAL_MS } from './account-refresh-policy'
import { getAccountRefreshSettings } from './account-refresh-settings'
import {
  beginAccountRefreshProgress,
  clearAccountRefreshProgress,
  flushAccountRefreshProgress,
  type AccountRefreshProgressReporter
} from './account-refresh-progress'
import { validateAuthCookieValue } from './auth-cookie'
import { AuthCookieExpiredError, buildAuthCookie, type OpenCodeAccountInfo, cancelOpenCodeSubscriptionRenewal, fetchOpenCodeAccount } from './opencode'
import { createAccountFetch } from './account-fetch'
import { ensureAccountIpAssignment } from './ip-pool'
import { toggleChineseModels } from './opencode-chinese-models'
import { logOperation } from './operation-log'
import {
  inspectRiskControlResponse,
  isProtectedAccountDisabledReason,
  resolveRiskControlRestoreState,
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
const accountRetryTimers = new Map<number, ReturnType<typeof setTimeout>>()
const accountOperations = new AccountOperationQueue()
const REFRESH_CONCURRENCY = 4
const RISK_CONTROL_CHECK_MODEL = process.env.RISK_CONTROL_CHECK_MODEL || 'glm-5.2'
const AUTO_APPLY_REFERRAL_REWARDS = process.env.AUTO_APPLY_REFERRAL_REWARDS === 'true'
const AUTO_CANCEL_SUBSCRIPTION_RENEWAL = process.env.AUTO_CANCEL_SUBSCRIPTION_RENEWAL !== 'false'
const AUTO_ENABLE_CHINESE_MODELS = process.env.AUTO_ENABLE_CHINESE_MODELS !== 'false'


function cancelErrorAccountRetry(id: number) {
  const timer = accountRetryTimers.get(id)
  if (!timer) return
  clearTimeout(timer)
  accountRetryTimers.delete(id)
}

function scheduleErrorAccountRetry(id: number) {
  if (accountRetryTimers.has(id)) return
  const timer = setTimeout(async () => {
    accountRetryTimers.delete(id)
    const [account, settings] = await Promise.all([
      getAccount(id).catch(() => undefined),
      getAccountRefreshSettings().catch(() => undefined)
    ])
    if (
      !settings?.auto_refresh_errors ||
      !account ||
      account.status !== 'error' ||
      account.disabled_reason === 'auth_expired' ||
      account.disabled_reason === 'manual'
    ) return
    await refreshAccount(id, { triggerType: 'scheduled' }).catch(() => {})
  }, ERROR_REFRESH_INTERVAL_MS)
  timer.unref?.()
  accountRetryTimers.set(id, timer)
}

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

export async function updateAccountPollSchedule(_account: Account) {
  // Automatic refreshes are driven by persisted timestamps, scheduled tasks,
  // and the short in-process error retry timer. Keep this compatibility hook
  // so account operations do not need a second scheduling implementation.
}

export async function removeAccountPollSchedule(id: number) {
  cancelErrorAccountRetry(id)
  removeCachedReferralRewards(id)
  clearAccountRefreshProgress(id)
}

export async function rebuildAccountPollSchedule() {
  const accounts = await listAccounts()
  retainCachedReferralRewardAccounts(accounts.map(account => account.id))
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
    is_abandoned?: boolean
  }
) {
  return runAccountOperation(id, async () => {
    const account = await getAccount(id)
    if (!account) {
      throw createError({ statusCode: 404, statusMessage: 'Account not found' })
    }
    if (body.is_abandoned === false && account.disabled_reason === RISK_CONTROL_DISABLED_REASON) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Accounts abandoned after an upstream 401 cannot be restored'
      })
    }
    const nextAuthCookie = body.auth_cookie === undefined
      ? undefined
      : validateAuthCookieValue(body.auth_cookie)
    const credentialChanged = nextAuthCookie !== undefined && nextAuthCookie !== account.auth_cookie

    const updated = (await updateAccount(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(nextAuthCookie !== undefined ? { auth_cookie: nextAuthCookie } : {}),
      ...(credentialChanged ? accountCredentialResetState(account) : {}),
      ...(body.status !== undefined
        ? body.status === 'disabled'
          ? { status: body.status, disabled_reason: 'manual', auto_enable_at: null }
          : { status: body.status, disabled_reason: null, auto_enable_at: null }
        : {}),
      // 手动标记/恢复都是用户显式意图：abandoned_reason 固定为 'manual'，
      // 自动标记逻辑（refreshAccountOnce / markAccountRiskControlled 等）均以
      // `!== 'manual'` 为守卫，因此手动恢复后不会被下次刷新或启动回填再次标记。
      ...(body.is_abandoned !== undefined
        ? { is_abandoned: body.is_abandoned, abandoned_reason: 'manual' }
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

export function enableAccountChineseModels(id: number): Promise<Account> {
  return runAccountOperation(id, async () => {
    const account = await ensureAccountIpAssignment(id)
    if (!account) throw createError({ statusCode: 404, statusMessage: 'Account not found' })

    const start = Date.now()
    try {
      const workspaceId = account.workspace_id
      if (!workspaceId) throw new Error('无法获取账号的 workspace ID，请先刷新账号')

      const fetchImpl = await createAccountFetch(account)
      await toggleChineseModels(account.auth_cookie, workspaceId, true, fetchImpl)
      const checkedAt = new Date().toISOString()
      const updated = (await updateAccount(id, {
        chinese_models_enabled_at: checkedAt,
        chinese_models_enable_error: null,
        chinese_models_checked_at: checkedAt,
        chinese_models_manual_off_at: null
      }))!
      void logOperation({
        operation: 'enable_chinese_models',
        trigger_type: 'api',
        account_id: id,
        status: 'success',
        detail: `账号 #${id} 中国模型已开启`,
        duration_ms: Date.now() - start
      })
      return updated
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateAccount(id, {
        chinese_models_enable_error: message,
        chinese_models_checked_at: new Date().toISOString()
      }).catch(() => {})
      void logOperation({
        operation: 'enable_chinese_models',
        trigger_type: 'api',
        account_id: id,
        status: 'error',
        error_message: message,
        duration_ms: Date.now() - start
      })
      throw createError({ statusCode: 502, statusMessage: message })
    }
  })
}

export function toggleAccountChineseModels(id: number, enable: boolean): Promise<Account> {
  return runAccountOperation(id, async () => {
    const account = await ensureAccountIpAssignment(id)
    if (!account) throw createError({ statusCode: 404, statusMessage: 'Account not found' })

    const now = new Date().toISOString()
    const startedAt = Date.now()
    const operation = enable ? 'enable_chinese_models' : 'disable_chinese_models'
    try {
      const workspaceId = account.workspace_id
      if (!workspaceId) throw new Error('无法获取账号的 workspace ID，请先刷新账号')

      const fetchImpl = await createAccountFetch(account)
      await toggleChineseModels(account.auth_cookie, workspaceId, enable, fetchImpl)
      const updated = (await updateAccount(id, {
        chinese_models_enabled_at: enable ? now : null,
        chinese_models_enable_error: null,
        chinese_models_checked_at: now,
        chinese_models_manual_off_at: enable ? null : now
      }))!
      void logOperation({
        operation,
        trigger_type: 'api',
        account_id: id,
        status: 'success',
        detail: `账号 #${id} 中国模型已${enable ? '开启' : '关闭'}`,
        duration_ms: Date.now() - startedAt
      })
      return updated
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateAccount(id, {
        chinese_models_enable_error: message,
        chinese_models_checked_at: now,
        ...(enable ? { chinese_models_manual_off_at: null } : {})
      }).catch(() => {})
      void logOperation({
        operation,
        trigger_type: 'api',
        account_id: id,
        status: 'error',
        error_message: message,
        duration_ms: Date.now() - startedAt
      })
      throw createError({ statusCode: 502, statusMessage: message })
    }
  })
}

export interface ChineseModelsStatusSyncResult {
  account: Account
  synchronized: boolean
  message: string | null
}

export function syncAccountChineseModelsStatus(id: number): Promise<ChineseModelsStatusSyncResult> {
  return runAccountOperation(id, async () => {
    const account = await ensureAccountIpAssignment(id)
    if (!account) throw createError({ statusCode: 404, statusMessage: 'Account not found' })
    const checkedAt = new Date().toISOString()
    try {
      const fetchImpl = await createAccountFetch(account)
      const info = await fetchOpenCodeAccount(account.auth_cookie, account.workspace_id, fetchImpl)
      if (info.chineseModelsEnabled === null) {
        const message = '无法从 workspace 页面解析中国模型状态'
        const updated = (await updateAccount(id, {
          chinese_models_checked_at: checkedAt,
          chinese_models_enable_error: message
        }))!
        return { account: updated, synchronized: false, message }
      }
      const updated = (await updateAccount(id, {
        chinese_models_enabled_at: info.chineseModelsEnabled
          ? account.chinese_models_enabled_at || checkedAt
          : null,
        chinese_models_checked_at: checkedAt,
        chinese_models_enable_error: null
      }))!
      return { account: updated, synchronized: true, message: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const updated = (await updateAccount(id, {
        chinese_models_checked_at: checkedAt,
        chinese_models_enable_error: message
      }).catch(() => account)) || account
      return { account: updated, synchronized: false, message }
    }
  })
}

export function syncAccountChineseModelsStatusesByIds(ids: number[]) {
  return mapConcurrent(ids, REFRESH_CONCURRENCY, syncAccountChineseModelsStatus)
}
function autoEnableChineseModelsForAccount(account: Account) {
  // 仅在满足全部守卫条件时自动开启：会员订阅、有 workspace、尚未开启、
  // 未被用户手动关闭过；并按 chinese_models_checked_at 节流（1 小时内不重复、
  // 上次失败则重试）。
  if (
    !AUTO_ENABLE_CHINESE_MODELS ||
    account.subscription_status !== 'active' ||
    !account.workspace_id ||
    account.chinese_models_enabled_at ||
    account.chinese_models_manual_off_at
  ) return
  const checkedAt = account.chinese_models_checked_at
    ? new Date(account.chinese_models_checked_at).getTime()
    : 0
  const needsCheck =
    !account.chinese_models_checked_at ||
    Boolean(account.chinese_models_enable_error) ||
    !Number.isFinite(checkedAt) ||
    Date.now() - checkedAt >= 60 * 60 * 1000
  if (!needsCheck) return
  // fire-and-forget：刷新结果不受影响，失败时 enableAccountChineseModels 已
  // 写入错误与检查时间，下次刷新或定时轮询会自动重试。
  void (async () => {
    try {
      await enableAccountChineseModels(account.id)
    } catch {
      // 忽略：错误已写入 chinese_models_enable_error
    }
  })()
}

export async function expandAccountWorkspacesByIds(ids: number[]) {
  const expanded = await mapConcurrent(ids, REFRESH_CONCURRENCY, expandAccountWorkspaces)
  await ensureStableIpAssignments()
  const accounts = await mapConcurrent(
    expanded.flat(),
    REFRESH_CONCURRENCY,
    async account => (await getAccount(account.id)) || account
  )
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
  triggerType?: 'manual' | 'api' | 'scheduled'
}

function cacheReferralRewards(accountId: number, info: OpenCodeAccountInfo) {
  cacheAvailableReferralRewards(accountId, {
    rewardIds: info.availableReferralRewardIds,
    usedRewardIds: info.usedReferralRewardIds,
    workspaceId: info.workspaceId,
    applyServerId: info.referralApplyServerId
  })
}

export function refreshAccount(
  id: number,
  options: Pick<RefreshAccountOptions, 'triggerType'> = {}
): Promise<Account> {
  const pending = accountRefreshes.get(id)
  if (pending) return pending

  const progress = beginAccountRefreshProgress(id)
  const refresh = runAccountOperation(id, () => refreshAccountOnce(id, {
    progress,
    triggerType: options.triggerType || 'api'
  }))
    .then(async account => {
      if (account.status === 'error') {
        progress.fail(account.last_error || '账号刷新失败')
        const settings = await getAccountRefreshSettings()
        if (settings.auto_refresh_errors && account.disabled_reason !== 'auth_expired' && account.disabled_reason !== 'manual') {
          scheduleErrorAccountRetry(id)
        }
      } else {
        cancelErrorAccountRetry(id)
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
      info.liteSubscriptionId &&
      account.cancelled_subscription_id &&
      account.cancelled_subscription_id !== info.liteSubscriptionId
    ) {
      Object.assign(subscriptionUpdate, {
        cancelled_subscription_id: null,
        subscription_cancelled_at: null,
        subscription_cancel_checked_at: null,
        subscription_ends_at: null,
        subscription_cancel_error: null
      })
    }
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
    // 抛弃账号标记：风控命中或月限额≥100% 自动标记；手动标记过的永不被动改。
    // 用最新抓取的 monthlyUsage 判定；若本次抓取缺失（null），沿用已入库的旧值，
    // 避免一次抓取抖动就误把抛弃账号临时解除回主列表。
    const monthlyExhausted = typeof info.monthlyUsage === 'number'
      ? info.monthlyUsage >= 100
      : typeof currentAccount.monthly_usage === 'number' && currentAccount.monthly_usage >= 100
    const autoAbandoned = disabledReason === 'risk_control' || monthlyExhausted
    const saved = (await updateAccount(id, {
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
      ...(info.chineseModelsEnabled !== null && info.chineseModelsEnabled !== undefined
        ? {
            chinese_models_enabled_at: info.chineseModelsEnabled
              ? currentAccount.chinese_models_enabled_at || now.toISOString()
              : null,
            chinese_models_checked_at: now.toISOString(),
            chinese_models_enable_error: null
          }
        : {}),
      status,
      disabled_reason: disabledReason,
      auto_enable_at: disabledReason?.startsWith('quota:') ? quota.autoEnableAt : null,
      ...(currentAccount.abandoned_reason !== 'manual' ? {
        is_abandoned: autoAbandoned,
        abandoned_reason: autoAbandoned ? (disabledReason === 'risk_control' ? 'risk_control' : 'monthly_limit') : null
      } : {}),
      last_error: protectedDisabledReason === RISK_CONTROL_DISABLED_REASON
        ? currentAccount.last_error
        : referralError,
      last_synced_at: now.toISOString()
    }))!
    void logOperation({
      operation: 'refresh_account',
      trigger_type: options.triggerType || 'api',
      account_id: id,
      status: 'success',
      detail: `账号 #${id} 刷新成功，状态：${status}`
    })
    // 刷新成功后，若为会员则后台自动开启中国模型（fire-and-forget，受节流约束）。
    if (saved.subscription_status === 'active') {
      autoEnableChineseModelsForAccount(saved)
    }
    return saved
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
      console.error('Failed to update account error state:', updateError)
      throw err
    }
    void logOperation({
      operation: 'refresh_account',
      trigger_type: options.triggerType || 'api',
      account_id: id,
      status: 'error',
      error_message: message
    })
    if (options.throwOnError) throw err
    return failedAccount
  }
}

export async function refreshAllAccounts() {
  const accounts = (await listAccounts()).filter(a => a.disabled_reason !== 'manual' && !a.is_abandoned)
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
    upstream_api_key: null,
    status: 'disabled',
    disabled_reason: RISK_CONTROL_DISABLED_REASON,
    auto_enable_at: null,
    risk_control_checked_at: now,
    risk_control_detected_at: account.disabled_reason === RISK_CONTROL_DISABLED_REASON
      ? account.risk_control_detected_at || now
      : now,
    last_error: message || 'Upstream account returned 401 and was abandoned.',
    is_abandoned: true,
    abandoned_reason: 'risk_control'
  }))!
  await updateAccountPollSchedule(updated)
  return updated
}

async function invalidateUpstreamApiKeyOnce(
  id: number,
  message: string | null,
  riskControlCheckedAt?: string
): Promise<Account | undefined> {
  const account = await getAccount(id)
  if (!account) return undefined
  const updated = await updateAccount(id, {
    upstream_api_key: null,
    status: account.disabled_reason === 'manual' ? 'disabled' : 'error',
    disabled_reason: account.disabled_reason === 'manual' ? 'manual' : null,
    last_error: message || 'The cached upstream API key was rejected and has been cleared.',
    ...(riskControlCheckedAt ? { risk_control_checked_at: riskControlCheckedAt } : {})
  })
  if (updated) await updateAccountPollSchedule(updated)
  return updated
}

export function invalidateUpstreamApiKey(id: number, message: string | null) {
  return runAccountOperation(id, () => invalidateUpstreamApiKeyOnce(id, message))
}

export function checkAccountRiskControl(id: number): Promise<RiskControlCheckResult> {
  return runAccountOperation(id, async () => {
    const startedAt = Date.now()
    try {
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
        const blockMessage = response.status === 401
          ? `Upstream account returned 401 and was abandoned.${inspection.message ? ` Provider message: ${inspection.message}` : ''}`
          : inspection.message
        updated = (await markAccountRiskControlled(id, blockMessage))!
      } else if (response.status === 403) {
        updated = (await invalidateUpstreamApiKeyOnce(
          id,
          `Upstream API key rejected (status ${response.status}); cached key cleared.`,
          checkedAt
        ))!
      } else if (response.ok && account.disabled_reason === RISK_CONTROL_DISABLED_REASON) {
        const restored = resolveRiskControlRestoreState(account)
        updated = (await updateAccount(id, {
          status: restored.status,
          disabled_reason: restored.disabledReason,
          auto_enable_at: restored.autoEnableAt,
          risk_control_checked_at: checkedAt,
          last_error: null,
          ...(account.abandoned_reason !== 'manual' ? {
            is_abandoned: restored.monthlyExhausted,
            abandoned_reason: restored.monthlyExhausted ? 'monthly_limit' : null
          } : {})
        }))!
        await updateAccountPollSchedule(updated)
      } else {
        updated = (await updateAccount(id, { risk_control_checked_at: checkedAt }))!
        await updateAccountPollSchedule(updated)
      }

      const result = {
        account: updated,
        blocked: inspection.blocked,
        upstreamStatus: response.status,
        errorType: inspection.errorType,
        message: inspection.message
      }
      void logOperation({
        operation: 'risk_control_check',
        trigger_type: 'api',
        account_id: id,
        status: 'success',
        detail: inspection.blocked
          ? `账号 #${id} 命中风控`
          : `账号 #${id} 风控检测完成，上游状态 ${response.status}`,
        duration_ms: Date.now() - startedAt
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logOperation({
        operation: 'risk_control_check',
        trigger_type: 'api',
        account_id: id,
        status: 'error',
        error_message: message,
        duration_ms: Date.now() - startedAt
      })
      throw error
    }
  })
}

export function checkAccountRiskControlsByIds(ids: number[]) {
  return mapConcurrent(ids, REFRESH_CONCURRENCY, async id => {
    try {
      return await checkAccountRiskControl(id)
    } catch (error) {
      const account = await getAccount(id)
      if (!account) throw error
      return {
        account,
        blocked: false,
        upstreamStatus: 0,
        errorType: 'check_failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })
}

export async function checkAllAccountRiskControls() {
  const accounts = (await listAccounts()).filter(account =>
    Boolean(account.upstream_api_key) &&
    account.disabled_reason !== 'manual' &&
    (account.status === 'active' || account.disabled_reason === RISK_CONTROL_DISABLED_REASON)
  )
  return checkAccountRiskControlsByIds(accounts.map(account => account.id))
}
export async function refreshDueErrorAccounts(now = new Date()) {
  const settings = await getAccountRefreshSettings()
  if (!settings.auto_refresh_errors) return []
  const nowMs = now.getTime()
  const ids = (await listAccounts()).filter(account => {
    if (account.status !== 'error') return false
    if (account.disabled_reason === 'manual' || account.disabled_reason === 'auth_expired') return false
    const lastSynced = account.last_synced_at ? new Date(account.last_synced_at).getTime() : 0
    return !Number.isFinite(lastSynced) || lastSynced + ERROR_REFRESH_INTERVAL_MS <= nowMs
  }).map(account => account.id)
  return refreshScheduledAccounts([...new Set(ids)])
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
    const lastSynced = account.last_synced_at ? new Date(account.last_synced_at).getTime() : null
    return lastSynced === null || lastSynced + 15 * 60 * 1000 <= nowMs
  }).map(account => account.id)
  return refreshScheduledAccounts(ids, { skipErrors: true })
}

async function refreshScheduledAccounts(
  ids: number[],
  options: { skipErrors?: boolean } = {}
) {
  const checked = await mapConcurrent(ids, REFRESH_CONCURRENCY, async id => {
    const account = await getAccount(id)
    if (!account) return null
    if (account.disabled_reason === 'manual') return null
    if (account.disabled_reason === 'auth_expired') return null
    if (
      options.skipErrors &&
      (account.status === 'error' || account.disabled_reason === 'auth_expired')
    ) {
      // Error retries are controlled exclusively by auto_refresh_errors.
      return null
    }
    return id
  })
  const existingIds = checked.filter((id): id is number => id !== null)
  return mapConcurrent(existingIds, REFRESH_CONCURRENCY, id =>
    refreshAccount(id, { triggerType: 'scheduled' })
  )
}

export function useAccountReferralReward(id: number, referralId: string) {
  return runAccountOperation(id, async () => {
    const startedAt = Date.now()
    try {
      const result = await useAccountReferralRewardOnce(id, referralId)
      void logOperation({
        operation: 'use_referral_reward',
        trigger_type: 'api',
        account_id: id,
        status: 'success',
        detail: `账号 #${id} 已使用推广奖励 ${result.rewardId}`,
        duration_ms: Date.now() - startedAt
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logOperation({
        operation: 'use_referral_reward',
        trigger_type: 'api',
        account_id: id,
        status: 'error',
        error_message: message,
        duration_ms: Date.now() - startedAt
      })
      throw error
    }
  })
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

  try {
    await applyOpenCodeReferralReward(
      account.auth_cookie,
      selected.workspaceId,
      selected.rewardId,
      selected.applyServerId,
      fetchImpl
    )
  } catch (error) {
    const latest = await fetchOpenCodeAccount(
      account.auth_cookie,
      selected.workspaceId,
      fetchImpl
    ).catch(() => null)
    if (latest) {
      cacheReferralRewards(id, latest)
      if (!latest.availableReferralRewardIds.includes(selected.rewardId)) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Selected referral reward is no longer available'
        })
      }
    }
    throw error
  }
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
  const start = Date.now()
  try {
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

    void logOperation({
      operation: 'cancel_renewal',
      trigger_type: 'api',
      account_id: id,
      status: 'success',
      detail: cancellation.alreadyCancelled
        ? `账号 #${id} 续费已取消（之前已取消）`
        : `账号 #${id} 续费取消成功`,
      duration_ms: Date.now() - start
    })

    const refreshedAccount = await refreshAccountOnce(id, {
      skipReferralRewards: true,
      triggerType: 'api'
    })
    await updateAccountPollSchedule(refreshedAccount)
    return {
      account: refreshedAccount,
      alreadyCancelled: cancellation.alreadyCancelled,
      currentPeriodEnd: cancellation.currentPeriodEnd
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateAccount(id, {
      subscription_cancel_checked_at: new Date().toISOString(),
      subscription_cancel_error: message
    }).catch(() => {})
    void logOperation({
      operation: 'cancel_renewal',
      trigger_type: 'api',
      account_id: id,
      status: 'error',
      error_message: message,
      duration_ms: Date.now() - start
    })
    throw error
  }
}
