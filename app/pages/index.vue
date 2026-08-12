<script setup lang="ts">
import type { AccountBatchProgress } from '~/composables/useAccounts'

const { accounts, stats, loading, fetchAccounts, fetchStats, runAccountBatch } = useAccounts()
const toast = useToast()
const refreshing = ref(false)
const refreshProgress = ref<AccountBatchProgress | null>(null)

onMounted(() => {
  void Promise.allSettled([fetchAccounts(), fetchStats()])
})

const cards = computed(() => [
  { label: '可用会员', value: `${stats.value?.available ?? 0} / ${stats.value?.members ?? 0}`, icon: 'i-lucide-users', color: 'primary' as const },
  { label: '可用账号', value: stats.value?.active ?? 0, icon: 'i-lucide-check-circle', color: 'success' as const },
  { label: '异常账号', value: stats.value?.error ?? 0, icon: 'i-lucide-shield-alert', color: 'error' as const },
  { label: '实际可用额度', value: `$${(stats.value?.totalEffectiveRemaining ?? 0).toFixed(2)}`, icon: 'i-lucide-wallet-cards', color: 'info' as const }
])

const recent = computed(() => accounts.value.slice(0, 5))

function accountDisplayLabel(id: number) {
  const account = accounts.value.find(item => item.id === id)
  return account?.name || account?.email || account?.workspace_name || `账号 #${id}`
}

async function onRefreshAll() {
  refreshing.value = true
  try {
    const ids = accounts.value
      .filter(account => account.disabled_reason !== 'manual')
      .map(account => account.id)
    const result = await runAccountBatch(ids, 'refresh', progress => {
      refreshProgress.value = progress
    })
    toast.add({
      title: `已刷新 ${result.succeeded} 个账号`,
      description: result.failed ? `${result.failed} 个账号刷新失败` : undefined,
      color: result.failed ? 'warning' : 'success'
    })
  } catch (e: any) {
    toast.add({ title: e?.data?.statusMessage || '刷新失败', color: 'error' })
  } finally {
    refreshing.value = false
    refreshProgress.value = null
  }
}
</script>

