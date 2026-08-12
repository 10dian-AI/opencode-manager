<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const { login } = useAuth()
const route = useRoute()
const key = ref('')
const loading = ref(false)
const error = ref('')

const redirectTarget = computed(() => {
  const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  return target.startsWith('/') && !target.startsWith('//') && target !== '/login' ? target : '/'
})

async function onSubmit() {
  error.value = ''
  if (!key.value.trim()) {
    error.value = '请输入 Admin Key'
    return
  }
  loading.value = true
  try {
    await login(key.value)
    await navigateTo(redirectTarget.value, { replace: true })
  } catch (cause: any) {
    error.value = cause?.data?.statusMessage || cause?.message || '登录失败，请检查 Admin Key'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="ocm-auth-stage">
    <section class="ocm-auth-panel" aria-labelledby="login-title">
      <div class="ocm-auth-story">
        <div class="ocm-auth-brand">
          <span class="ocm-brand-mark"><UIcon name="i-lucide-boxes" class="size-5 text-white" /></span>
          <span>10dian <strong>OpenCode</strong></span>
        </div>
        <div class="ocm-auth-copy">
          <p class="ocm-auth-kicker">CONTROL DESK / 账号控制台</p>
          <h1 id="login-title">让每个账号状态<br><span>清楚、可控、可追踪。</span></h1>
          <p>统一管理号池、额度、风控与调用日志。登录后即可回到实时控制台。</p>
        </div>
        <div class="ocm-auth-signal" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
      </div>

      <div class="ocm-auth-form-wrap">
        <div class="ocm-auth-form-head">
          <span class="ocm-auth-security"><UIcon name="i-lucide-shield-check" class="size-4" /> 管理员验证</span>
          <h2>欢迎回来</h2>
          <p>输入部署配置中的 Admin Key 继续。</p>
        </div>

        <form class="space-y-5" @submit.prevent="onSubmit">
          <UFormField label="Admin Key" name="key" required>
            <UInput
              v-model="key"
              type="password"
              placeholder="输入 Admin Key"
              icon="i-lucide-key-round"
              size="xl"
              autofocus
              autocomplete="current-password"
              class="w-full"
            />
          </UFormField>

          <UAlert v-if="error" color="error" variant="subtle" :title="error" icon="i-lucide-circle-alert" />

          <UButton type="submit" block size="xl" :loading="loading" icon="i-lucide-arrow-right" trailing>
            进入控制台
          </UButton>
        </form>

        <p class="ocm-auth-hint">密钥仅用于创建本机管理会话，不会显示在界面中。</p>
      </div>
    </section>
  </main>
</template>
