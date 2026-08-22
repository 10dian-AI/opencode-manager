<script setup lang="ts">
interface IpPoolEntry {
  id: number
  name: string | null
  proxy_url: string
  enabled: boolean
  subscription_id: number | null
  region: string | null
  latency_ms: number | null
  health: 'healthy' | 'down' | 'unknown' | string
  account_count: number
  last_ip: string | null
  last_check_ok: boolean | null
  last_checked_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

interface IpPoolState {
  entries: IpPoolEntry[]
  block_size: number
  threshold_ms: number
  check_url: string
  assigned_accounts: number
}

interface ProxySubscription {
  id: number
  name: string | null
  url: string
  enabled: boolean
  last_fetched_at: string | null
  last_node_count: number | null
  last_error: string | null
  node_count: number
  supported_count: number
  imported_count: number
  created_at: string
  updated_at: string
}

interface SubscriptionNode {
  id: number
  subscription_id: number
  name: string
  protocol: string
  region: string | null
  supported: boolean
  unsupported_reason: string | null
  imported_pool_id: number | null
}

const requestFetch = useRequestFetch()
const toast = useToast()
const state = ref<IpPoolState>({
  entries: [],
  block_size: 5,
  threshold_ms: 3000,
  check_url: 'https://www.gstatic.com/generate_204',
  assigned_accounts: 0
})
const subscriptions = ref<ProxySubscription[]>([])
const loading = ref(false)
const actionId = ref<number | null>(null)
const subscriptionActionId = ref<number | null>(null)
const savingSettings = ref(false)
const assigning = ref(false)
const openAdd = ref(false)
const openEdit = ref(false)
const openAddSubscription = ref(false)
const openNodes = ref(false)
const formName = ref('')
const formUrls = ref('')
const editing = ref<IpPoolEntry | null>(null)
const blockSize = ref(5)
const thresholdMs = ref(3000)
const checkUrl = ref('https://www.gstatic.com/generate_204')
const subscriptionName = ref('')
const subscriptionUrl = ref('')
const addingSubscription = ref(false)
const nodeSubscription = ref<ProxySubscription | null>(null)
const nodes = ref<SubscriptionNode[]>([])
const selectedNodeIds = ref<number[]>([])
const importingNodes = ref(false)
const deleteTarget = ref<IpPoolEntry | null>(null)
const deleteDialogOpen = ref(false)
const deleteSubscriptionTarget = ref<ProxySubscription | null>(null)
const deleteSubscriptionDialogOpen = ref(false)

const subscriptionNames = computed(() => new Map(
  subscriptions.value.map(subscription => [subscription.id, subscription.name || `订阅 #${subscription.id}`])
))
const selectableNodes = computed(() => nodes.value.filter(node => node.supported && !node.imported_pool_id))
const selectedNodeIdSet = computed(() => new Set(selectedNodeIds.value))
const allSelectableNodesSelected = computed(() =>
  Boolean(selectableNodes.value.length) && selectableNodes.value.every(node => selectedNodeIdSet.value.has(node.id))
)
const someSelectableNodesSelected = computed(() =>
  selectableNodes.value.some(node => selectedNodeIdSet.value.has(node.id))
)
const selectAllNodesValue = computed<boolean | 'indeterminate'>(() =>
  allSelectableNodesSelected.value ? true : someSelectableNodesSelected.value ? 'indeterminate' : false
)

async function load() {
  loading.value = true
  try {
    const [pool, subscriptionResult] = await Promise.all([
      requestFetch<IpPoolState>('/api/ip-pool'),
      requestFetch<{ subscriptions: ProxySubscription[] }>('/api/ip-pool/subscriptions')
    ])
    state.value = pool
    subscriptions.value = subscriptionResult.subscriptions
    blockSize.value = pool.block_size
    thresholdMs.value = pool.threshold_ms
    checkUrl.value = pool.check_url
  } finally {
    loading.value = false
  }
}

await load()

function errorMessage(error: any, fallback: string) {
  return error?.data?.statusMessage || error?.data?.message || error?.message || fallback
}

function resetForm() {
  formName.value = ''
  formUrls.value = ''
  editing.value = null
}

function openAddModal() {
  resetForm()
  openAdd.value = true
}

function openEditModal(entry: IpPoolEntry) {
  editing.value = entry
  formName.value = entry.name || ''
  formUrls.value = ''
  openEdit.value = true
}

function closeAddModal() {
  openAdd.value = false
}

function closeEditModal() {
  openEdit.value = false
}

function protocolLabel(proxyUrl: string) {
  const protocol = proxyUrl.split(':', 1)[0]?.toLowerCase() || 'unknown'
  return protocol === 'ss' ? 'Shadowsocks' : protocol === 'trojan' ? 'Trojan' : protocol.toUpperCase()
}

function subscriptionHost(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function latencyText(latency: number | null) {
  return latency === null ? '未检测' : `${latency} ms`
}

async function addProxies() {
  loading.value = true
  try {
    const result = await requestFetch<{ created: number; skipped: number }>('/api/ip-pool', {
      method: 'POST',
      body: { name: formName.value, proxy_urls: formUrls.value }
    })
    openAdd.value = false
    resetForm()
    await load()
    toast.add({
      title: `已添加 ${result.created} 个代理`,
      description: result.skipped ? `跳过 ${result.skipped} 个重复地址` : undefined,
      color: 'success'
    })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '添加失败'), color: 'error' })
  } finally {
    loading.value = false
  }
}

