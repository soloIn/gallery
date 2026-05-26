# 115 Gallery Worker

[![Deploy to Cloudflare](https://github.com/soloIn/gallery/actions/workflows/deploy.yml/badge.svg)](https://github.com/soloIn/gallery/actions/workflows/deploy.yml)

基于 115 云存储的图片画廊，部署在 Cloudflare Workers 上。

## 一键部署

Fork 本仓库后，通过 GitHub Actions 自动创建所有 Cloudflare 资源并部署。

### 1. Fork 仓库

点击页面右上角 **Fork** 按钮，将仓库复制到你的 GitHub 账号。

### 2. 配置 GitHub Secrets

进入 Fork 后的仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加以下 Secrets：

| Secret | 必填 | 说明 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | 是 | Cloudflare API Token（需要 Workers、D1、KV 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare 账号 ID（Dashboard 右侧边栏） |
| `ADMIN_PASS` | 是 | 管理员登录密码 |

> **获取 API Token**: Cloudflare Dashboard → My Profile → API Tokens → Create Token → 使用 **Edit Cloudflare Workers** 模板

### 3. 触发部署

进入仓库 **Actions** 页面 → 左侧选择 **Deploy to Cloudflare Workers** → **Run workflow** → **Run workflow**。

首次运行自动完成：
- 创建 D1 数据库 `gallery-db` + 3 个 KV 命名空间（`gallery-KV_CONFIG`、`gallery-KV_TOKEN`、`gallery-KV_SESSION`）
- 执行数据库迁移
- 设置密钥
- 部署 Worker

### 4. 部署后

访问 `https://gallery.<你的子域>.workers.dev/`，使用 `ADMIN_PASS` 登录。在管理面板中配置 115 Client ID/Secret，连接 115 账号并添加目录。

## 技术栈

- **运行时**: Cloudflare Workers（边缘计算）
- **框架**: Hono（轻量 Web 框架）
- **数据库**: D1（Cloudflare SQLite）
- **缓存/状态**: KV（Cloudflare 键值存储）
- **认证**: Cookie 会话（管理面板）+ API Token（公开 API）+ 115 OAuth 2.0

## 项目结构

```
gallery/
├── src/
│   ├── index.ts              # 入口（fetch + 定时任务）
│   ├── config.ts             # 管理配置（KV 存储）
│   ├── db/
│   │   ├── schema.sql        # D1 表定义
│   │   └── queries.ts        # 数据库查询
│   ├── middleware/
│   │   ├── auth.ts           # 会话认证
│   │   ├── api-auth.ts       # API Token 认证
│   │   └── ratelimit.ts      # 令牌桶、熔断器、退避重试
│   ├── routes/
│   │   ├── admin.ts          # 管理接口（目录、同步、设置、Token）
│   │   ├── auth.ts           # 115 OAuth 登录/回调/状态
│   │   └── gallery.ts        # 公开图片 API
│   ├── services/
│   │   ├── cache.ts          # KV 缓存（防缓存击穿）
│   │   ├── eleven5.ts        # 115 API 客户端（OAuth、文件列表、下载）
│   │   └── image-index.ts    # 同步引擎（递归目录爬取）
│   └── utils/
│       ├── crypto.ts         # PBKDF2 密码哈希、UUID 生成
│       └── types.ts          # TypeScript 类型定义
├── public/
│   ├── index.html            # Admin SPA
│   ├── app.js                # 前端逻辑
│   └── style.css             # 深色主题 UI
├── test/                     # Vitest 测试
├── wrangler.toml             # Cloudflare Workers 配置
├── vitest.config.ts          # 测试配置（D1/KV 绑定）
└── package.json
```

## 前置要求

- Node.js 25+
- npm
- Cloudflare 账号（用于部署）
- 115 开放平台应用凭证（用于云存储集成）

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 初始化本地数据库

Wrangler 会自动为开发环境创建本地 D1 和 KV 实例。

```bash
npm run db:migrate:local
```

### 3. 配置环境变量

在项目根目录创建 `.dev.vars` 文件（已在 `.gitignore` 中）：

```
ADMIN_PASS=你的管理员密码
```

### 4. 启动开发服务器

```bash
npm run dev
```

服务启动后访问 `http://localhost:8787`，使用 ADMIN_PASS 登录管理面板。在管理面板中配置 115 Client ID/Secret。

### 5. 运行测试

```bash
# 一次性运行
npm test

# 监听模式
npm run test:watch

# 仅类型检查
npm run typecheck
```

## 部署到 Cloudflare

提供三种部署方式：一键部署（推荐）、CLI 命令行部署和网页控制台部署。

---

### 方式零：一键部署（推荐）

Fork 仓库 → 添加 GitHub Secrets → 在 Actions 页面触发部署。详见上方 [一键部署](#一键部署) 章节。

---

### 方式一：CLI 命令行部署

#### 1. 登录 Cloudflare

```bash
npx wrangler login
```

#### 2. 创建 Cloudflare 资源

```bash
# 创建 D1 数据库
wrangler d1 create gallery

# 创建 KV 命名空间
wrangler kv namespace create KV_CONFIG
wrangler kv namespace create KV_TOKEN
wrangler kv namespace create KV_SESSION
```

#### 3. 更新 wrangler.toml

将 `wrangler.toml` 中的 `placeholder` 替换为上一步获取的真实资源 ID。

#### 4. 执行远程数据库迁移

```bash
npm run db:migrate
```

#### 5. 设置密钥

```bash
wrangler secret put ADMIN_PASS
```

#### 6. 部署

```bash
npm run deploy
```

---

### 方式二：Cloudflare 网页控制台部署

如果不想使用命令行，也可以直接在 Cloudflare Dashboard 中完成所有操作。

#### 1. 创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单选择 **Workers & Pages**
3. 点击 **Create Application** → **Create Worker**
4. 输入 Worker 名称（如 `gallery`），点击 **Deploy**
5. 先使用默认代码，后续会替换

#### 2. 创建 D1 数据库

1. 左侧菜单选择 **Workers & Pages** → **D1**
2. 点击 **Create Database**
3. 数据库名称输入 `gallery`，点击 **Create**
4. 记录数据库 ID（在数据库详情页可以看到）

#### 3. 创建 KV 命名空间

1. 左侧菜单选择 **Workers & Pages** → **KV**
2. 分别创建三个命名空间：
   - `KV_CONFIG`
   - `KV_TOKEN`
   - `KV_SESSION`
3. 记录每个命名空间的 ID

#### 4. 执行数据库迁移

1. 进入 D1 数据库 `gallery` 的详情页
2. 点击 **Console** 标签
3. 将 `src/db/schema.sql` 的内容粘贴进去，点击 **Execute**

#### 5. 配置 Worker 绑定

1. 进入 Worker 详情页，点击 **Settings** → **Variables**
2. **KV Namespace Bindings** — 添加三个绑定：
   - 变量名 `KV_CONFIG`，选择命名空间 `KV_CONFIG`
   - 变量名 `KV_TOKEN`，选择命名空间 `KV_TOKEN`
   - 变量名 `KV_SESSION`，选择命名空间 `KV_SESSION`
3. **D1 Database Bindings** — 添加一个绑定：
   - 变量名 `DB`，选择数据库 `gallery`
4. **Secrets** — 点击 **Add Secret**，添加：
   - `ADMIN_PASS` = 你的管理员密码

#### 6. 上传代码

```bash
npm install -g wrangler
wrangler login
npm run deploy
```

#### 7. 配置定时触发器（可选）

1. 进入 Worker 详情页 → **Settings** → **Triggers**
2. 在 **Cron Triggers** 中添加：`0 */6 * * *`（每 6 小时自动同步）

---

### 部署后：配置和使用

无论使用哪种部署方式，部署完成后：

1. 访问 `https://<你的-worker>.workers.dev/`
2. 使用 ADMIN_PASS 登录
3. 在 **115 Configuration** 中填写 Client ID 和 Client Secret
4. 点击 **Connect 115 Account** 完成 OAuth 授权
5. 在 **Gallery Directories** 中添加 115 目录 ID
6. 点击 **Sync Now** 或等待定时任务自动同步

## 配置说明

### 管理设置（通过管理面板或 API）

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `sync_interval` | `0 */6 * * *` | 自动同步的 Cron 表达式 |
| `rate_limit_rps` | `3` | 对 115 API 的每秒请求数限制 |
| `circuit_breaker_threshold` | `3` | 触发熔断的连续失败次数 |
| `eleven5_client_id` | `""` | 115 开放平台应用 Client ID |
| `eleven5_client_secret` | `""` | 115 开放平台应用 Client Secret |

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ADMIN_PASS` | 是 | 管理员登录密码（存储为 PBKDF2 哈希） |

## API 参考

### 公开接口（需要 API Token）

在管理面板的 **API Tokens** 区域生成 Token，通过 `Authorization: Bearer <token>` 请求头传入。

```bash
# 示例
curl -H "Authorization: Bearer glt_xxxx" https://<your-worker>.workers.dev/api/image/next?client=my_client
```

| 接口 | 说明 |
|------|------|
| `GET /api/image/next?client={id}` | 获取下一张图片（顺序） |
| `GET /api/image/random?client={id}` | 获取随机未看过图片 |
| `GET /api/image/meta?client={id}` | 获取画廊元数据 |

### 管理接口（需要会话）

| 接口 | 说明 |
|------|------|
| `POST /admin/login` | 登录，返回会话 Cookie |
| `POST /admin/logout` | 登出 |
| `GET /admin/me` | 检查会话状态 |
| `GET /admin/directories` | 列出已配置目录 |
| `POST /admin/directories` | 添加目录（会验证 115 API） |
| `DELETE /admin/directories/:id` | 删除目录及其图片 |
| `GET /admin/browse?cid={id}` | 浏览 115 目录树 |
| `POST /admin/sync` | 触发手动同步（异步） |
| `GET /admin/settings` | 获取配置 |
| `PUT /admin/settings` | 更新配置 |
| `GET /admin/tokens` | 列出 API Token |
| `POST /admin/tokens` | 生成新 API Token |
| `DELETE /admin/tokens/:token` | 删除 API Token |

### OAuth 接口

| 接口 | 说明 |
|------|------|
| `GET /auth/115/login` | 发起 115 OAuth 流程（需要管理认证） |
| `GET /auth/115/callback` | OAuth 回调（需要管理认证） |
| `GET /auth/115/status` | 检查 115 连接状态 |

## 架构说明

- **限流**: 内存令牌桶（3 rps，突发 5）+ KV 熔断器（60s 内 3 次失败触发熔断）
- **并发**: Promise 信号量（最多 10 个并发 115 请求）
- **缓存**: KV 缓存目录列表（5 分钟）和下载链接（30 分钟）
- **Token 刷新**: 过期前 5 分钟自动刷新，带并发刷新保护
- **同步**: 递归目录爬取（带环检测）、批量 D1 写入、过期图片清理
- **客户端状态**: 每客户端顺序索引（顺序模式）或非重复已看列表（随机模式），带乐观并发控制