<template>
  <div class="ocm-page space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="ocm-title text-2xl font-semibold">仪表盘</h1>
        <p class="text-sm text-muted">OpenCode 号池概览</p>
      </div>
      <div class="flex gap-2">
        <UButton to="/accounts" icon="i-lucide-plus" color="primary">
          管理号池
        </UButton>
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="outline"
          :loading="refreshing || loading"
          @click="onRefreshAll"
        >
          全部刷新
        </UButton>
      </div>
    </div>

    <div
      v-if="refreshProgress"
      class="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3"
      aria-live="polite"
    >
      <div class="mb-2 flex items-center justify-between gap-3 text-sm">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
          <span class="font-medium text-highlighted">全部刷新</span>
        </div>
        <span class="text-muted">
          {{ refreshProgress.completed }} / {{ refreshProgress.total }}
          <template v-if="refreshProgress.failed"> · 失败 {{ refreshProgress.failed }}</template>
        </span>
      </div>
      <UProgress
        :model-value="refreshProgress.completed"
        :max="Math.max(refreshProgress.total, 1)"
        color="primary"
        size="sm"
      />
      <div v-if="refreshProgress.active.length" class="mt-3 grid gap-2 md:grid-cols-2">
        <div
          v-for="progress in refreshProgress.active"
          :key="progress.accountId"
          class="rounded-md border border-default bg-default/70 px-3 py-2"
        >
          <div class="mb-1.5 flex items-center justify-between gap-3 text-xs">
            <span class="min-w-0 truncate font-medium text-highlighted">
              {{ accountDisplayLabel(progress.accountId) }}
            </span>
            <span class="shrink-0 text-muted">{{ progress.percent }}%</span>
          </div>
          <UProgress :model-value="progress.percent" :max="100" color="primary" size="xs" />
          <p class="mt-1.5 truncate text-xs text-muted" :title="progress.label">
            {{ progress.label }}
          </p>
        </div>
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <UCard v-for="card in cards" :key="card.label" class="ocm-card ocm-metric-card">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-sm text-muted">{{ card.label }}</p>
            <p class="mt-2 text-3xl font-semibold text-highlighted">{{ card.value }}</p>
          </div>
          <div class="ocm-metric-icon p-2">
            <UIcon :name="card.icon" class="size-5" :class="`text-${card.color}`" />
          </div>
        </div>
      </UCard>
    </div>

    <div class="grid gap-4 lg:grid-cols-3">
      <UCard class="ocm-card lg:col-span-2">
        <template #header>
          <div class="flex items-center justify-between">
            <h2 class="font-medium text-highlighted">最近账号</h2>
            <UButton to="/accounts" variant="link" color="primary" trailing-icon="i-lucide-arrow-right">
              查看全部
            </UButton>
          </div>
        </template>

        <div v-if="!recent.length" class="py-10 text-center text-muted">
          暂无账号，先去添加 Cookie
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="account in recent"
            :key="account.id"
            class="ocm-list-row flex items-center justify-between rounded-lg border border-default p-3"
          >
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <p class="truncate font-medium text-highlighted">
                  {{ account.name || account.email || `账号 #${account.id}` }}
                </p>
                <UBadge
                  :key="`${account.id}-${account.status}`"
                  :color="statusColor(account.status)"
                  variant="subtle"
                  size="sm"
                >
                  {{ statusLabel(account.status) }}
                </UBadge>
              </div>
              <p class="mt-1 truncate text-sm text-muted">
                {{ account.email || '未同步邮箱' }}
                <span v-if="account.workspace_id"> · {{ account.workspace_id }}</span>
              </p>
            </div>
            <div class="text-right text-sm">
              <p class="text-highlighted">滚动 {{ formatPercent(account.rolling_usage) }}</p>
              <p class="text-muted">重置 {{ formatReset(account.rolling_reset_sec) }}</p>
            </div>
          </div>
        </div>
      </UCard>

      <UCard class="ocm-card">
        <template #header>
          <h2 class="font-medium text-highlighted">用量统计</h2>
        </template>
        <div class="space-y-4">
          <div>
            <div class="mb-1 flex justify-between text-sm">
              <span class="text-muted">剩余 5h 限额</span>
              <span>{{ stats?.avgRollingRemaining ?? 0 }}%</span>
            </div>
            <UProgress :model-value="stats?.avgRollingRemaining ?? 0" />
            <p class="mt-1 text-xs text-muted">剩余 ${{ stats?.rollingRemainingAmount?.toFixed?.(2) ?? '0.00' }} / ${{ stats?.rollingLimitAmount?.toFixed?.(2) ?? '0.00' }}</p>
          </div>
          <div>
            <div class="mb-1 flex justify-between text-sm">
              <span class="text-muted">剩余周限额</span>
              <span>{{ stats?.avgWeeklyRemaining ?? 0 }}%</span>
            </div>
            <UProgress :model-value="stats?.avgWeeklyRemaining ?? 0" color="info" />
            <p class="mt-1 text-xs text-muted">剩余 ${{ stats?.weeklyRemainingAmount?.toFixed?.(2) ?? '0.00' }} / ${{ stats?.weeklyLimitAmount?.toFixed?.(2) ?? '0.00' }}</p>
          </div>
          <div>
            <div class="mb-1 flex justify-between text-sm">
              <span class="text-muted">剩余月配额</span>
              <span>{{ stats?.avgMonthlyRemaining ?? 0 }}%</span>
            </div>
            <UProgress :model-value="stats?.avgMonthlyRemaining ?? 0" color="warning" />
            <p class="mt-1 text-xs text-muted">剩余 ${{ stats?.monthlyRemainingAmount?.toFixed?.(2) ?? '0.00' }} / ${{ stats?.monthlyLimitAmount?.toFixed?.(2) ?? '0.00' }}</p>
          </div>
          <USeparator />
          <div class="flex items-center justify-between text-sm">
            <span class="text-muted">实际可用总额度</span>
            <UTooltip text="每账号取 5h/周/月 三窗口剩余的最小值后求和">
              <span class="cursor-help font-medium text-highlighted underline decoration-dashed">${{ stats?.totalEffectiveRemaining?.toFixed?.(2) ?? '0.00' }}</span>
            </UTooltip>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-muted">可用账号余额</span>
            <span class="font-medium text-highlighted">${{ stats?.totalBalance?.toFixed?.(2) ?? '0.00' }}</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-muted">已禁用账号</span>
            <span>{{ stats?.disabled ?? 0 }}</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-muted">非会员账号</span>
            <span>{{ stats?.nonMembers ?? 0 }}</span>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
