---
date: 2026-05-26
topic: admin-panel-and-api-auth
---

# Admin Panel Consolidation & API Token Auth

## Summary

将 115 云存储凭证从环境变量迁移到 admin 面板配置；为公开 API 增加 token 认证机制；移除 gallery 前端面板，只保留 admin SPA；设定 Node.js 25 版本要求；同步更新 README。

---

## Problem Frame

当前 115 的 client ID/secret 通过 `wrangler.toml` 的环境变量和 Cloudflare secret 管理，部署时需要手动配置 GitHub Secrets 并运行 provision 脚本。每次更换凭证都需要重新部署。公开 API (`/api/*`) 完全无认证，任何人都可以调用。gallery 前端面板功能单一（只是个图片浏览器），与 admin 面板共存增加了维护成本。

---

## Requirements

**115 凭证管理**
- R1. admin 面板新增 115 配置区域，可设置和更新 `ELEVEN5_CLIENT_ID` 和 `ELEVEN5_CLIENT_SECRET`
- R2. 凭证存储在 KV_CONFIG 中（key: `app:config` 的子字段），不再依赖环境变量
- R3. `eleven5.ts` 服务从 KV_CONFIG 读取凭证，而非从 `env` 对象
- R4. 移除 `Env` 接口中的 `ELEVEN5_CLIENT_ID` 和 `ELEVEN5_CLIENT_SECRET`
- R5. 移除 `wrangler.toml` 中的 `[vars]` ELEVEN5_CLIENT_ID 和相关 secret 注释
- R6. 移除 `provision.sh` 中设置 ELEVEN5 相关 secret/var 的步骤
- R7. 移除 `deploy.yml` 中 ELEVEN5 相关的 GitHub Secrets 引用

**API Token 认证**
- R8. admin 面板新增 API token 管理区域：生成 token、列出 token、删除 token
- R9. token 为随机字符串，存储在 KV_CONFIG 中
- R10. `/api/*` 路由增加 token 认证中间件，通过 `Authorization: Bearer <token>` 请求头验证
- R11. 无有效 token 的请求返回 401

**移除 Gallery 面板**
- R12. 删除 `public/app.js` 中的 gallery 视图代码和路由切换逻辑
- R13. 删除 `public/index.html` 中的 gallery 导航链接
- R14. 删除 `public/style.css` 中 gallery 视图专用样式
- R15. 移除 `index.ts` 中的 SPA fallback 路由（不再需要 hash 路由）
- R16. 保留 admin SPA 的完整功能（登录、115 配置、目录管理、token 管理、设置）

**Node.js 版本**
- R17. `package.json` 添加 `engines.node: ">=25"`
- R18. README 中 Node.js 版本要求更新为 25

**文档**
- R19. README.md 同步更新：移除 ELEVEN5 环境变量相关说明、新增 API token 认证说明、更新项目结构

---

## Success Criteria

- admin 面板可以独立配置 115 凭证，无需重新部署
- 所有 `/api/*` 请求必须携带有效 token 才能访问
- 项目不再包含任何 gallery 前端代码
- `npm install` 在 Node.js 25 下无警告
- README 准确反映当前项目状态

---

## Scope Boundaries

- 不修改 115 OAuth 流程本身（只改配置来源）
- 不修改 D1 数据库 schema（token 和 115 凭证都存 KV）
- 不修改 admin session 认证机制
- 不新增前端框架（保持 vanilla JS）
- 不修改 cron 任务逻辑

---

## Key Decisions

- token 存 KV_CONFIG 而非 D1：轻量、无需 schema 迁移、与现有配置管理一致
- 115 凭证存 KV_CONFIG 的 `app:config` 中：复用现有 `getConfig`/`updateConfig` 函数
- 保留 admin SPA：管理员仍需要 Web UI 管理目录、同步、token 等

---

## Dependencies / Assumptions

- KV_CONFIG 的存储容量足够存放 115 凭证和 token 列表（Cloudflare KV 单个 value 上限 25 MiB）
- Node.js 25 已在 CI 中使用（deploy.yml 已配置 `node-version: "25"`）
