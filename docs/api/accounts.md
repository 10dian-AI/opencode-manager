# Accounts API

All endpoints require admin authentication via session cookie or `Authorization` header.

## Authentication

Login first to obtain a session cookie:

```http
POST /api/auth/login
Content-Type: application/json

{ "key": "<admin_key>" }
```

Response sets a `session` cookie used for subsequent requests.

---

## POST /api/accounts/add

Add a single account by auth cookie.

### Request

```http
POST /api/accounts/add
Content-Type: application/json
Cookie: session=<token>
```

```json
{
  "auth_cookie": "eyJhbGci...",
  "name": "optional display name",
  "workspace_id": "wrk_xxx",
  "workspace_name": "My Workspace"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `auth_cookie` | string | yes | Raw auth cookie value (not `auth=value`, just the value) |
| `name` | string | no | Display name for the account |
| `workspace_id` | string | no | Workspace ID (auto-detected on first refresh) |
| `workspace_name` | string | no | Workspace name |

### Response

**201 Created**

```json
{
  "success": true,
  "account": {
    "id": 42,
    "name": "optional display name",
    "email": null,
    "workspace_id": null,
    "status": "pending",
    "created_at": "2026-08-14T13:00:00.000Z"
  },
  "message": "账号添加成功"
}
```

**409 Conflict** — cookie already exists

```json
{ "statusCode": 409, "statusMessage": "该 Cookie 已存在" }
```

**400 Bad Request** — missing or invalid auth_cookie

```json
{ "statusCode": 400, "statusMessage": "auth_cookie is required" }
```

---

## POST /api/accounts

Add a single account (alternative endpoint, blocks until refresh completes).

### Request

```json
{
  "auth_cookie": "eyJhbGci...",
  "name": "optional display name",
  "refresh": true
}
```

Setting `refresh: false` skips the initial sync and returns immediately.

### Response

Returns the `AccountPublic` object directly (no wrapper).

---

## POST /api/accounts/batch

Batch import accounts (newline-separated cookie values).

### Request

```json
{
  "name": "optional shared name",
  "auth_cookie_values": "cookie1\ncookie2\ncookie3",
  "operation_id": "optional-uuid-for-progress-polling"
}
```

### Response

```json
{
  "created": 3,
  "synchronized": 3,
  "failed": 0,
  "accounts": [ ...AccountPublic[] ]
}
```

---

## GET /api/accounts/status

Returns availability and quota status for all accounts.

### Request

```http
GET /api/accounts/status
Cookie: session=<token>
```

### Response

```json
{
  "total": 10,
  "active": 7,
  "accounts": [
    {
      "id": 42,
      "name": "Account 1",
      "status": "active",
      "subscription_status": "active",
      "is_available": true,
      "disabled_reason": null,
      "cooldown_seconds": 0,
      "remaining_quota": 18.5,
      "rolling_usage": 6.5,
      "rolling_reset_at": "2026-08-14T18:00:00.000Z",
      "weekly_usage": 12.0,
      "weekly_reset_at": "2026-08-18T00:00:00.000Z"
    }
  ]
}
```

| Field | Description |
|---|---|
| `total` | Total account count |
| `active` | Accounts available for proxying |
| `is_available` | `true` when active + member + has API key |
| `cooldown_seconds` | Seconds until quota window resets |
| `remaining_quota` | Estimated remaining quota in USD |
