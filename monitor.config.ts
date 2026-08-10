import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  future: { compatibilityVersion: 4 },
  modules: ['@nuxt/ui'],
  runtimeConfig: {
    sessionPassword: '',
    public: {
      monitorPort: 3031
    }
  },
  nitro: {
    experimental: {
      openAPI: true
    }
  },
  devtools: { enabled: true },
  compatibilityDate: '2024-11-25'
})
