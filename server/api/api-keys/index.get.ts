import { getAppConfig } from '~/server/utils/config'
import { listManagedApiKeys, apiKeyPrefix } from '~/server/utils/api-keys'

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const configKeys = getAppConfig().api_keys.map((key, index) => ({
    id: `config-${index}`,
    name: `config.yaml #${index + 1}`,
    prefix: apiKeyPrefix(key),
    source: 'config' as const,
    created_at: null
  }))
  const managedKeys = (await listManagedApiKeys()).map(key => ({
    id: String(key.id),
    name: key.name,
    prefix: key.key_prefix,
    source: 'web' as const,
    created_at: key.created_at
  }))
  return [...configKeys, ...managedKeys]
})
