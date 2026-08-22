export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const startedAt = Date.now()
  const accountsBefore = new Map((await listAccounts()).map(account => [account.id, {
    name: account.name,
    ip_pool_id: account.ip_pool_id
  }]))
  try {
    const changes = await ensureStableIpAssignments()
    const result = {
      changed: changes.length,
      assigned: changes.filter(change => change.ipPoolId !== null).length,
      unassigned: changes.filter(change => change.ipPoolId === null).length
    }
    await logOperation({
      operation: 'ip_pool_assign',
      trigger_type: 'manual',
      status: 'success',
      detail: changes.length ? `已更新 ${changes.length} 个账号的代理绑定` : '账号代理绑定已经稳定，无需变更',
      request_detail: { action: 'ensure_stable_ip_assignments' },
      response_detail: {
        ...result,
        assignment_changes: changes.map(change => ({
          account_id: change.accountId,
          account_name: accountsBefore.get(change.accountId)?.name ?? null,
          from_ip_pool_id: accountsBefore.get(change.accountId)?.ip_pool_id ?? null,
          to_ip_pool_id: change.ipPoolId
        }))
      },
      duration_ms: Date.now() - startedAt
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : '绑定失败'
    await logOperation({
      operation: 'ip_pool_assign',
      trigger_type: 'manual',
      status: 'error',
      detail: '账号代理绑定失败',
      error_message: message,
      request_detail: { action: 'ensure_stable_ip_assignments' },
      response_detail: error,
      duration_ms: Date.now() - startedAt
    })
    throw error
  }
})