async function saveEdit() {
  if (!editing.value) return
  actionId.value = editing.value.id
  try {
    await requestFetch(`/api/ip-pool/${editing.value.id}`, {
      method: 'PATCH',
      body: {
        name: formName.value,
        ...(formUrls.value.trim() ? { proxy_url: formUrls.value.trim() } : {})
      }
    })
    openEdit.value = false
    resetForm()
    await load()
    toast.add({ title: '代理已更新', color: 'success' })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '更新失败'), color: 'error' })
  } finally {
    actionId.value = null
  }
}

async function toggleEntry(entry: IpPoolEntry) {
  actionId.value = entry.id
  try {
    const result = await requestFetch<{ reassigned: number }>(`/api/ip-pool/${entry.id}`, {
      method: 'PATCH',
      body: { enabled: !entry.enabled }
    })
    await load()
    toast.add({
      title: entry.enabled ? '代理已停用' : '代理已启用',
      description: result.reassigned ? `已迁移 ${result.reassigned} 个受影响账号` : undefined,
      color: 'success'
    })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '操作失败'), color: 'error' })
  } finally {
    actionId.value = null
  }
}

async function testEntry(entry: IpPoolEntry) {
  actionId.value = entry.id
  try {
    const result = await requestFetch<{
      ok: boolean
      ip?: string
      error?: string
      latency_ms: number
    }>(`/api/ip-pool/${entry.id}/test`, { method: 'POST' })
    await load()
    toast.add({
      title: result.ok ? `代理可用 · ${result.ip}` : '代理检测失败',
      description: result.ok ? `请求延迟 ${result.latency_ms} ms` : `${result.error || '未知错误'} · ${result.latency_ms} ms`,
      color: result.ok ? 'success' : 'error'
    })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '代理检测失败'), color: 'error' })
  } finally {
    actionId.value = null
  }
}

function removeEntry(entry: IpPoolEntry) {
  deleteTarget.value = entry
  deleteDialogOpen.value = true
}

async function confirmRemoveEntry() {
  if (!deleteTarget.value) return
  const entry = deleteTarget.value
  actionId.value = entry.id
  try {
    const result = await requestFetch<{ reassigned: number }>(`/api/ip-pool/${entry.id}`, { method: 'DELETE' })
    deleteDialogOpen.value = false
    deleteTarget.value = null
    await load()
    toast.add({
      title: '代理已删除',
      description: result.reassigned ? `已迁移 ${result.reassigned} 个账号` : undefined,
      color: 'success'
    })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '删除失败'), color: 'error' })
  } finally {
    actionId.value = null
  }
}

async function saveSettings() {
  savingSettings.value = true
  try {
    await requestFetch('/api/ip-pool/settings', {
      method: 'PATCH',
      body: {
        block_size: blockSize.value,
        threshold_ms: thresholdMs.value,
        check_url: checkUrl.value
      }
    })
    await load()
    toast.add({ title: '代理分配和健康检查设置已保存', color: 'success' })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '保存失败'), color: 'error' })
  } finally {
    savingSettings.value = false
  }
}

