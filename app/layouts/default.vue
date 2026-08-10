<script setup lang="ts">
const { logout } = useAuth()
const route = useRoute()

const links = [
  { label: '仪表盘', to: '/', icon: 'i-lucide-layout-dashboard' },
  { label: '号池', to: '/accounts', icon: 'i-lucide-users' },
  { label: 'IP 池', to: '/ip-pool', icon: 'i-lucide-network' },
  { label: 'API 密钥', to: '/api-keys', icon: 'i-lucide-key-round' },
  { label: '调用日志', to: '/call-logs', icon: 'i-lucide-scroll-text' }
]
</script>

<template>
  <div class="ocm-shell min-h-screen">
    <UHeader class="ocm-header">
      <template #left>
        <div class="flex items-center gap-3">
          <span class="ocm-brand-mark">
            <UIcon name="i-lucide-boxes" class="size-5 text-white" />
          </span>
          <span class="font-semibold text-highlighted">10dian <em class="not-italic text-primary">OpenCode</em></span>
        </div>
      </template>

      <template #right>
        <nav class="hidden md:flex items-center gap-1">
          <UButton
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            :variant="route.path === link.to ? 'soft' : 'ghost'"
            :color="route.path === link.to ? 'primary' : 'neutral'"
            :icon="link.icon"
            size="sm"
          >
            {{ link.label }}
          </UButton>
        </nav>
        <UButton
          icon="i-lucide-log-out"
          color="neutral"
          variant="ghost"
          size="sm"
          @click="logout"
        >
          退出
        </UButton>
      </template>
    </UHeader>

    <UMain class="ocm-main">
      <UContainer class="py-8 pb-24 lg:py-10 md:pb-10">
        <slot />
      </UContainer>
    </UMain>

    <nav class="fixed inset-x-3 bottom-3 z-50 grid grid-cols-5 gap-1 rounded-2xl border border-default bg-default/95 p-2 shadow-xl backdrop-blur md:hidden">
      <UButton
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        :variant="route.path === link.to ? 'soft' : 'ghost'"
        :color="route.path === link.to ? 'primary' : 'neutral'"
        :icon="link.icon"
        size="sm"
        class="justify-center"
      >
        <span class="sr-only">{{ link.label }}</span>
      </UButton>
    </nav>
  </div>
</template>
