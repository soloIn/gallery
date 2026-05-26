---
title: "feat: Admin Panel Consolidation & API Token Auth"
type: feat
status: completed
date: 2026-05-26
origin: docs/brainstorms/2026-05-26-admin-panel-and-api-auth.md
---

# Admin Panel Consolidation & API Token Auth

## Summary

将 115 云存储凭证从环境变量迁移到 admin 面板 KV 配置；为 `/api/*` 公开路由增加 Bearer token 认证；移除 gallery 前端只保留 admin SPA；设定 Node.js 25 要求并更新 README。共 5 个模块，19 条需求。

---

## Problem Frame

115 凭证通过 wrangler.toml vars 和 Cloudflare secret 管理，更换凭证需重新部署。公开 API 无认证。gallery 前端功能单一，与 admin 共存增加维护成本。

---

## Requirements

- R1. admin 面板可设置/更新 ELEVEN5_CLIENT_ID 和 ELEVEN5_CLIENT_SECRET
- R2. 凭证存储在 KV_CONFIG 的 `app:config` 中
- R3. eleven5.ts 从 KV_CONFIG 读取凭证
- R4-R7. 移除 Env 接口、wrangler.toml、provision.sh、deploy.yml 中的 ELEVEN5 相关配置
- R8. admin 面板新增 token 管理：生成/列出/删除
- R9. token 存 KV_CONFIG
- R10. `/api/*` 增加 Bearer token 认证中间件
- R11. 无 token 返回 401
- R12-R16. 移除 gallery 前端代码，保留 admin SPA
- R17-R18. Node.js 25 版本要求
- R19. README 同步更新

---

## Scope Boundaries

- 不修改 115 OAuth 流程（只改配置来源）
- 不修改 D1 schema
- 不修改 admin session 认证
- 不新增前端框架
- 不修改 cron 逻辑

---

## Key Technical Decisions

- token 和 115 凭证都存 KV_CONFIG 的 `app:config` 中：复用 `getConfig`/`updateConfig`，无需新存储
- API token 中间件独立于 session auth：两套认证体系互不干扰
- gallery 前端全部移除，admin SPA 简化为直接渲染（不再需要 hash 路由）

---

## Implementation Units

- U1. **扩展 AdminConfig 类型和设置 API**

**Goal:** 在 AdminConfig 中添加 115 凭证和 API token 字段，扩展 admin settings API

**Requirements:** R1, R2, R8, R9

**Dependencies:** None

**Files:**
- Modify: `src/utils/types.ts` — AdminConfig 接口添加 `eleven5_client_id`, `eleven5_client_secret`, `api_tokens` 字段
- Modify: `src/config.ts` — DEFAULT_CONFIG 添加新字段默认值
- Modify: `src/routes/admin.ts` — GET/PUT /settings 白名单添加新字段；新增 token CRUD 端点

**Approach:**
- AdminConfig 新增：`eleven5_client_id: string`、`eleven5_client_secret: string`、`api_tokens: string[]`
- GET /admin/settings 返回 115 配置（脱敏显示 secret）和 token 列表
- PUT /admin/settings 允许更新 115 凭证
- 新增端点：POST /admin/tokens（生成）、GET /admin/tokens（列出）、DELETE /admin/tokens/:token（删除）
- token 生成使用 `crypto.randomUUID()` + 短前缀

**Patterns to follow:**
- 现有 settings GET/PUT 白名单模式 (`src/routes/admin.ts:188-216`)
- `getConfig`/`updateConfig` 的 spread merge 模式 (`src/config.ts`)

**Test scenarios:**
- Happy path: PUT settings 更新 eleven5_client_id，GET 返回新值
- Happy path: POST /admin/tokens 生成 token，GET 列出包含该 token，DELETE 删除后列表为空
- Edge case: PUT settings 只更新部分字段，其他不变
- Error path: POST /admin/tokens 未认证返回 401

**Verification:**
- `AdminConfig` 类型包含新字段，settings API 支持读写
- token CRUD 端点功能完整

---

- U2. **迁移 115 凭证读取到 KV_CONFIG**

**Goal:** eleven5.ts 从 KV_CONFIG 读取凭证，移除 Env 中的 ELEVEN5 字段