async function assignUnbound() {
  assigning.value = true
  try {
    const result = await requestFetch<{ changed: number }>('/api/ip-pool/assign', { method: 'POST' })
    await load()
    toast.add({
      title: result.changed ? `已补齐 ${result.changed} 个账号绑定` : '所有账号绑定均已稳定',
      color: 'success'
    })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '绑定失败'), color: 'error' })
  } finally {
    assigning.value = false
  }
}

async function addSubscription() {
  addingSubscription.value = true
  try {
    const result = await requestFetch<{ node_count: number; supported_count: number }>('/api/ip-pool/subscriptions', {
      method: 'POST',
      body: { name: subscriptionName.value, url: subscriptionUrl.value }
    })
    openAddSubscription.value = false
    subscriptionName.value = ''
    subscriptionUrl.value = ''
    await load()
    toast.add({
      title: `订阅已添加，解析 ${result.node_count} 个节点`,
      description: `${result.supported_count} 个节点可直接导入`,
      color: 'success'
    })
  } catch (error: any) {
    await load().catch(() => {})
    toast.add({ title: errorMessage(error, '添加订阅失败'), color: 'error' })
  } finally {
    addingSubscription.value = false
  }
}

async function refreshSubscription(subscription: ProxySubscription) {
  subscriptionActionId.value = subscription.id
  try {
    const result = await requestFetch<{ node_count: number; supported_count: number }>(
      `/api/ip-pool/subscriptions/${subscription.id}/refresh`,
      { method: 'POST' }
    )
    await load()
    toast.add({
      title: `订阅已刷新，共 ${result.node_count} 个节点`,
      description: `${result.supported_count} 个节点可用`,
      color: 'success'
    })
  } catch (error: any) {
    await load().catch(() => {})
    toast.add({ title: errorMessage(error, '刷新订阅失败'), color: 'error' })
  } finally {
    subscriptionActionId.value = null
  }
}

async function viewSubscriptionNodes(subscription: ProxySubscription) {
  subscriptionActionId.value = subscription.id
  try {
    const result = await requestFetch<{ subscription: ProxySubscription; nodes: SubscriptionNode[] }>(
      `/api/ip-pool/subscriptions/${subscription.id}/nodes`
    )
    nodeSubscription.value = result.subscription
    nodes.value = result.nodes
    selectedNodeIds.value = result.nodes
      .filter(node => node.supported && !node.imported_pool_id)
      .map(node => node.id)
    openNodes.value = true
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '读取订阅节点失败'), color: 'error' })
  } finally {
    subscriptionActionId.value = null
  }
}

function setNodeSelected(id: number, value: boolean | 'indeterminate') {
  if (value === true) {
    selectedNodeIds.value = [...new Set([...selectedNodeIds.value, id])]
  } else {
    selectedNodeIds.value = selectedNodeIds.value.filter(selectedId => selectedId !== id)
  }
}

function setAllNodesSelected(value: boolean | 'indeterminate') {
  selectedNodeIds.value = value === true ? selectableNodes.value.map(node => node.id) : []
}

async function importSelectedNodes() {
  if (!nodeSubscription.value) return
  importingNodes.value = true
  try {
    const result = await requestFetch<{
      created: number
      skipped: number
      unsupported: number
      assigned: number
    }>(`/api/ip-pool/subscriptions/${nodeSubscription.value.id}/import`, {
      method: 'POST',
      body: { node_ids: selectedNodeIds.value }
    })
    openNodes.value = false
    await load()
    toast.add({
      title: `已导入 ${result.created} 个代理节点`,
      description: `跳过 ${result.skipped} 个重复节点，自动绑定 ${result.assigned} 个账号`,
      color: 'success'
    })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '导入节点失败'), color: 'error' })
  } finally {
    importingNodes.value = false
  }
}

function removeSubscription(subscription: ProxySubscription) {
  deleteSubscriptionTarget.value = subscription
  deleteSubscriptionDialogOpen.value = true
}

async function confirmRemoveSubscription() {
  if (!deleteSubscriptionTarget.value) return
  const subscription = deleteSubscriptionTarget.value
  subscriptionActionId.value = subscription.id
  try {
    await requestFetch(`/api/ip-pool/subscriptions/${subscription.id}`, { method: 'DELETE' })
    deleteSubscriptionDialogOpen.value = false
    deleteSubscriptionTarget.value = null
    await load()
    toast.add({ title: '订阅已删除，已导入的代理节点仍保留在 IP 池', color: 'success' })
  } catch (error: any) {
    toast.add({ title: errorMessage(error, '删除订阅失败'), color: 'error' })
  } finally {
    subscriptionActionId.value = null
  }
}
</script>

