# OpenCode Manager

项目仓库：https://github.com/10dian-ai/opencode-manager

Nuxt UI 全栈号池管理：PostgreSQL 存储账号，通过浏览器 Cookie 自动抓取 OpenCode SSR 页面解析 workspace / 用量。

## 功能

- Admin Key 登录（读取 `config.yaml`）
- 号池 CRUD：粘贴 auth cookie 自动同步
- 出口 IP 池：HTTP/HTTPS/SOCKS5 代理批量导入、连通性检测、稳定分块绑定与面板管理
- 解析 workspace、邮箱、滚动/周/月用量、推荐码
- 单号刷新 / 全部刷新
- OpenAI 兼容的 `/v1/models`、`/v1/chat/completions`（支持流式透传）
- 使用内存轮询号池，单次请求只访问一个上游账户；workspace 页面遇到 408、429、5xx 或网络超时会有限重试
- 支持单号或全量风控检测；普通代理请求的 401/403 只会清理失效 Key，不再自动判定封禁
- 支持手动使用推广收益；自动使用默认关闭，可通过环境变量显式开启
- 支持手动关闭续费；自动关闭续费默认关闭，可通过环境变量显式开启
- 额度耗尽自动禁用并在窗口释放后恢复，会员过期自动禁用
- 记录三个额度窗口的绝对刷新节点，按节点自动刷新
- 可在「号池」开启或关闭 `error` 账号自动重试，开启后默认每 5 分钟重试一次
- 非会员筛选与批量删除
- 按滚动 $12、每周 $30、每月 $60 统计金额

## 配置

```yaml
# config.yaml
admin_key: "admin123"
api_keys:
  - "sk-ocm-your-client-key"
```

也可以用环境变量代替 `config.yaml`（容器部署推荐，环境变量优先级更高）：

```bash
ADMIN_KEY=admin123
# 多个客户端密钥用逗号分隔
API_KEYS=sk-ocm-key-1,sk-ocm-key-2
```

也可以登录后台后，在「API 密钥」页面创建或删除对外访问密钥。网页创建的密钥只在创建成功时显示一次，服务端仅保存 SHA-256 摘要。

### 数据库

```bash
# 完整连接串，设置后优先生效
DATABASE_URL=postgres://opencode:opencode@postgres:5432/opencode_manager

# 或者分字段配置（Compose 用的就是这组）
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=opencode
POSTGRES_PASSWORD=change-me
POSTGRES_DB=opencode_manager

# 可选：连接池与超时
POSTGRES_POOL_MAX=20
POSTGRES_LOCK_POOL_MAX=20
POSTGRES_IDLE_TIMEOUT_MS=30000
POSTGRES_CONNECT_TIMEOUT_MS=10000
# 托管数据库需要 SSL 时设为 true；默认验证服务端证书
DATABASE_SSL=false
# 私有 CA 可直接传 PEM 内容；仅临时排障时才关闭验证
DATABASE_SSL_CA=
DATABASE_SSL_REJECT_UNAUTHORIZED=true
# 仅在可信反向代理后开启，用于读取 X-Forwarded-For / Proto
TRUST_PROXY=false
```

表结构在首次连接时自动创建，使用 advisory lock 避免多实例同时启动时的 DDL 竞争。

代理默认从 4 个可复用流式工作槽开始，根据排队量自动扩容到 32；服务端每秒检测 CPU 与事件循环延迟，负载过高时自动收缩。单个官方账号默认最多同时处理 2 个代理请求，避免少量账号承受过高并发。等待队列固定为 8192，队列满后直接返回 `503`，防止无限占用内存。可通过环境变量调整：

```bash
PROXY_MIN_WORKERS=4
PROXY_MAX_WORKERS=32
PROXY_QUEUE_LIMIT=8192
PROXY_ACCOUNT_CONCURRENCY=2
# 以下操作会修改官方账号状态，默认关闭
AUTO_APPLY_REFERRAL_REWARDS=false
AUTO_CANCEL_SUBSCRIPTION_RENEWAL=false
# 风控检测使用的最小探测模型（默认 glm-5.2）
RISK_CONTROL_CHECK_MODEL=glm-5.2
```

旧的 `PROXY_WORKERS` 仍可作为最小工作槽数量使用。扩容采用渐进方式；CPU 达到 85% 或事件循环延迟达到 200ms 时停止扩容并收缩 25%，空闲 30 秒后也会逐步回落。

## 开发

```bash
bun install

# 本地起一个 PostgreSQL（开发用，映射到宿主机 5432）
docker run -d --name ocm-pg -p 5432:5432 \
  -e POSTGRES_USER=opencode \
  -e POSTGRES_PASSWORD=opencode \
  -e POSTGRES_DB=opencode_manager \
  postgres:17-alpine

export DATABASE_URL=postgres://opencode:opencode@127.0.0.1:5432/opencode_manager
export ADMIN_KEY=admin123
bun run dev
```

打开 http://localhost:3000 ，使用 `admin_key` 登录。

## 添加账号

1. 浏览器登录 https://opencode.ai
2. DevTools → Application → Cookies → 找到 `auth`
3. 只复制 `auth={value}` 中的 `value` 部分，不要复制 `auth=`
4. 后台「号池」→ 添加账号 → 每行粘贴一个 value，可批量添加

输入仅接受纯 auth Cookie value，不会从完整 Cookie、`auth=` 前缀或其他键值中兼容提取。旧数据库中的完整 Cookie 会在启动时一次性迁移为纯 value。

## IP 池

