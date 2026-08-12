// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  colorMode: {
    preference: 'light',
    fallback: 'light'
  },
  nitro: {
    preset: 'node-server',
    externals: {
      external: ['pg']
    },
    experimental: {
      tasks: true
    },
    scheduledTasks: {
      '* * * * *': ['refresh-accounts', 'refresh-error-accounts'],
      '*/15 * * * *': ['refresh-memberships', 'refresh-opencode-modules']
    }
  }
})
