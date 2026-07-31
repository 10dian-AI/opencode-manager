import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

export interface AppConfig {
  admin_key: string
  api_keys: string[]
}

let cached: AppConfig | null = null

function normalizeApiKeys(value: string[] | string | undefined): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : []
  return list.map(key => String(key).trim()).filter(Boolean)
}

function readConfigFile(): Partial<AppConfig> {
  const path = process.env.CONFIG_PATH || resolve(process.cwd(), 'config.yaml')
  if (!existsSync(path)) return {}
  const data = parse(readFileSync(path, 'utf-8')) as AppConfig | null
  return data || {}
}

export function getAppConfig(): AppConfig {
  if (cached) return cached

  // Environment variables win so Docker Compose can run without a mounted file.
  const file = readConfigFile()
  const adminKey = (process.env.ADMIN_KEY || file.admin_key || '').trim()
  const apiKeys = process.env.API_KEYS
    ? normalizeApiKeys(process.env.API_KEYS)
    : normalizeApiKeys(file.api_keys)

  if (!adminKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'admin_key is missing. Set ADMIN_KEY or add admin_key to config.yaml'
    })
  }

  cached = { admin_key: adminKey, api_keys: apiKeys }
  return cached
}

export function resetAppConfigCache() {
  cached = null
}
