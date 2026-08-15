export default defineEventHandler(async (event) => {
  await requireAuth(event)
  // 抛弃账号（风控命中 / 月限额用尽 / 手动标记）的完整列表，供折叠栏懒加载
  return (await listAccounts())
    .filter(account => account.is_abandoned)
    .map(toPublicAccount)
})