**Requirements:** R3, R4

**Dependencies:** U1

**Files:**
- Modify: `src/services/eleven5.ts` — `exchangeCode` 和 `refreshAccessToken` 从 config 读取凭证
- Modify: `src/utils/types.ts` — Env 接口移除 `ELEVEN5_CLIENT_ID` 和 `ELEVEN5_CLIENT_SECRET`

**Approach:**
- `exchangeCode(env, code)` 改为先 `const config = await getConfig(env)` 再用 `config.eleven5_client_id`
- `refreshAccessToken(env)` 同理
- 函数签名不变（仍接收 `env`），只是内部读取来源变了
- Env 接口移除两个 ELEVEN5 字段

**Patterns to follow:**
- `ensureAdminPassword` 中 `getConfig(env)` 的使用模式 (`src/config.ts:28-34`)

**Test scenarios:**
- Happy path: exchangeCode 使用 KV 中的 client_id 发起 OAuth 请求
- Happy path: refreshAccessToken 使用 KV 中的 client_id 刷新 token
- Edge case: client_id 为空时应抛出有意义的错误
- Integration: 完整 OAuth 流程（授权码交换 + token 刷新）使用 KV 配置

**Verification:**
- `env.ELEVEN5_CLIENT_ID` 不再存在于 Env 接口
- eleven5.ts 中无 `env.ELEVEN5` 引用

---

- U3. **清理部署配置中的 ELEVEN5 引用**

**Goal:** 移除 wrangler.toml、provision.sh、deploy.yml 中的 ELEVEN5 相关配置

**Requirements:** R5, R6, R7

**Dependencies:** U2

**Files:**
- Modify: `wrangler.toml` — 移除 `[vars]` 中的 ELEVEN5_CLIENT_ID 和 secret 注释
- Modify: `.github/scripts/provision.sh` — 移除 ELEVEN5_CLIENT_SECRET secret 设置和 ELEVEN5_CLIENT_ID var 设置
- Modify: `.github/workflows/deploy.yml` — 移除 ELEVEN5_CLIENT_ID 和 ELEVEN5_CLIENT_SECRET secrets 引用

**Approach:**
- wrangler.toml: 删除 `ELEVEN5_CLIENT_ID = ""` 行和 `# - ELEVEN5_CLIENT_SECRET` 注释行
- provision.sh: 删除 `set_secret "ELEVEN5_CLIENT_SECRET"` 行和 ELEVEN5_CLIENT_ID var 设置块
- deploy.yml: 删除 `ELEVEN5_CLIENT_ID` 和 `ELEVEN5_CLIENT_SECRET` 的 env 行

**Test scenarios:**
- Test expectation: none — 纯配置文件修改，无行为变更

**Verification:**
- grep 确认项目中无 `ELEVEN5_CLIENT_ID` 或 `ELEVEN5_CLIENT_SECRET` 的 env/vars 引用

---

- U4. **添加 API token 认证中间件**

**Goal:** 创建 token 认证中间件并应用到 `/api/*` 路由

**Requirements:** R10, R11

**Dependencies:** U1

**Files:**
- Create: `src/middleware/api-auth.ts` — token 认证中间件
- Modify: `src/index.ts` — 在 `/api/*` 路由前应用中间件

**Approach:**
- 新中间件从 `Authorization: Bearer <token>` 提取 token
- 从 KV_CONFIG 的 `app:config` 读取 `api_tokens` 数组
- token 匹配则放行，否则返回 401
- 在 `src/index.ts` 中 `app.use("/api/*", apiAuthMiddleware())` 放在 cors 之后

**Patterns to follow:**
- `src/middleware/auth.ts` 的 session 中间件模式（createMiddleware、token 提取、KV 查询）

**Test scenarios:**
- Happy path: 有效 Bearer token 访问 /api/image/next 返回 200
- Error path: 无 Authorization header 返回 401
- Error path: 无效 token 返回 401
- Edge case: Authorization header 格式错误（无 "Bearer " 前缀）返回 401

