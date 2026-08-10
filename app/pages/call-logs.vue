<script setup lang="ts">
import type { CallLog } from '~/server/utils/call-logs'

const toast = useToast()
const loading = ref(false)
const logs = ref<CallLog[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)

// Search filters
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

const columns = [
  { key: 'timestamp', label: '时间' },
  { key: 'api_key_prefix', label: 'API Key' },
  { key: 'model_name', label: '模型' },
  { key: 'account_name', label: '账号' },
  { key: 'is_stream', label: '类型' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'throughput', label: '吞吐速度' },
  { key: 'timing', label: '响应时间' },
  { key: 'caller_ip', label: '调用IP' },
  { key: 'status_code', label: '状态' },
  { key: 'actions', label: '操作' }
]

const statusColorMap: Record<number, string> = {
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

async function fetchLogs() {
  loading.value = true
  try {
    const query: any = {
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value
    }

    if (filters.value.apiKeyId) query.apiKeyId = filters.value.apiKeyId
    if (filters.value.accountId) query.accountId = filters.value.accountId
    if (filters.value.modelName) query.modelName = filters.value.modelName
    if (filters.value.callerIp) query.callerIp = filters.value.callerIp
    if (filters.value.statusCode) query.statusCode = filters.value.statusCode
    if (filters.value.isStream) query.isStream = filters.value.isStream
    if (filters.value.hasError) query.hasError = filters.value.hasError
    if (filters.value.startTime) query.startTime = filters.value.startTime
    if (filters.value.endTime) query.endTime = filters.value.endTime

    const response = await $fetch<{ logs: CallLog[]; total: number }>('/api/call-logs', { query })
    logs.value = response.logs
    total.value = response.total
  } catch (e: any) {
    toast.add({ title: e?.data?.statusMessage || '获取日志失败', color: 'error' })
  } finally {
    loading.value = false
  }
}

function resetFilters() {
  filters.value = {
    apiKeyId: '',
    accountId: '',
    modelName: '',
    callerIp: '',
    statusCode: '',
    isStream: '',
    hasError: '',
    startTime: '',
    endTime: ''
  }
  page.value = 1
  fetchLogs()
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatTokens(log: CallLog) {
  const parts: string[] = []
  if (log.prompt_tokens !== null) parts.push(`输入: ${log.prompt_tokens}`)
  if (log.completion_tokens !== null) parts.push(`输出: ${log.completion_tokens}`)
  if (log.cached_prompt_tokens !== null) parts.push(`缓存: ${log.cached_prompt_tokens}`)
  if (log.created_prompt_tokens !== null) parts.push(`创建: ${log.created_prompt_tokens}`)
  return parts.length ? parts.join(' / ') : '-'
}

function formatThroughput(throughput: number | null) {
  return throughput !== null ? `${throughput.toFixed(2)} tokens/s` : '-'
}

function formatTiming(log: CallLog) {
  const parts: string[] = []
  if (log.first_token_time_ms !== null) parts.push(`首字: ${log.first_token_time_ms}ms`)
  if (log.response_time_ms !== null) parts.push(`总计: ${log.response_time_ms}ms`)
  return parts.length ? parts.join(' / ') : '-'
}

function getStatusColor(statusCode: number | null): string {
  if (statusCode === null) return 'neutral'
  return statusColorMap[statusCode] || 'neutral'
}

const selectedLog = ref<CallLog | null>(null)
const errorDialogOpen = ref(false)

function showErrorDetail(log: CallLog) {
  selectedLog.value = log
  errorDialogOpen.value = true
}

await fetchLogs()

watch(page, fetchLogs)
</script>

<template>
  <div class="ocm-page space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="ocm-title text-2xl font-semibold">调用日志</h1>
        <p class="text-sm text-muted">查看所有模型调用记录</p>
      </div>
      <div class="flex gap-2">
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="outline"
          :loading="loading"
          @click="fetchLogs"
        >
          刷新
        </UButton>
      </div>
    </div>

    <UCard class="ocm-card">
      <template #header>
        <div class="space-y-4">
          <h2 class="font-medium text-highlighted">搜索过滤</h2>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <UFormField label="API Key ID">
              <UInput v-model="filters.apiKeyId" placeholder="输入 Key ID" />
            </UFormField>
            <UFormField label="账号 ID">
              <UInput v-model="filters.accountId" placeholder="输入账号 ID" />
            </UFormField>
            <UFormField label="模型名称">
              <UInput v-model="filters.modelName" placeholder="搜索模型" />
            </UFormField>
            <UFormField label="调用者 IP">
              <UInput v-model="filters.callerIp" placeholder="搜索 IP" />
            </UFormField>
            <UFormField label="状态码">
              <UInput v-model="filters.statusCode" placeholder="如: 200, 500" />
            </UFormField>
            <UFormField label="流式/非流式">
              <USelect
                v-model="filters.isStream"
                :options="[
                  { label: '全部', value: '' },
                  { label: '流式', value: 'true' },
                  { label: '非流式', value: 'false' }
                ]"
              />
            </UFormField>
            <UFormField label="是否有错误">
              <USelect
                v-model="filters.hasError"
                :options="[
                  { label: '全部', value: '' },
                  { label: '仅错误', value: 'true' },
                  { label: '仅正常', value: 'false' }
                ]"
              />
            </UFormField>
            <UFormField label="时间范围">
              <div class="flex gap-2">
                <UInput v-model="filters.startTime" type="datetime-local" size="sm" />
                <UInput v-model="filters.endTime" type="datetime-local" size="sm" />
              </div>
            </UFormField>
          </div>
          <div class="flex gap-2">
            <UButton @click="fetchLogs" color="primary" :loading="loading">
              搜索
            </UButton>
            <UButton @click="resetFilters" variant="outline" color="neutral">
              重置
            </UButton>
          </div>
        </div>
      </template>

      <div v-if="loading" class="py-10 text-center">
        <UIcon name="i-lucide-loader-circle" class="mx-auto size-8 animate-spin text-primary" />
        <p class="mt-3 text-sm text-muted">加载中...</p>
      </div>

      <div v-else-if="!logs.length" class="py-10 text-center text-muted">
        暂无调用日志
      </div>

      <div v-else class="overflow-x-auto">
        <UTable :columns="columns" :rows="logs" class="min-w-full">
          <template #timestamp-data="{ row }">
            <span class="text-sm">{{ formatTimestamp(row.timestamp) }}</span>
          </template>

          <template #api_key_prefix-data="{ row }">
            <span class="font-mono text-xs">{{ row.api_key_prefix || '-' }}</span>
          </template>

          <template #model_name-data="{ row }">
            <span class="text-sm">{{ row.model_name || '-' }}</span>
          </template>

          <template #account_name-data="{ row }">
            <div class="text-sm">
              <div>{{ row.account_name || `#${row.account_id}` }}</div>
              <div class="text-xs text-muted">ID: {{ row.account_id || '-' }}</div>
            </div>
          </template>

          <template #is_stream-data="{ row }">
            <UBadge :color="row.is_stream ? 'info' : 'neutral'" variant="subtle" size="sm">
              {{ row.is_stream ? '流式' : '非流式' }}
            </UBadge>
          </template>

          <template #tokens-data="{ row }">
            <span class="text-xs">{{ formatTokens(row) }}</span>
          </template>

          <template #throughput-data="{ row }">
            <span class="text-xs">{{ formatThroughput(row.throughput) }}</span>
          </template>

          <template #timing-data="{ row }">
            <span class="text-xs">{{ formatTiming(row) }}</span>
          </template>

          <template #caller_ip-data="{ row }">
            <span class="font-mono text-xs">{{ row.caller_ip || '-' }}</span>
          </template>

          <template #status_code-data="{ row }">
            <UBadge :color="getStatusColor(row.status_code)" variant="subtle" size="sm">
              {{ row.status_code || '-' }}
            </UBadge>
          </template>

          <template #actions-data="{ row }">
            <UButton
              v-if="row.error_message"
              @click="showErrorDetail(row)"
              icon="i-lucide-alert-circle"
              color="error"
              variant="ghost"
              size="xs"
            >
              查看错误
            </UButton>
          </template>
        </UTable>

        <div class="mt-4 flex items-center justify-between">
          <div class="text-sm text-muted">
            共 {{ total }} 条记录，当前第 {{ page }} 页
          </div>
          <UPagination
            v-model="page"
            :total="total"
            :page-size="pageSize"
          />
        </div>
      </div>
    </UCard>

    <UModal v-model="errorDialogOpen">
      <UCard>
        <template #header>
          <h3 class="font-medium">错误详情</h3>
        </template>

        <div v-if="selectedLog" class="space-y-3">
          <div>
            <span class="text-sm font-medium">时间:</span>
            <span class="ml-2 text-sm text-muted">{{ formatTimestamp(selectedLog.timestamp) }}</span>
          </div>
          <div>
            <span class="text-sm font-medium">状态码:</span>
            <UBadge :color="getStatusColor(selectedLog.status_code)" variant="subtle" size="sm" class="ml-2">
              {{ selectedLog.status_code }}
            </UBadge>
          </div>
          <div>
            <span class="text-sm font-medium">错误信息:</span>
            <pre class="mt-2 rounded-md bg-muted/50 p-3 text-xs">{{ selectedLog.error_message }}</pre>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end">
            <UButton @click="errorDialogOpen = false" color="neutral">
              关闭
            </UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </div>
</template>
