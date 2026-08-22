<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { OperationLog, OperationLogSummary } from '~~/server/utils/operation-log'

const toast = useToast()
const loading = ref(false)
const logs = ref<OperationLogSummary[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 50

const operationFilter = ref('')

const operationItems = [
  { label: '全部操作', value: '' },
  { label: '添加账号', value: 'add_account' },
  { label: '刷新账号', value: 'refresh_account' },
  { label: '开启中国模型', value: 'enable_chinese_models' },
  { label: '关闭中国模型', value: 'disable_chinese_models' },
  { label: '取消自动续费', value: 'cancel_renewal' },
  { label: '使用推广额度', value: 'use_referral_reward' },
  { label: '风控检测', value: 'risk_control_check' },
]

const operationLabelMap: Record<string, string> = {
  add_account: '添加账号',
  refresh_account: '刷新账号',
  enable_chinese_models: '开启中国模型',
  disable_chinese_models: '关闭中国模型',
  cancel_renewal: '取消自动续费',
  use_referral_reward: '使用推广额度',
  risk_control_check: '风控检测',
}

const triggerLabelMap: Record<string, string> = {
  manual: '手动',
  api: 'API',
  scheduled: '定时',
}

const columns: TableColumn<OperationLogSummary>[] = [
  { accessorKey: 'created_at', header: '时间' },
  { accessorKey: 'operation', header: '操作' },
  { accessorKey: 'trigger_type', header: '触发方式' },
  { accessorKey: 'account_id', header: '账号' },
  { accessorKey: 'status', header: '状态' },
  { id: 'detail_col', header: '详情' },
  { accessorKey: 'duration_ms', header: '耗时' },
]

let requestController: AbortController | null = null
let requestGeneration = 0

async function fetchLogs() {
  const generation = ++requestGeneration
  requestController?.abort()
  requestController = new AbortController()
  loading.value = true
  try {
    const query: Record<string, string | number> = {
      limit: pageSize,
      offset: (page.value - 1) * pageSize
    }
    if (operationFilter.value) query.operation = operationFilter.value
    const response = await $fetch<{ logs: OperationLogSummary[]; total: number }>('/api/logs', {
      query,
      signal: requestController.signal
    })
    if (generation === requestGeneration) {
      logs.value = response.logs
      total.value = response.total
    }
  } catch (error: any) {
    if (error?.name !== 'AbortError') {
      toast.add({
        title: error?.data?.statusMessage || '获取操作日志失败',
        description: error?.message,
        color: 'error'
      })
    }
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

function runSearch() {
  if (page.value !== 1) page.value = 1
  else void fetchLogs()
}

function resetFilters() {
  operationFilter.value = ''
  runSearch()
}

function formatTimestamp(ts: string) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function getStatusColor(status: string): 'success' | 'error' | 'warning' | 'neutral' {
  if (status === 'success') return 'success'
  if (status === 'error') return 'error'
  if (status === 'partial') return 'warning'
  return 'neutral'
}

function getStatusLabel(status: string) {
  if (status === 'success') return '成功'
  if (status === 'error') return '失败'
  if (status === 'partial') return '部分成功'
  return status
}

function formatLogPayload(value: string | null) {
  if (!value) return '-'
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function logSummary(log: OperationLogSummary) {
  return log.error_message || log.detail || (log.status === 'success' ? '操作成功，点击查看完整响应' : '点击查看完整日志')
}

const selectedLog = ref<OperationLog | null>(null)
const detailDialogOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
let detailController: AbortController | null = null
let detailGeneration = 0

async function showDetail(log: OperationLogSummary) {
  const generation = ++detailGeneration
  detailController?.abort()
  detailController = new AbortController()
  selectedLog.value = { ...log, request_detail: null, response_detail: null }
  detailDialogOpen.value = true
  detailLoading.value = true
  detailError.value = null
  try {
    const detail = await $fetch<OperationLog>(`/api/logs/${log.id}`, {
      signal: detailController.signal
    })
    if (generation === detailGeneration) selectedLog.value = detail
  } catch (error: any) {
    if (error?.name !== 'AbortError' && generation === detailGeneration) {
      const message = error?.data?.statusMessage || error?.message || '获取操作详情失败'
      detailError.value = message
      toast.add({
        title: '获取操作详情失败',
        description: message,
        color: 'error'
      })
    }
  } finally {
    if (generation === detailGeneration) detailLoading.value = false
  }
}

onMounted(fetchLogs)
onBeforeUnmount(() => {
  requestController?.abort()
  detailController?.abort()
})
watch(page, fetchLogs)
</script>

<template>
  <div class="ocm-page space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="ocm-title text-2xl font-semibold">操作日志</h1>
        <p class="text-sm text-muted">记录账号的关键操作及其结果</p>
      </div>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="outline" :loading="loading" @click="fetchLogs">
        刷新
      </UButton>
    </div>

    <UCard class="ocm-card">
      <template #header>
        <div class="flex flex-wrap items-end gap-3">
          <UFormField label="操作类型">
            <USelect v-model="operationFilter" :items="operationItems" class="w-48" />
          </UFormField>
          <div class="flex gap-2">
            <UButton icon="i-lucide-search" @click="runSearch">搜索</UButton>
            <UButton variant="outline" color="neutral" @click="resetFilters">重置</UButton>
          </div>
        </div>
      </template>

      <UTable
        :data="logs"
        :columns="columns"
        :loading="loading"
        :watch-options="{ deep: false }"
        empty="暂无操作日志"
        class="max-h-[64vh] min-w-full"
        sticky="header"
      >
        <template #created_at-cell="{ row }">
          <span class="whitespace-nowrap text-xs">{{ formatTimestamp(row.original.created_at) }}</span>
        </template>
        <template #operation-cell="{ row }">
          <span class="text-sm">{{ operationLabelMap[row.original.operation] || row.original.operation }}</span>
        </template>
        <template #trigger_type-cell="{ row }">
          <UBadge color="neutral" variant="subtle" size="sm">
            {{ triggerLabelMap[row.original.trigger_type] || row.original.trigger_type }}
          </UBadge>
        </template>
        <template #account_id-cell="{ row }">
          <span class="text-sm text-muted">
            {{ row.original.account_id != null ? `#${row.original.account_id}` : '-' }}
          </span>
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="getStatusColor(row.original.status)" variant="subtle" size="sm">
            {{ getStatusLabel(row.original.status) }}
          </UBadge>
        </template>
        <template #detail_col-cell="{ row }">
          <div class="flex items-center gap-2">
            <span class="max-w-56 truncate text-xs text-muted" :title="logSummary(row.original)">
              {{ logSummary(row.original) }}
            </span>
            <UButton
              v-if="row.original.error_message || row.original.detail || row.original.has_request_detail || row.original.has_response_detail"
              icon="i-lucide-file-search"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="showDetail(row.original)"
            >
              查看
            </UButton>
          </div>
        </template>
        <template #duration_ms-cell="{ row }">
          <span class="whitespace-nowrap text-xs text-muted">
            {{ row.original.duration_ms != null ? `${row.original.duration_ms} ms` : '-' }}
          </span>
        </template>
      </UTable>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
        <p class="text-sm text-muted">共 {{ total }} 条记录 · 第 {{ page }} 页</p>
        <UPagination v-model:page="page" :total="total" :items-per-page="pageSize" />
      </div>
    </UCard>

    <UModal v-model:open="detailDialogOpen" title="操作详情">
      <template #body>
        <div v-if="selectedLog" class="space-y-4">
          <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
            <dt class="text-muted">时间</dt>
            <dd>{{ formatTimestamp(selectedLog.created_at) }}</dd>
            <dt class="text-muted">操作</dt>
            <dd>{{ operationLabelMap[selectedLog.operation] || selectedLog.operation }}</dd>
            <dt class="text-muted">触发方式</dt>
            <dd>{{ triggerLabelMap[selectedLog.trigger_type] || selectedLog.trigger_type }}</dd>
            <dt class="text-muted">账号 ID</dt>
            <dd>{{ selectedLog.account_id != null ? `#${selectedLog.account_id}` : '-' }}</dd>
            <dt class="text-muted">状态</dt>
            <dd>
              <UBadge :color="getStatusColor(selectedLog.status)" variant="subtle">
                {{ getStatusLabel(selectedLog.status) }}
              </UBadge>
            </dd>
            <dt class="text-muted">耗时</dt>
            <dd>{{ selectedLog.duration_ms != null ? `${selectedLog.duration_ms} ms` : '-' }}</dd>
          </dl>
          <div v-if="selectedLog.detail">
            <p class="mb-2 text-sm font-medium">详情</p>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-default bg-elevated p-3 text-xs">{{ selectedLog.detail }}</pre>
          </div>
          <div v-if="detailLoading" class="flex items-center gap-2 rounded-lg border border-default p-4 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
            正在按需加载完整请求与响应…
          </div>
          <UAlert v-else-if="detailError" color="error" variant="subtle" icon="i-lucide-circle-alert" title="详情加载失败" :description="detailError" />
          <template v-else>
            <div>
              <p class="mb-2 text-sm font-medium">完整请求</p>
              <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-default bg-elevated p-3 text-xs">{{ formatLogPayload(selectedLog.request_detail) }}</pre>
            </div>
            <div>
              <p class="mb-2 text-sm font-medium">完整响应</p>
              <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-default bg-elevated p-3 text-xs">{{ formatLogPayload(selectedLog.response_detail) }}</pre>
            </div>
          </template>
          <div v-if="selectedLog.error_message">
            <p class="mb-2 text-sm font-medium">错误信息</p>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-error/20 bg-error/5 p-3 text-xs text-error">{{ selectedLog.error_message }}</pre>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
