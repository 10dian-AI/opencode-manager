<script setup lang="ts">
interface ApiKeyItem {
  id: string
  name: string
  prefix: string
  source: 'config' | 'web'
  affinity_enabled?: boolean
  created_at: string | null
}

const requestFetch = useRequestFetch()
const toast = useToast()
const keys = ref<ApiKeyItem[]>([])
const open = ref(false)
const name = ref('')
const customKey = ref('')
const createdKey = ref('')
const submitting = ref(false)
const deleting = ref(false)
const deleteTarget = ref<ApiKeyItem | null>(null)
const deleteDialogOpen = ref(false)
const affinityUpdating = ref<string | null>(null)
const baseUrl = `${useRequestURL().origin}/v1`

async function load() {
  keys.value = await requestFetch<ApiKeyItem[]>('/api/api-keys')
}

function openModal() { open.value = true }
function closeModal() { open.value = false }

onMounted(load)

async function createKey() {
  submitting.value = true
  try {
    const result = await requestFetch<ApiKeyItem & { key: string }>('/api/api-keys', {
      method: 'POST',
      body: { name: name.value, key: customKey.value || undefined }
    })
    createdKey.value = result.key
    open.value = false
    name.value = ''
    customKey.value = ''
    await load()
    toast.add({ title: 'API 密钥已创建', color: 'success' })
  } catch (error: any) {
    toast.add({ title: error?.data?.statusMessage || '创建失败', color: 'error' })
  } finally {
    submitting.value = false
  }
}

function removeKey(key: ApiKeyItem) {
  if (key.source === 'config') return
  deleteTarget.value = key
  deleteDialogOpen.value = true
}

async function confirmRemoveKey() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await requestFetch(`/api/api-keys/${deleteTarget.value.id}`, { method: 'DELETE' })
    await load()
    toast.add({ title: 'API 密钥已删除', color: 'success' })
    deleteDialogOpen.value = false
    deleteTarget.value = null
  } catch (error: any) {
    toast.add({ title: error?.data?.statusMessage || '删除失败', color: 'error' })
  } finally {
    deleting.value = false
  }
}

async function toggleAffinity(key: ApiKeyItem, value: boolean) {
  if (key.source !== 'web') return
  affinityUpdating.value = key.id
  try {
    const updated = await requestFetch<ApiKeyItem>(`/api/api-keys/${key.id}`, {
      method: 'PATCH',
      body: { affinity_enabled: value }
    })
    const index = keys.value.findIndex(k => k.id === key.id)
    if (index >= 0) keys.value[index] = { ...keys.value[index]!, ...updated }
    toast.add({
      title: value ? '已开启亲和路由' : '已关闭亲和路由',
      color: 'success'
    })
  } catch (error: any) {
    toast.add({ title: error?.data?.statusMessage || '设置失败', color: 'error' })
  } finally {
    affinityUpdating.value = null
  }
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.add({ title: '已复制', color: 'success' })
  } catch {
    toast.add({ title: '复制失败，请检查浏览器剪贴板权限', color: 'error' })
  }
}
</script>

<template>
  <div class="ocm-page space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="ocm-title text-2xl font-semibold">API 密钥</h1>
        <p class="text-sm text-muted">管理 OpenAI 兼容接口的访问密钥</p>
      </div>
      <UButton icon="i-lucide-plus" @click="openModal">添加密钥</UButton>
    </div>

    <UAlert
      v-if="createdKey"
      color="success"
      variant="subtle"
      title="请立即保存新密钥，它只显示这一次"
    >
      <template #description>
        <div class="mt-2 flex items-center gap-2">
          <code class="min-w-0 flex-1 break-all rounded bg-default p-2">{{ createdKey }}</code>
          <UButton icon="i-lucide-copy" color="neutral" variant="outline" @click="copy(createdKey)" />
        </div>
      </template>
    </UAlert>

    <UCard class="ocm-card">
      <template #header><h2 class="font-medium">接口信息</h2></template>
      <div class="space-y-2 text-sm">
        <div><span class="text-muted">Base URL：</span><code>{{ baseUrl }}</code></div>
        <div><span class="text-muted">Chat：</span><code>POST {{ baseUrl }}/chat/completions</code></div>
        <div><span class="text-muted">Models：</span><code>GET {{ baseUrl }}/models</code></div>
      </div>
    </UCard>

    <UAlert
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      title="亲和路由说明"
      description="开启亲和的密钥，会根据请求体中的 `user`（session_id）或 `metadata.prompt_cache_key` 字段，将同一会话的请求路由到同一账号，从而显著提升 prompt cache 命中率。"
    />

    <UCard class="ocm-card" :ui="{ body: 'p-0 sm:p-0' }">
      <table class="w-full text-sm">
        <thead class="border-b border-default bg-elevated/50">
          <tr class="text-left text-muted">
            <th class="p-4">名称</th>
            <th class="p-4">密钥</th>
            <th class="p-4">来源</th>
            <th class="p-4">亲和路由</th>
            <th class="p-4">创建时间</th>
            <th class="p-4"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="key in keys" :key="key.id" class="border-b border-default last:border-0">
            <td class="p-4 font-medium">{{ key.name }}</td>
            <td class="p-4 font-mono">{{ key.prefix }}</td>
            <td class="p-4">
              <UBadge variant="subtle">{{ key.source === 'config' ? 'config.yaml' : '网页' }}</UBadge>
            </td>
            <td class="p-4">
              <div class="flex items-center gap-2">
                <USwitch
                  v-if="key.source === 'web'"
                  :model-value="key.affinity_enabled ?? false"
                  :disabled="affinityUpdating === key.id"
                  size="sm"
                  :aria-label="`${key.name} 亲和路由`"
                  @update:model-value="val => toggleAffinity(key, val)"
                />
                <span v-if="key.source === 'web'" class="text-xs" :class="key.affinity_enabled ? 'text-primary' : 'text-muted'">
                  {{ key.affinity_enabled ? '已开启' : '已关闭' }}
                </span>
                <span v-else class="text-xs text-muted">不支持</span>
              </div>
            </td>
            <td class="p-4 text-muted">{{ formatDate(key.created_at) }}</td>
            <td class="p-4 text-right">
              <UButton v-if="key.source === 'web'" icon="i-lucide-trash-2" color="error" variant="ghost" @click="removeKey(key)" />
            </td>
          </tr>
        </tbody>
      </table>
    </UCard>

    <UModal v-model:open="open" title="添加 API 密钥">
      <template #body>
        <div class="space-y-4">
          <UFormField label="名称"><UInput v-model="name" placeholder="例如 Claude Code" class="w-full" /></UFormField>
          <UFormField label="自定义密钥（留空自动生成）"><UInput v-model="customKey" type="password" placeholder="sk-..." class="w-full" /></UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="closeModal">取消</UButton>
          <UButton :loading="submitting" @click="createKey">创建</UButton>
        </div>
      </template>
    </UModal>

    <AppConfirmDialog
      v-model:open="deleteDialogOpen"
      title="删除 API 密钥？"
      :description="`将永久删除 '${deleteTarget?.name || ''}' 。使用该密钥的客户端会立即失去访问权限。`"
      :loading="deleting"
      @confirm="confirmRemoveKey"
    />
  </div>
</template>