<template>
  <div class="ocm-page space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="ocm-title text-2xl font-semibold">IP 池</h1>
        <p class="text-sm text-muted">统一管理固定出口、机场订阅和节点健康状态</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton
          icon="i-lucide-blocks"
          color="neutral"
          variant="outline"
          :loading="assigning"
          @click="assignUnbound"
        >
          补齐绑定
        </UButton>
        <UButton icon="i-lucide-cloud-download" color="neutral" variant="outline" @click="openAddSubscription = true">
          导入机场订阅
        </UButton>
        <UButton icon="i-lucide-plus" @click="openAddModal">添加代理</UButton>
      </div>
    </div>

    <UAlert
      color="info"
      variant="subtle"
      title="稳定绑定与就近切换"
      description="系统每 5 分钟检测一次节点；超过延迟阈值会立即复测，连续 3 次超阈值才判定故障。故障节点上的账号优先迁移到同地区健康节点，减少出口地区突变。"
    />

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <UCard class="ocm-card ocm-metric-card">
        <p class="text-sm text-muted">代理节点</p>
        <p class="mt-2 text-3xl font-semibold text-highlighted">{{ state.entries.length }}</p>
      </UCard>
      <UCard class="ocm-card ocm-metric-card">
        <p class="text-sm text-muted">健康可用</p>
        <p class="mt-2 text-3xl font-semibold text-highlighted">
          {{ state.entries.filter(entry => entry.enabled && entry.health !== 'down').length }}
        </p>
      </UCard>
      <UCard class="ocm-card ocm-metric-card">
        <p class="text-sm text-muted">已绑定账号</p>
        <p class="mt-2 text-3xl font-semibold text-highlighted">{{ state.assigned_accounts }}</p>
      </UCard>
      <UCard class="ocm-card ocm-metric-card">
        <p class="text-sm text-muted">机场订阅</p>
        <p class="mt-2 text-3xl font-semibold text-highlighted">{{ subscriptions.length }}</p>
      </UCard>
    </div>

    <UCard class="ocm-card">
      <template #header>
        <div>
          <h2 class="font-medium text-highlighted">分配与健康检查</h2>
          <p class="mt-1 text-xs text-muted">设置会应用到定时检测；保存后不会无故重排已有稳定绑定。</p>
        </div>
      </template>
      <div class="grid gap-4 lg:grid-cols-[10rem_11rem_minmax(18rem,1fr)_auto] lg:items-end">
        <UFormField label="每块账号数" description="只影响之后的新绑定，不会重排已有账号">
          <UInput v-model.number="blockSize" type="number" :min="1" :max="1000" class="w-full" />
        </UFormField>
        <UFormField label="延迟阈值（毫秒）" description="范围 200–60000">
          <UInput v-model.number="thresholdMs" type="number" :min="200" :max="60000" class="w-full" />
        </UFormField>
        <UFormField label="检测地址" description="通过每个代理发起 HTTP(S) 请求">
          <UInput v-model="checkUrl" type="url" class="w-full font-mono text-xs" />
        </UFormField>
        <UButton :loading="savingSettings" @click="saveSettings">保存设置</UButton>
      </div>
    </UCard>

    <UCard class="ocm-card" :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="font-medium text-highlighted">机场订阅</h2>
            <p class="mt-1 text-xs text-muted">刷新只更新节点目录；勾选节点导入后才会进入 IP 池。</p>
          </div>
          <UButton size="sm" icon="i-lucide-plus" color="neutral" variant="outline" @click="openAddSubscription = true">
            添加订阅
          </UButton>
        </div>
      </template>
      <div v-if="!subscriptions.length" class="px-6 py-10 text-center text-sm text-muted">
        尚未添加机场订阅，也可以继续使用下方的手动代理导入。
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-default bg-elevated/50">
            <tr class="text-left text-muted">
              <th class="px-4 py-3 font-medium">订阅</th>
              <th class="px-4 py-3 font-medium">节点统计</th>
              <th class="px-4 py-3 font-medium">最近刷新</th>
              <th class="px-4 py-3 font-medium">状态</th>
              <th class="px-4 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="subscription in subscriptions" :key="subscription.id" class="border-b border-default last:border-0">
              <td class="px-4 py-3">
                <p class="font-medium text-highlighted">{{ subscription.name || `订阅 #${subscription.id}` }}</p>
                <p class="mt-1 max-w-sm truncate font-mono text-xs text-muted" :title="subscription.url">
                  {{ subscriptionHost(subscription.url) }}
                </p>
              </td>
              <td class="px-4 py-3">
                <p>{{ subscription.node_count }} 个节点 · {{ subscription.supported_count }} 个支持</p>
                <p class="mt-1 text-xs text-muted">已导入 {{ subscription.imported_count }} 个</p>
              </td>
              <td class="px-4 py-3 text-xs text-muted">
                {{ subscription.last_fetched_at ? formatDate(subscription.last_fetched_at) : '尚未成功刷新' }}
              </td>
              <td class="max-w-xs px-4 py-3">
                <UBadge :color="subscription.last_error ? 'error' : 'success'" variant="subtle">
                  {{ subscription.last_error ? '刷新异常' : '正常' }}
                </UBadge>
                <p v-if="subscription.last_error" class="mt-1 truncate text-xs text-error" :title="subscription.last_error">
                  {{ subscription.last_error }}
                </p>
              </td>
              <td class="px-4 py-3">
                <div class="flex justify-end gap-1">
                  <UButton
                    icon="i-lucide-list-checks"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    title="查看和导入节点"
                    :loading="subscriptionActionId === subscription.id"
                    @click="viewSubscriptionNodes(subscription)"
                  />
                  <UButton
                    icon="i-lucide-refresh-cw"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    title="刷新订阅"
                    :loading="subscriptionActionId === subscription.id"
                    @click="refreshSubscription(subscription)"
                  />
                  <UButton
                    icon="i-lucide-trash-2"
                    size="xs"
                    color="error"
                    variant="ghost"
                    title="删除订阅"
                    :loading="subscriptionActionId === subscription.id"
                    @click="removeSubscription(subscription)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <UCard class="ocm-card" :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <div>
          <h2 class="font-medium text-highlighted">代理节点</h2>
          <p class="mt-1 text-xs text-muted">支持 HTTP(S)、SOCKS5、Shadowsocks 和 Trojan；订阅凭据与代理密码均会隐藏。</p>
        </div>
      </template>
      <div v-if="!state.entries.length" class="py-16 text-center">
        <UIcon name="i-lucide-network" class="mx-auto size-10 text-muted" />
        <p class="mt-3 text-muted">IP 池为空，账号当前使用服务器直连出口</p>
        <UButton class="mt-4" icon="i-lucide-plus" @click="openAddModal">添加代理</UButton>
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-default bg-elevated/50">
            <tr class="text-left text-muted">
              <th class="px-4 py-3 font-medium">节点</th>
              <th class="px-4 py-3 font-medium">代理地址</th>
              <th class="px-4 py-3 font-medium">地区 / 来源</th>
              <th class="px-4 py-3 font-medium">出口与延迟</th>
              <th class="px-4 py-3 font-medium">绑定账号</th>
              <th class="px-4 py-3 font-medium">状态</th>
              <th class="px-4 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in state.entries" :key="entry.id" class="border-b border-default last:border-0">
              <td class="px-4 py-3">
                <p class="font-medium text-highlighted">{{ entry.name || `代理 #${entry.id}` }}</p>
                <div class="mt-1 flex items-center gap-1">
                  <UBadge color="neutral" variant="subtle" size="xs">{{ protocolLabel(entry.proxy_url) }}</UBadge>
                  <span class="text-xs text-muted">#{{ entry.id }}</span>
                </div>
              </td>
              <td class="max-w-xs px-4 py-3 font-mono text-xs">
                <span class="break-all">{{ entry.proxy_url }}</span>
              </td>
              <td class="px-4 py-3">
                <p>{{ entry.region || '未知地区' }}</p>
                <p class="mt-1 text-xs text-muted">
                  {{ entry.subscription_id ? subscriptionNames.get(entry.subscription_id) || `订阅 #${entry.subscription_id}` : '手动添加' }}
                </p>
              </td>
              <td class="px-4 py-3">
                <p class="font-mono text-xs">{{ entry.last_ip || '尚未获取出口 IP' }}</p>
                <p class="mt-1 text-xs" :class="entry.health === 'down' ? 'text-error' : 'text-muted'">
                  {{ latencyText(entry.latency_ms) }}
                </p>
                <p v-if="entry.last_checked_at" class="mt-1 text-xs text-muted">{{ formatDate(entry.last_checked_at) }}</p>
                <p v-if="entry.last_error" class="mt-1 max-w-xs truncate text-xs text-error" :title="entry.last_error">
                  {{ entry.last_error }}
                </p>
              </td>
              <td class="px-4 py-3">{{ entry.account_count }}</td>
              <td class="px-4 py-3">
                <UBadge :color="entry.enabled ? 'success' : 'neutral'" variant="subtle">
                  {{ entry.enabled ? '启用' : '停用' }}
                </UBadge>
                <UBadge
                  class="ml-1"
                  :color="entry.health === 'healthy' ? 'info' : entry.health === 'down' ? 'error' : 'neutral'"
                  variant="subtle"
                >
                  {{ entry.health === 'healthy' ? '健康' : entry.health === 'down' ? '故障' : '未知' }}
                </UBadge>
              </td>
              <td class="px-4 py-3">
                <div class="flex justify-end gap-1">
                  <UButton
                    icon="i-lucide-stethoscope"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    title="立即检测出口 IP 和延迟"
                    :loading="actionId === entry.id"
                    @click="testEntry(entry)"
                  />
                  <UButton
                    :icon="entry.enabled ? 'i-lucide-pause' : 'i-lucide-play'"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :title="entry.enabled ? '停用' : '启用'"
                    :loading="actionId === entry.id"
                    @click="toggleEntry(entry)"
                  />
                  <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" @click="openEditModal(entry)" />
                  <UButton
                    icon="i-lucide-trash-2"
                    size="xs"
                    color="error"
                    variant="ghost"
                    :loading="actionId === entry.id"
                    @click="removeEntry(entry)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <UModal v-model:open="openAdd" title="添加出口代理">
      <template #body>
        <div class="space-y-4">
          <UFormField label="名称"><UInput v-model="formName" placeholder="可选；批量添加时自动编号" class="w-full" /></UFormField>
          <UFormField label="代理地址" required>
            <UTextarea
              v-model="formUrls"
              :rows="7"
              class="w-full font-mono text-xs"
              placeholder="每行一个，例如：&#10;http://user:pass@1.2.3.4:8080&#10;socks5://user:pass@1.2.3.4:1080&#10;1.2.3.4:8080:user:pass"
            />
          </UFormField>
          <UAlert
            color="neutral"
            variant="subtle"
            title="支持 HTTP(S) / SOCKS5 / Shadowsocks / Trojan"
            description="可逐行粘贴 http://、https://、socks5://、ss://、trojan://，也兼容 ip:port:user:password；列表和日志中的凭据会被隐藏。"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="closeAddModal">取消</UButton>
          <UButton :loading="loading" @click="addProxies">添加并自动绑定</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="openEdit" title="编辑出口代理">
      <template #body>
        <div class="space-y-4">
          <UFormField label="名称"><UInput v-model="formName" class="w-full" /></UFormField>
          <UFormField label="新代理地址">
            <UInput v-model="formUrls" type="password" placeholder="留空保留当前地址和凭据" class="w-full font-mono" />
          </UFormField>
          <p class="text-xs text-muted">当前：{{ editing?.proxy_url }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="closeEditModal">取消</UButton>
          <UButton :loading="actionId === editing?.id" @click="saveEdit">保存</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="openAddSubscription" title="添加机场订阅">
      <template #body>
        <div class="space-y-4">
          <UFormField label="订阅名称" description="可选，用于区分不同机场或用途">
            <UInput v-model="subscriptionName" placeholder="例如：香港低延迟线路" class="w-full" />
          </UFormField>
          <UFormField label="订阅链接" required description="支持 Base64 URI 列表、纯 URI 列表和 Clash YAML">
            <UInput
              v-model="subscriptionUrl"
              type="password"
              placeholder="https://example.com/api/v1/client/subscribe?token=..."
              class="w-full font-mono text-xs"
            />
          </UFormField>
          <UAlert
            color="neutral"
            variant="subtle"
            title="添加后会立即拉取一次"
            description="解析完成后可查看全部节点，并选择需要的节点导入 IP 池。暂不支持的协议会标明原因。"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="addingSubscription" @click="openAddSubscription = false">
            取消
          </UButton>
          <UButton :loading="addingSubscription" @click="addSubscription">添加并解析</UButton>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="openNodes"
      :title="`选择节点 · ${nodeSubscription?.name || `订阅 #${nodeSubscription?.id || ''}`}`"
      :dismissible="!importingNodes"
      :ui="{ content: 'sm:max-w-5xl' }"
    >
      <template #body>
        <div class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="text-sm text-muted">
              共 {{ nodes.length }} 个节点，{{ selectableNodes.length }} 个可选；已选择 {{ selectedNodeIds.length }} 个。
            </div>
            <UCheckbox
              :model-value="selectAllNodesValue"
              :disabled="!selectableNodes.length"
              label="全选可用且未导入节点"
              @update:model-value="setAllNodesSelected"
            />
          </div>

          <div v-if="!nodes.length" class="rounded-lg border border-default px-6 py-10 text-center text-sm text-muted">
            订阅中没有可显示的节点，请先刷新订阅。
          </div>
          <div v-else class="max-h-[55vh] overflow-auto rounded-lg border border-default">
            <table class="w-full text-sm">
              <thead class="sticky top-0 z-10 border-b border-default bg-default">
                <tr class="text-left text-muted">
                  <th class="w-12 px-4 py-3 font-medium">选择</th>
                  <th class="px-4 py-3 font-medium">节点</th>
                  <th class="px-4 py-3 font-medium">协议</th>
                  <th class="px-4 py-3 font-medium">地区</th>
                  <th class="px-4 py-3 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="node in nodes" :key="node.id" class="border-b border-default last:border-0">
                  <td class="px-4 py-3">
                    <UCheckbox
                      :model-value="selectedNodeIdSet.has(node.id)"
                      :disabled="!node.supported || Boolean(node.imported_pool_id)"
                      :aria-label="`选择节点 ${node.name}`"
                      @update:model-value="value => setNodeSelected(node.id, value)"
                    />
                  </td>
                  <td class="px-4 py-3">
                    <p class="max-w-md break-words font-medium text-highlighted">{{ node.name }}</p>
                    <p class="mt-1 text-xs text-muted">节点 #{{ node.id }}</p>
                  </td>
                  <td class="px-4 py-3">
                    <UBadge color="neutral" variant="subtle">{{ node.protocol.toUpperCase() }}</UBadge>
                  </td>
                  <td class="px-4 py-3">{{ node.region || '未知地区' }}</td>
                  <td class="max-w-xs px-4 py-3">
                    <UBadge v-if="node.imported_pool_id" color="info" variant="subtle">
                      已导入 #{{ node.imported_pool_id }}
                    </UBadge>
                    <UBadge v-else-if="node.supported" color="success" variant="subtle">可导入</UBadge>
                    <UBadge v-else color="error" variant="subtle">不支持</UBadge>
                    <p v-if="node.unsupported_reason" class="mt-1 text-xs text-error">
                      {{ node.unsupported_reason }}
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-3">
          <p class="text-xs text-muted">导入后将按现有分块规则补齐未绑定账号。</p>
          <div class="flex gap-2">
            <UButton color="neutral" variant="ghost" :disabled="importingNodes" @click="openNodes = false">取消</UButton>
            <UButton
              icon="i-lucide-download"
              :loading="importingNodes"
              :disabled="!selectedNodeIds.length"
              @click="importSelectedNodes"
            >
              导入所选 {{ selectedNodeIds.length }} 个节点
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <AppConfirmDialog
      v-model:open="deleteDialogOpen"
      title="删除出口代理？"
      :description="`将删除“${deleteTarget?.name || `代理 #${deleteTarget?.id || ''}`}”。绑定账号会自动迁移到其他可用出口。`"
      :loading="actionId === deleteTarget?.id"
      @confirm="confirmRemoveEntry"
    />

    <AppConfirmDialog
      v-model:open="deleteSubscriptionDialogOpen"
      title="删除机场订阅？"
      :description="`将删除“${deleteSubscriptionTarget?.name || `订阅 #${deleteSubscriptionTarget?.id || ''}`}”及缓存节点目录。已经导入 IP 池的代理节点会继续保留。`"
      :loading="subscriptionActionId === deleteSubscriptionTarget?.id"
      @confirm="confirmRemoveSubscription"
    />
  </div>
</template>