**Verification:**
- 无 token 的 /api/* 请求返回 401
- 有效 token 的请求正常响应

---

- U5. **移除 gallery 前端，简化 admin SPA**

**Goal:** 删除 gallery 视图代码，admin 成为唯一前端

**Requirements:** R12, R13, R14, R15, R16

**Dependencies:** None

**Files:**
- Modify: `public/app.js` — 移除 renderGallery、fetchImage、toggleAutoAdvance、gallery 状态、hash 路由
- Modify: `public/index.html` — 移除 Gallery 导航链接，更新标题
- Modify: `public/style.css` — 移除 gallery 专用样式
- Modify: `src/index.ts` — 简化 SPA fallback（admin 是唯一页面）

**Approach:**
- app.js: 删除 gallery 相关函数和状态，router 直接渲染 admin（不再需要 hash 切换）
- index.html: 移除 `<a href="#/gallery">Gallery</a>`，标题改为 "Admin"
- style.css: 移除 `.gallery-controls`, `.toggle-group`, `.image-container`, `.image-info` 等 gallery 样式
- index.ts: SPA fallback 简化为直接返回 index.html（不再需要复杂的路径匹配）
- admin SPA 中新增 115 配置区域和 token 管理区域的 UI

**Patterns to follow:**
- 现有 admin 视图的渲染模式 (`public/app.js` 中 `renderAdmin()`)

**Test scenarios:**
- Happy path: 访问 / 直接显示 admin 登录页
- Happy path: 登录后可看到 115 配置和 token 管理区域
- Edge case: 访问 /gallery 或任意不存在路径仍显示 admin 页面

**Verification:**
- 无 `renderGallery` 函数
- 无 `#/gallery` 路由
- admin 登录、115 配置、token 管理、目录管理功能正常

---

- U6. **设定 Node.js 25 版本要求**

**Goal:** package.json 添加 engines 约束

**Requirements:** R17

**Dependencies:** None

**Files:**
- Modify: `package.json` — 添加 `engines.node: ">=25"`

**Approach:**
- 在 package.json 中添加 `"engines": { "node": ">=25" }`

**Test scenarios:**
- Test expectation: none — 纯配置修改

**Verification:**
- `npm install` 在 Node.js 25 下无警告

---

- U7. **更新 README.md**

**Goal:** README 同步反映所有变更

**Requirements:** R18, R19

**Dependencies:** U1-U6

**Files:**
- Modify: `README.md`

**Approach:**
- 移除 ELEVEN5_CLIENT_ID、ELEVEN5_CLIENT_SECRET 的 GitHub Secrets 说明
- 移除 ELEVEN5 相关的环境变量配置说明
- 新增 API token 认证说明（如何在 admin 面板生成 token，如何通过 Bearer header 调用 API）
- Node.js 版本要求更新为 25
- 更新项目结构（如有文件增删）
- 移除 gallery 面板相关说明

**Test scenarios:**
- Test expectation: none — 文档修改

**Verification:**
- README 中无 ELEVEN5 环境变量引用
- README 包含 token 认证使用说明
- README Node.js 版本为 25

---

## System-Wide Impact

- **Interaction graph:** eleven5.ts 的 `exchangeCode`/`refreshAccessToken` 调用链改变（config 来源变更为 KV）；新增 api-auth 中间件影响所有 `/api/*` 请求
- **Error propagation:** 115 凭证未配置时，OAuth 流程应返回明确错误而非静默失败
- **State lifecycle risks:** API token 存储在 KV_CONFIG 的 JSON 中，更新时需注意并发（单 admin 场景下可接受）
- **Unchanged invariants:** admin session 认证、D1 schema、cron 任务、115 OAuth 协议流程不变

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 115 凭证迁移后旧 env var 引用遗漏导致运行时错误 | U3 中 grep 验证无残留引用 |
| API token 中间件增加每个 /api/* 请求的 KV 查询开销 | KV_CONFIG 读取延迟极低（边缘缓存），可接受 |
| gallery 前端移除后外部依赖 gallery UI 的用户受影响 | 公开 API 仍可用，只是无内置 UI |

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-26-admin-panel-and-api-auth.md`
- Config pattern: `src/config.ts`
- Auth middleware pattern: `src/middleware/auth.ts`
- Settings API pattern: `src/routes/admin.ts:188-216`
- 115 service: `src/services/eleven5.ts`
