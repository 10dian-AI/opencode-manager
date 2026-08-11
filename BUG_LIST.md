# OpenCode Manager Bug 清单

本文档记录了项目中发现的所有bug及其修复状态。

## 高优先级 Bug

### 1. ❌ server/utils/accounts.ts:277-301 - 异步错误处理不完整
- **问题**：`refreshAccount` 中的错误已经在 catch 块中重新抛出，实际上已正确处理
- **影响**：无实际影响，误报
- **状态**：需要确认，代码检查显示 line 294 有 `throw error`

### 2. ✅ server/utils/proxy.ts:190-377 - 账号槽位资源泄漏
- **问题**：多个错误分支中，`readRawBody` 后如果出错，`releaseAccountSlot` 可能未调用
- **影响**：高并发下可能导致账号槽位耗尽
- **状态**：待修复

### 3. ✅ server/utils/opencode.ts:377-393 - 路由模块缓存失败后永久失效
- **问题**：`refreshRouteModuleCache` 失败后 `cache.refreshing` 置为 null，但 `cache.modules` 保持空数组
- **影响**：临时网络错误后路由模块缓存永久失效
- **状态**：待修复

### 4. ✅ server/utils/db.ts:634-665 - 账号槽位分配竞态条件
- **问题**：`tryAcquireAccountProxySlot` 使用 `ON CONFLICT DO UPDATE` 但 WHERE 条件存在 TOCTOU
- **影响**：高并发下可能超额分配槽位
- **状态**：待修复

### 5. ✅ server/utils/db.ts:345-350 - 数据库初始化竞态条件
- **问题**：`getDb()` 错误处理后重置 `readyPromise`，多个并发调用可能导致竞态
- **影响**：并发初始化失败时可能导致部分调用得不到错误信息
- **状态**：待修复

## 中优先级 Bug

### 6. ✅ server/utils/accounts.ts:329-376 - 推广奖励循环无限循环风险
- **问题**：最多尝试 20 次，但如果 `attemptedRewards.size` 逻辑异常可能无限循环
- **影响**：极端情况下可能卡死
- **状态**：待修复

### 7. ✅ server/routes/v1/chat/completions.post.ts:2-4 - 缺少顶层错误处理
- **问题**：未包装 try-catch，依赖内部错误处理
- **影响**：异常可能返回非标准错误格式
- **状态**：待修复

### 8. ✅ server/utils/proxy.ts:269-306 - 流式响应日志可能丢失
- **问题**：`logCallCompletion` 异步但未 await
- **影响**：进程退出时可能丢失调用日志
- **状态**：待修复

### 9. ✅ server/utils/opencode.ts:527-562 - Stripe API 版本硬编码
- **问题**：版本硬编码导致首次请求可能失败
- **影响**：首次取消订阅可能失败
- **状态**：待修复

### 10. ✅ server/utils/account-fetch.ts:72-79 - 代理连接关闭未等待
- **问题**：`void` 掉了 close Promise，可能导致连接未正确关闭
- **影响**：资源泄漏
- **状态**：待修复

### 11. ✅ server/utils/accounts.ts:495-514 - 状态更新失败吞噬错误
- **问题**：`updateAccount` 失败会吞噬原始错误
- **影响**：调试困难
- **状态**：待修复

### 12. ✅ server/api/accounts/bulk.post.ts:9-17 - 批量操作顺序依赖问题
- **问题**：依赖数据库返回顺序可能导致操作错位
- **影响**：批量操作可能应用到错误账号
- **状态**：待修复

## 低优先级 Bug

### 13. ✅ server/utils/db.ts:192-195 - 连接池错误未记录
- **问题**：错误事件监听器为空函数
- **影响**：调试困难
- **状态**：待修复

### 14. ✅ server/utils/proxy-worker-pool.ts:6-34 - Queue key 溢出风险
- **问题**：`nextKey` 无限增长可能溢出
- **影响**：长期运行后可能异常
- **状态**：待修复

### 15. ✅ app/composables/useAccounts.ts:210 - 浏览器兼容性
- **问题**：未检查 `crypto.randomUUID` 是否存在
- **影响**：旧浏览器可能报错
- **状态**：待修复

### 16. ✅ server/utils/opencode.ts:141-172 - 重试逻辑最后无延迟
- **问题**：最后一次重试失败后直接抛出
- **影响**：性能次优
- **状态**：待修复

### 17. ✅ server/utils/accounts.ts:183-194 - 并发任务分配不均
- **问题**：共享 cursor 可能导致任务分配不均
- **影响**：性能次优但不影响正确性
- **状态**：待修复

### 18. ✅ server/utils/ip-pool.ts:224-267 - 代码可读性
- **问题**：边界条件注释不清晰
- **影响**：仅可读性
- **状态**：待修复

### 19. ✅ server/utils/auth.ts:34 - 代码可读性
- **问题**：依赖隐式类型转换
- **影响**：仅可读性
- **状态**：待修复

### 20. ✅ app/pages/accounts.vue:210-224 - 编辑弹窗竞态
- **问题**：异步间隙 `editing.value` 可能改变
- **影响**：极端情况显示错误账号 cookie
- **状态**：待修复

### 21. ✅ server/utils/call-logs.ts:56-68 - Schema 初始化重复调用
- **问题**：无锁保护可能重复调用
- **影响**：仅性能影响
- **状态**：待修复

---

**统计**：
- 总计：21 个 bug
- 高优先级：5 个
- 中优先级：7 个  
- 低优先级：9 个
- 已修复：0 个
- 待修复：21 个
