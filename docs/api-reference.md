# API 参考文档

## 认证方式

所有管理接口均需认证。通过以下方式获取 session token：

```bash
curl -s -c cookies.txt -X POST http://localhost:3030/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"key": "your-admin-key"}'
```

后续请求携带 cookie：

```bash
curl -s -b cookies.txt http://localhost:3030/api/accounts
```

或使用对外 API 密钥（仅限 `/v1/*` 路径）：

```bash
curl -H "Authorization: Bearer sk-ocm-your-key" http://localhost:3030/v1/models
```

---

## POST /api/accounts/add

添加单个账号。

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `auth_cookie` | string | 是 | OpenCode 的 auth cookie 纯 value（不含 `auth=` 前缀） |
| `name` | string | 否 | 账号备注名 |
| `workspace_id` | string | 否 | 指定 workspace ID |
| `workspace_name` | string | 否 | workspace 名称 |

### 响应

```json
{
  "success": true,
  "account": {
    "id": 42,
    "name": "我的账号",
    "email": null,
    "workspace_id": null,
    "status": "pending",
    "subscription_status": null,
    "balance": null,
    "rolling_usage": null,
    "has_upstream_api_key": false,
    "created_at": "2026-08-14T13:00:00.000Z",
    "updated_at": "2026-08-14T13:00:00.000Z"
  },
  "message": "账号添加成功"
}
```

账号创建后状态为 `pending`，后台会立即触发一次刷新将其更新为 `active` 或 `error`。首次刷新成功后会异步执行：取消自动续费（如有订阅）和开启中国模型。

### 错误响应

| 状态码 | 说明 |
|--------|------|
| 400 | `auth_cookie` 字段缺失或格式错误 |
| 409 | 该 Cookie 已存在 |
| 500 | 服务器内部错误 |

### curl 示例

```bash
curl -s -b cookies.txt -X POST http://localhost:3030/api/accounts/add \
  -H "Content-Type: application/json" \
  -d '{
    "auth_cookie": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "name": "我的账号"
  }'
```

---

## GET /api/accounts/status

获取所有账号的状态摘要，含可用性、额度和冷却时间信息。

### 响应

```json
{
  "total": 10,
  "active": 6,
  "accounts": [
    {
      "id": 42,
      "name": "账号 #42",
      "status": "active",
      "subscription_status": "active",
      "is_available": true,
      "disabled_reason": null,
      "cooldown_seconds": 0,
      "remaining_quota": 18.5,
      "rolling_usage": 6.5,
      "rolling_reset_at": "2026-08-14T18:00:00.000Z",
      "weekly_usage": 30.2,
      "weekly_reset_at": "2026-08-17T00:00:00.000Z"
    }
  ]
}
```

### 响应字段说明

| 字段 | 说明 |
|------|------|
| `total` | 账号总数 |
| `active` | 当前可用于代理的账号数（status=active 且有 upstream_api_key） |
| `accounts[].is_available` | 是否可用于代理请求（active + 订阅有效 + 有 API Key） |
| `accounts[].disabled_reason` | 禁用原因：`manual`、`auth_expired`、`expired`、`quota:rolling` 等 |
| `accounts[].cooldown_seconds` | 额度恢复前的剩余秒数（仅 quota 禁用时有值） |
| `accounts[].remaining_quota` | 预估剩余可用额度（USD），取 5h 与周限制的最小值 |
| `accounts[].rolling_usage` | 当前滚动窗口已用额度（USD） |

### curl 示例

```bash
curl -s -b cookies.txt http://localhost:3030/api/accounts/status
```

---

## GET /api/logs

获取操作日志列表，支持分页和筛选。

### 查询参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `limit` | number | 50 | 每页条数，最大 500 |
| `offset` | number | 0 | 偏移量 |
| `operation` | string | - | 按操作类型筛选 |
| `status` | string | - | 按状态筛选：`success`、`error`、`partial` |

可用的 `operation` 值：`add_account`、`refresh_account`、`enable_chinese_models`、`disable_chinese_models`、`cancel_renewal`、`use_referral_reward`、`risk_control_check`

### 响应

```json
{
  "logs": [
    {
      "id": 123,
      "operation": "add_account",
      "trigger_type": "api",
      "account_id": 42,
      "account_ids": null,
      "status": "success",
      "detail": null,
      "error_message": null,
      "duration_ms": 312,
      "created_at": "2026-08-14T13:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

### curl 示例

```bash
# 获取最近日志
curl -s -b cookies.txt "http://localhost:3030/api/logs?limit=20"

# 筛选失败的取消续费操作
curl -s -b cookies.txt "http://localhost:3030/api/logs?operation=cancel_renewal&status=error"
```
