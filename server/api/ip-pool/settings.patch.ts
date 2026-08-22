export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const body = await readBody<{
    block_size?: unknown
    threshold_ms?: unknown
    check_url?: unknown
  }>(event)
  const startedAt = Date.now()
  try {
    const blockSizeInput = Number(body?.block_size)
    if (!Number.isInteger(blockSizeInput) || blockSizeInput < 1 || blockSizeInput > 1000) {
      throw createError({ statusCode: 400, statusMessage: '每块账号数必须是 1-1000 之间的整数' })
    }
    const healthSettings = await setProxyHealthSettings({
      threshold_ms: body?.threshold_ms,
      check_url: body?.check_url
    })
    const blockSize = await setIpPoolBlockSize(blockSizeInput)
    const changes = await ensureStableIpAssignments()
    const result = {
      block_size: blockSize,
      threshold_ms: healthSettings.threshold_ms,
      check_url: healthSettings.check_url,
      assigned: changes.length,
      assignment_changes: changes
    }
    await logOperation({
      operation: 'ip_pool_settings_update',
      trigger_type: 'manual',
      status: 'success',
      detail: `IP 池设置已保存：每块 ${blockSize} 个账号，延迟阈值 ${healthSettings.threshold_ms}ms`,
      request_detail: body,
      response_detail: result,
      duration_ms: Date.now() - startedAt
    })
    return result
  } catch (error: any) {
    const message = error?.statusMessage || (error instanceof Error ? error.message : '设置无效')
    await logOperation({
      operation: 'ip_pool_settings_update',
      trigger_type: 'manual',
      status: 'error',
      detail: 'IP 池设置保存失败',
      error_message: message,
      request_detail: body,
      response_detail: error,
      duration_ms: Date.now() - startedAt
    })
    if (error?.statusCode) throw error
    throw createError({
      statusCode: 400,
      statusMessage: message
    })
  }
})