在后台「IP 池」页面可以批量添加 `http://user:pass@host:port`、`socks5://user:pass@host:port`、`socks5h://host:port`、`host:port` 或 `host:port:user:pass` 格式的出口代理；`sk5://` 会兼容转换为 `socks5://`。代理凭据仅保存在服务端，管理接口会隐藏密码。

账号绑定会持久化到 PostgreSQL。新账号按设置的块大小分配给当前绑定数最少的可用代理；新增代理不会改变已有账号出口。只有停用或删除代理时，系统才会迁移该代理上的账号；没有可用代理时保持原有直连行为。账号同步、推荐奖励、订阅操作和 `/v1` 聊天转发都会使用同一绑定出口。

系统流程：

1. `GET https://opencode.ai/auth`（携带 Cookie）→ `Location: /workspace/wrk_xxx`
2. `GET /workspace/{id}/go` → 解析 SSR hydration 数据

## 数据

- PostgreSQL：账号、会话、API 密钥、IP 池与设置全部存库，应用本身不再写本地文件
- Compose 部署时数据保存在 `postgres-data` 命名卷里
- Cookie 仅存服务端；账号列表和通用详情不回传 `auth_cookie`，编辑页通过管理员鉴权的禁缓存接口按需读取

## API

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/auth/login` | `{ key }` |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 会话检查 |
| GET | `/api/accounts` | 列表 |
| POST | `/api/accounts` | 单个账号：`{ name?, auth_cookie }`，`auth_cookie` 仅接受纯 value |
| POST | `/api/accounts/batch` | 批量账号：`{ name?, auth_cookie_values }`，按行分隔纯 value |
| PATCH | `/api/accounts/:id` | 更新 |
| GET | `/api/accounts/:id/auth-cookie` | 管理员编辑时读取当前纯 auth value（禁缓存） |
| DELETE | `/api/accounts/:id` | 删除 |
| POST | `/api/accounts/:id/refresh` | 刷新单号 |
| POST | `/api/accounts/refresh-all` | 刷新全部 |
| POST | `/api/accounts/:id/risk-control-check` | 单号风控检测，命中后自动禁用 |
| POST | `/api/accounts/risk-control/check-all` | 检测全部可用或待复检的风控账号 |
| GET / PATCH | `/api/settings/account-refresh` | 查询 / 设置 error 账号自动重试开关 |
| GET | `/api/stats` | 统计 |
| GET | `/api/api-keys` | 对外 API 密钥列表（仅显示掩码） |
| POST | `/api/api-keys` | 创建对外 API 密钥 |
| DELETE | `/api/api-keys/:id` | 删除网页创建的密钥 |
| DELETE | `/api/accounts/non-members` | 删除全部非会员账号 |
| GET / POST | `/api/ip-pool` | IP 池列表 / 批量添加代理 |
| PATCH / DELETE | `/api/ip-pool/:id` | 编辑、启停 / 删除代理 |
| POST | `/api/ip-pool/:id/test` | 检测代理出口 IP |
| PATCH | `/api/ip-pool/settings` | 设置自动分块大小 |
| POST | `/api/ip-pool/assign` | 补齐缺失或失效的账号绑定 |
| GET | `/v1/models` | OpenAI 兼容模型列表 |
| POST | `/v1/chat/completions` | OpenAI 兼容聊天接口 |

OpenAI 客户端配置：

```text
Base URL: http://localhost:3030/v1
API Key: API_KEYS 环境变量、config.yaml 或网页创建的密钥
```

## Docker Compose 部署

推荐方式，一条命令拉起应用 + PostgreSQL：

```bash
cp .env.example .env
# 至少改掉 ADMIN_KEY 和 POSTGRES_PASSWORD
docker compose up -d
```

打开 http://localhost:3030 登录。常用操作：

```bash
docker compose logs -f app     # 查看日志
docker compose down            # 停止（保留数据）
docker compose down -v         # 停止并删除数据卷，会清空数据库
```

`docker-compose.yml` 说明：

- 宿主端口默认 `3030`，容器内部固定 `3000`。改端口只需在 `.env` 里设 `APP_PORT`，不用动 compose 文件
- `postgres` 使用 `pg_isready` 健康检查，`app` 通过 `depends_on: service_healthy` 等数据库就绪后再启动，避免首次启动建表失败
- 数据库不对外映射端口，只在内部网络暴露；本地开发想直连可自行加 `ports`
- 数据存放在 `postgres-data` 命名卷
- 应用以非 root 的 `bun` 用户运行，配置全部走环境变量，不需要挂载 `config.yaml`

默认直接拉取已发布的镜像 `ghcr.io/10dian-ai/opencode-manager:latest`。更新镜像并重建容器：

```bash
docker compose pull app
docker compose up -d
```

想用本地源码构建，可直接使用仓库中的 `Dockerfile`：

```bash
docker build -t opencode-manager:local .
```

### 单独运行容器

自备 PostgreSQL 时：

```bash
docker run -d \
  --name opencode-manager \
  -p 3030:3000 \
  -e ADMIN_KEY=your-admin-key \
  -e DATABASE_URL=postgres://opencode:opencode@your-host:5432/opencode \
  ghcr.io/10dian-ai/opencode-manager:latest
```

生产服务也可以使用 Node.js 20–26 启动：

```bash
node .output/server/index.mjs
```

Nitro 构建显式使用 `node-server` preset，数据库层通过 `pg` 连接池访问 PostgreSQL，`pg` 是纯 JavaScript 实现，不需要原生编译，Bun 和 Node 运行时都能直接加载。

推送到 `master` 会发布 `master`、`latest` 和提交 SHA 标签；推送 `v*.*.*` 标签会额外发布对应的语义版本标签。当前工作流由 GitHub 的 Ubuntu Runner 使用 Buildx 构建并发布镜像。
