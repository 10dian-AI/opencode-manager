import { enableAccountChineseModels } from '../../utils/accounts'

export default defineEventHandler(async (event) => {
  await requireAuth(event)

  const body = await readBody<{ account_id?: unknown }>(event)
  const accountId = Number(body?.account_id)
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'account_id is required' })
  }

  const account = await enableAccountChineseModels(accountId)
  return {
    success: true,
    message: '已成功开启中国模型支持',
    account: toPublicAccount(account)
  }
})
