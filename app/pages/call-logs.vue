<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { CallLog } from '~~/server/utils/call-logs'

const toast = useToast()
const loading = ref(false)
const logs = ref<CallLog[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 50

const filters = ref({
  apiKeyId: '',
  accountId: '',
  modelName: '',
  callerIp: '',
  statusCode: '',
  isStream: '',
  hasError: '',
  startTime: '',
  endTime: ''
})

const columns: TableColumn<CallLog>[] = [
  { accessorKey: 'timestamp', header: '时间' },
  { accessorKey: 'api_key_prefix', header: 'API Key' },
  { accessorKey: 'model_name', header: '模型' },
  { accessorKey: 'account_name', header: '账号' },
  { accessorKey: 'is_stream', header: '类型' },
  { id: 'tokens', header: 'Tokens' },
  { accessorKey: 'throughput', header: '吞吐速度' },
  { id: 'timing', header: '响应时间' },
  { accessorKey: 'caller_ip', header: '调用 IP' },
  { accessorKey: 'status_code', header: '状态' },
  { id: 'actions', header: '详情' }
]

const streamItems = [
  { label: '全部', value: '' },
  { label: '流式', value: 'true' },
  { label: '非流式', value: 'false' }
]
const errorItems = [
  { label: '全部', value: '' },
  { label: '仅错误', value: 'true' },
  { label: '仅正常', value: 'false' }
]

const statusColorMap: Record<number, 'success' | 'warning' | 'error' | 'neutral'> = {
  200: 'success',
  400: 'warning',
  401: 'error',
  403: 'error',
  429: 'warning',
  499: 'neutral',
  500: 'error',
  502: 'error',
  503: 'error',
  504: 'error'
}

let requestController: AbortController | null = null
async function fetchLogs() {
  requestController?.abort()
  requestController = new AbortController()
  loading.value = true
  try {
    const query: Record<string, string | number> = {
      limit: pageSize,
      offset: (page.value - 1) * pageSize
    }
    for (const [key, value] of Object.entries(filters.value)) {
      if (!value) continue
      if (key === 'startTime' || key === 'endTime') {
        const timestamp = new Date(value).getTime()
        if (Number.isFinite(timestamp)) query[key] = new Date(timestamp).toISOString()
      } else {
        query[key] = value
      }
    }
    const response = await $fetch<{ logs: CallLog[]; total: number }>('/api/call-logs', {
      query,
      signal: requestController.signal
    })
    logs.value = response.logs
    total.value = response.total
  } catch (error: any) {
    if (error?.name !== 'AbortError') {
      toast.add({
        title: error?.data?.statusMessage || '获取日志失败',
        description: error?.message,
        color: 'error'
      })
    }
  } finally {
    loading.value = false
  }
}

function runSearch() {
  if (page.value !== 1) page.value = 1
  else void fetchLogs()
}

function resetFilters() {
  filters.value = {
    apiKeyId: '', accountId: '', modelName: '', callerIp: '', statusCode: '',
    isStream: '', hasError: '', startTime: '', endTime: ''
  }
  runSearch()
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function formatTokens(log: CallLog) {
  const parts: string[] = []
  if (log.prompt_tokens !== null) parts.push(`输入 ${log.prompt_tokens}`)
  if (log.completion_tokens !== null) parts.push(`输出 ${log.completion_tokens}`)
  if (log.cached_prompt_tokens !== null) parts.push(`缓存 ${log.cached_prompt_tokens}`)
  if (log.created_prompt_tokens !== null) parts.push(`创建 ${log.created_prompt_tokens}`)
  return parts.length ? parts.join(' · ') : '-'
}

function formatThroughput(throughput: number | null) {
  return throughput !== null && Number.isFinite(throughput)
    ? `${throughput.toFixed(2)} tokens/s`
    : '-'
}

function formatTiming(log: CallLog) {
  const parts: string[] = []
  if (log.first_token_time_ms !== null) parts.push(`首字 ${log.first_token_time_ms}ms`)
  if (log.response_time_ms !== null) parts.push(`总计 ${log.response_time_ms}ms`)
  return parts.length ? parts.join(' · ') : '-'
}

function getStatusColor(statusCode: number | null) {
  return statusCode === null ? 'neutral' : (statusColorMap[statusCode] || 'neutral')
}

const selectedLog = ref<CallLog | null>(null)
const errorDialogOpen = ref(false)
function showDetail(log: CallLog) {
  selectedLog.value = log
  errorDialogOpen.value = true
}

onMounted(fetchLogs)
onBeforeUnmount(() => requestController?.abort())
watch(page, fetchLogs)
</script>

<template>
  <div class="ocm-page space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="ocm-title text-2xl font-semibold">调用日志</h1>
        <p class="text-sm text-muted">完整查看模型、账号、Tokens、耗时与错误信息</p>
      </div>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="outline" :loading="loading" @click="fetchLogs">
        刷新
      </UButton>
    </div>

    <UCard class="ocm-card">
      <template #header>
        <div class="space-y-4">
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <UFormField label="API Key ID"><UInput v-model="filters.apiKeyId" placeholder="输入 Key ID" /></UFormField>
            <UFormField label="账号 ID"><UInput v-model="filters.accountId" placeholder="输入账号 ID" /></UFormField>
            <UFormField label="模型名称"><UInput v-model="filters.modelName" placeholder="搜索模型" /></UFormField>
            <UFormField label="调用者 IP"><UInput v-model="filters.callerIp" placeholder="搜索 IP" /></UFormField>
            <UFormField label="状态码"><UInput v-model="filters.statusCode" placeholder="如 200、500" /></UFormField>
            <UFormField label="响应类型"><USelect v-model="filters.isStream" :items="streamItems" class="w-full" /></UFormField>
            <UFormField label="调用结果"><USelect v-model="filters.hasError" :items="errorItems" class="w-full" /></UFormField>
            <UFormField label="开始时间"><UInput v-model="filters.startTime" type="datetime-local" class="w-full" /></UFormField>
            <UFormField label="结束时间"><UInput v-model="filters.endTime" type="datetime-local" class="w-full" /></UFormField>
          </div>
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
        empty="暂无符合条件的调用日志"
        class="max-h-[64vh] min-w-full"
        sticky="header"
      >
        <template #timestamp-cell="{ row }"><span class="whitespace-nowrap text-xs">{{ formatTimestamp(row.original.timestamp) }}</span></template>
        <template #api_key_prefix-cell="{ row }"><span class="whitespace-nowrap font-mono text-xs">{{ row.original.api_key_prefix || '-' }}</span></template>
        <template #model_name-cell="{ row }"><span class="block max-w-48 truncate text-sm" :title="row.original.model_name || ''">{{ row.original.model_name || '-' }}</span></template>
        <template #account_name-cell="{ row }">
          <div class="min-w-32 text-sm"><div class="truncate">{{ row.original.account_name || `#${row.original.account_id || '-'}` }}</div><div class="text-xs text-muted">ID: {{ row.original.account_id || '-' }}</div></div>
        </template>
        <template #is_stream-cell="{ row }"><UBadge :color="row.original.is_stream ? 'info' : 'neutral'" variant="subtle" size="sm">{{ row.original.is_stream ? '流式' : '非流式' }}</UBadge></template>
        <template #tokens-cell="{ row }"><span class="block min-w-36 whitespace-normal text-xs leading-5">{{ formatTokens(row.original) }}</span></template>
        <template #throughput-cell="{ row }"><span class="whitespace-nowrap text-xs">{{ formatThroughput(row.original.throughput) }}</span></template>
        <template #timing-cell="{ row }"><span class="block min-w-28 whitespace-normal text-xs leading-5">{{ formatTiming(row.original) }}</span></template>
        <template #caller_ip-cell="{ row }"><span class="whitespace-nowrap font-mono text-xs">{{ row.original.caller_ip || '-' }}</span></template>
        <template #status_code-cell="{ row }"><UBadge :color="getStatusColor(row.original.status_code)" variant="subtle" size="sm">{{ row.original.status_code ?? '-' }}</UBadge></template>
        <template #actions-cell="{ row }"><UButton icon="i-lucide-file-search" color="neutral" variant="ghost" size="xs" @click="showDetail(row.original)">查看</UButton></template>
      </UTable>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-default pt-4">
        <p class="text-sm text-muted">共 {{ total }} 条记录 · 第 {{ page }} 页</p>
        <UPagination v-model:page="page" :total="total" :items-per-page="pageSize" />
      </div>
    </UCard>

    <UModal v-model:open="errorDialogOpen" title="调用详情">
      <template #body>
        <div v-if="selectedLog" class="space-y-4">
          <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
            <dt class="text-muted">时间</dt><dd>{{ formatTimestamp(selectedLog.timestamp) }}</dd>
            <dt class="text-muted">模型</dt><dd>{{ selectedLog.model_name || '-' }}</dd>
            <dt class="text-muted">账号</dt><dd>{{ selectedLog.account_name || `#${selectedLog.account_id || '-'}` }}</dd>
            <dt class="text-muted">状态</dt><dd><UBadge :color="getStatusColor(selectedLog.status_code)" variant="subtle">{{ selectedLog.status_code ?? '-' }}</UBadge></dd>
            <dt class="text-muted">Tokens</dt><dd>{{ formatTokens(selectedLog) }}</dd>
            <dt class="text-muted">耗时</dt><dd>{{ formatTiming(selectedLog) }}</dd>
          </dl>
          <div v-if="selectedLog.error_message">
            <p class="mb-2 text-sm font-medium">错误信息</p>
            <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-error/20 bg-error/5 p-3 text-xs text-error">{{ selectedLog.error_message }}</pre>
          </div>
          <UAlert v-else color="success" variant="subtle" icon="i-lucide-circle-check" title="本次调用未记录错误" />
        </div>
      </template>
    </UModal>
  </div>
</template>
