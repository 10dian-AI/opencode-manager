import { toggleAccountChineseModels } from '../../utils/accounts'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody<{ account_id?: unknown, enable?: unknown }>(event)
  const accountId = Number(body?.account_id)
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'account_id is required' })
  }

  if (typeof body?.enable !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'enable (boolean) is required' })
  }
  const enable = body.enable
  const account = await toggleAccountChineseModels(accountId, enable)

  return {
    success: true,
    message: enable ? '已成功开启中国模型支持' : '已成功关闭中国模型支持',
    account: toPublicAccount(account)
  }
})
