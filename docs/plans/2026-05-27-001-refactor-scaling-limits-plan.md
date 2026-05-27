---
title: "refactor: Cloudflare Free Tier Scaling for 500K+ Images"
type: refactor
status: active
date: 2026-05-27
origin: docs/brainstorms/scaling-limits-requirements.md
---

# Cloudflare Free Tier Scaling for 500K+ Images

## Summary

重构 115 Gallery Worker 的存储和查询层，使其在 Cloudflare 免费版上支持 50 万+ 图片。核心改动：移除 per-image KV 下载缓存、实现增量同步与写入限流、将随机图片查询从 seen 数组改为无状态随机游标、为所有 KV/D1 操作添加资源限制错误处理。

---

## Problem Frame

当前架构在 500K 规模下有三个硬性瓶颈：KV key 膨胀（`cache:download:{pickCode}` 每图一个 key）、同步写入超限（免费版 D1 每天 10 万写入，全量同步需 5 天）、`cleanupStaleImages` 的 NOT IN 子句超过 SQLite 999 参数限制。此外，所有 KV/D1 操作缺乏对 Cloudflare 资源限制错误的处理，超限时直接抛出未捕获异常。

---

## Requirements

- R1. 移除 `getDownloadURL` 的 KV 缓存层，每次直接调 115 API
- R2. 保留 `KV_CONFIG` 中的 `app:config`、`sync:lock`、`circuit:115:api` 等非下载缓存 key
- R3. 移除 `cache:download:*` 和 `cache:fs_files:*` 相关的 KV 写入
- R4. 实现增量同步：基于 `last_synced` 时间戳只拉取新增/变更文件
- R5. 首次全量同步分批进行，每日 D1 写入不超过 10 万次
- R6. 同步进度状态可查询
- R7. `/api/image/random` 改为随机游标模式，不存储 seen 状态
- R8. 从 `client_state` 表移除 `seen_images` 列
- R9. 保留 `/api/image/next` 的顺序游标逻辑不变
- R10. D1 schema 迁移脚本，安全删除 `seen_images` 列
- R11. 迁移脚本幂等
- R12. 所有 KV/D1 操作添加资源限制错误处理（超限时返回 503 而非 500）
- R13. `cleanupStaleImages` 改为分批删除，避免 NOT IN 超参数限制

---

## Scope Boundaries

- 不引入外部数据库或存储服务
- 不改变 API 接口的请求/响应格式
- 不改动前端 UI
- 不优化 D1 查询索引（除 `root_dir_id` 索引外）
- 不处理 115 cloud API 自身的限制

---

## Context & Research

### Relevant Code and Patterns

- `src/services/cache.ts` — `cacheFetch` 函数，KV 缓存层，被 `getDownloadURL` 和 `listDirectory` 使用
- `src/services/eleven5.ts` — `getDownloadURL`（L253-282）通过 `cacheFetch` 缓存，`listDirectory`（L227-251）同样缓存
- `src/services/image-index.ts` — `syncDirectoryRecursive`（L32-104）批量 upsert，`cleanupStaleImages`（L106-126）NOT IN 问题
- `src/db/queries.ts` — `getRandomUnseenImage`（L53-73）NOT IN + ORDER BY RANDOM()，`getNextImage`（L75-95）OFFSET 分页，`setClientState`（L135-179）乐观并发
- `src/routes/gallery.ts` — API 端点，`MAX_SEEN_IMAGES = 500`（L17）
- `src/middleware/ratelimit.ts` — 速率限制和断路器模式，可复用其 `withBackoff` 模式
- `src/db/schema.sql` — 当前 schema，`client_state.seen_images` 列待删除
- `src/utils/types.ts` — `ClientState` 接口需更新
- `src/index.ts` — `scheduled` handler（L57-76），sync lock 机制

### Key Technical Observations

- `cacheFetch` 使用 `Map<string, Promise>` 做 in-flight 去重，移除下载缓存后此逻辑仍保留给 `listDirectory` 使用
- `rateLimitedFetch` 已有 `withBackoff` 和断路器模式，可复用于 D1/KV 限流错误处理
- `cleanupStaleImages` 在 500K 图片时 NOT IN 子句会超过 SQLite 999 参数硬限制
- `getNextImage` 的 OFFSET 子查询在 500K 行时性能线性下降，但用户选择保留此逻辑
- `getImageCount` 每次请求都做 `SELECT COUNT(*)`，在 500K 行上约 50-100ms，可接受

---

## Key Technical Decisions

- **去掉 KV 下载缓存**：115 API 响应快（token 已缓存），每次多一次 API 调用的代价远低于 KV key 膨胀风险。`listDirectory` 的 KV 缓存保留（key 数量 = 目录数 × 页数，增长可控）
- **随机游标替代 seen 数组**：`index = (last + random_offset) % total`，random_offset 在 `[1, total/10]` 范围内随机。500K 图片中重复概率 <0.01%
- **增量同步分批**：利用 `ON CONFLICT DO UPDATE` 实现幂等 upsert，写入计数器持久化到 KV，每日不超过 10 万次
- **cleanupStaleImages 分批**：改为先查出 D1 中该目录的所有 file_id，分批与 115 文件列表比对后删除，避免 NOT IN 超参数限制
- **资源限制错误处理**：KV/D1 超限时 Cloudflare 返回 HTTP 429 或特定错误码，统一捕获后返回 503 Service Unavailable，附带 `Retry-After` header
- **保留 D1 图片索引和现有 schema 字段**：不精简 `name`/`sha1`/`size`/`suffix`，保持 API 返回格式不变

---

## Implementation Units

- U1. **Remove KV download cache**

**Goal:** 移除 `getDownloadURL` 的 KV 缓存层，每次请求直接调 115 API 获取下载 URL

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/services/eleven5.ts` — 重写 `getDownloadURL` 函数，移除 `cacheFetch` 包装
- Modify: `src/services/cache.ts` — 无需改动（`listDirectory` 仍使用）

**Approach:**
- `getDownloadURL` 当前通过 `cacheFetch(env.KV_CONFIG, cacheKey, fetcher, 1800)` 缓存。改为直接调用 `rateLimitedFetch` + `apiRequest`
- `listDirectory` 的 `cacheFetch` 保留不变（其 key 数量 = 目录数 × 页数，增长可控）
- `cache.ts` 文件本身不删除，`listDirectory` 仍在使用

**Test scenarios:**
- Happy path: 调用 `getDownloadURL(pickCode)` 直接返回 115 CDN URL，不写入 KV
- Happy path: 连续调用同一 pickCode，每次都调 115 API（无缓存命中）
- Integration: `/api/image/next` 返回正确的下载 URL
- Integration: `/api/image/random` 返回正确的下载 URL

**Verification:**
- `getDownloadURL` 不再调用 `env.KV_CONFIG.put` 或 `env.KV_CONFIG.get`
- `listDirectory` 仍使用 `cacheFetch`，行为不变
- API 返回格式不变

---

- U2. **Add resource limit error handling**

**Goal:** 为所有 KV 和 D1 操作添加 Cloudflare 资源限制错误的统一处理

**Requirements:** R12

**Dependencies:** None

**Files:**
- Create: `src/utils/cloudflare-errors.ts` — 错误检测和包装工具函数
- Modify: `src/routes/gallery.ts` — gallery 端点的错误处理
- Modify: `src/services/image-index.ts` — sync 过程的错误处理
- Modify: `src/db/queries.ts` — D1 操作的错误包装

**Approach:**
- 创建 `isCloudflareLimitError(err)` 检测函数，识别 KV/D1 超限错误（HTTP 429、`KV put() limit exceeded`、`D1 SQL_STORAGE_LIMIT` 等）
- 创建 `withD1ErrorHandling(fn)` 和 `withKVErrorHandling(fn)` 包装器，捕获限流错误后抛出结构化的 `CloudflareLimitError`
- gallery 路由中 catch `CloudflareLimitError`，返回 503 + `Retry-After` header
- sync 过程中 catch 限流错误，暂停并持久化进度

**Technical design:**
```
// 方向性伪码，非实现规格
CloudflareLimitError {
  type: 'd1_read' | 'd1_write' | 'kv_read' | 'kv_write'
  retryAfter: number  // seconds
}

isCloudflareLimitError(err):
  - err.message contains "KV put() limit"
  - err.message contains "SQL_STORAGE_LIMIT"
  - err.message contains "too many requests"
  - err.status === 429
```

**Test scenarios:**
- Happy path: 正常 KV/D1 操作不受影响
- Error path: KV 写入超限时，gallery 端点返回 503 + Retry-After header
- Error path: D1 读取超限时，gallery 端点返回 503
- Error path: sync 过程中 D1 写入超限，进度持久化后暂停
- Integration: 断路器打开时，gallery 端点返回 503

**Verification:**
- 所有 gallery 端点在 KV/D1 超限时返回 503（非 500）
- sync 在超限时保存进度，下次可继续

---

- U3. **Random cursor replacing seen_images**

**Goal:** 将 `/api/image/random` 从 seen 数组 + NOT IN 查询改为无状态随机游标

**Requirements:** R7, R9

**Dependencies:** U2

**Files:**
- Modify: `src/db/queries.ts` — 新增 `getRandomImage` 函数，重写 `getRandomUnseenImage`
- Modify: `src/routes/gallery.ts` — 重写 `/api/image/random` 端点
- Modify: `src/utils/types.ts` — 更新 `GalleryImageResponse`（移除 `remaining`/`recycled` 字段或保留兼容）

**Approach:**
- 新增 `getRandomImage(db, lastIndex, total)` 函数：`offset = (lastIndex + randomInt(1, Math.max(1, Math.floor(total / 10)))) % total`，然后用 cursor 查询
- `/api/image/random` 端点：读取 `client_state.last_index`，计算随机偏移，更新 `last_index` 为新位置
- 不再读写 `seen_images` 列
- `MAX_SEEN_IMAGES` 常量和相关逻辑删除
- `/api/image/meta` 的 `seenCount` 字段改为返回 `0`（保持 API 兼容）

**Test scenarios:**
- Happy path: 调用 `/api/image/random?client=test` 返回随机图片，`last_index` 更新
- Happy path: 连续调用 10 次，获得不同的图片（概率极高）
- Edge case: 只有 1 张图片时，每次返回同一张
- Edge case: client 首次访问，自动创建 state
- Integration: `/api/image/meta` 返回正确的 `total` 和 `currentIndex`

**Verification:**
- `getRandomUnseenImage` 函数被替换或删除
- `seen_images` 列不再被读写
- API 响应格式保持兼容

---

- U4. **D1 schema migration — remove seen_images**

**Goal:** 安全删除 `client_state.seen_images` 列，简化表结构

**Requirements:** R8, R10, R11

**Dependencies:** U3（必须先停止读写 seen_images）

**Files:**
- Create: `migrations/0002_remove_seen_images.sql` — 迁移脚本
- Modify: `src/db/schema.sql` — 更新 schema 定义
- Modify: `src/utils/types.ts` — 从 `ClientState` 接口移除 `seen_images`
- Modify: `src/db/queries.ts` — 更新 `getClientState`、`setClientState`

**Approach:**
- SQLite 不支持 `ALTER TABLE DROP COLUMN`（需要 3.35.0+，D1 可能不支持）。使用重建表策略：
  1. `CREATE TABLE client_state_new (...)` 不含 `seen_images` 列
  2. `INSERT INTO client_state_new SELECT client_id, last_index, version, updated_at FROM client_state`
  3. `DROP TABLE client_state`
  4. `ALTER TABLE client_state_new RENAME TO client_state`
- 迁移脚本使用 `IF EXISTS` / `IF NOT EXISTS` 保证幂等
- `getClientState` 移除 `seen_images` 相关代码
- `setClientState` 简化为只更新 `last_index` 和 `version`

**Test scenarios:**
- Happy path: 迁移执行后 `client_state` 表不含 `seen_images` 列
- Happy path: 迁移前的数据（last_index, version）保留
- Edge case: 重复执行迁移脚本不报错
- Integration: 迁移后 `/api/image/random` 和 `/api/image/next` 正常工作

**Verification:**
- `client_state` 表只有 `client_id, last_index, version, updated_at` 四列
- 迁移脚本可重复执行
- API 端点正常工作

---

- U5. **Incremental sync with batched writes**

**Goal:** 实现增量同步和首次分批，控制每日 D1 写入不超过 10 万次

**Requirements:** R4, R5, R6, R13

**Dependencies:** U1, U2

**Files:**
- Modify: `src/services/image-index.ts` — 重写 `syncDirectoryRecursive` 和 `cleanupStaleImages`
- Modify: `src/db/queries.ts` — 新增 `getImagesByRootDir` 查询
- Modify: `src/index.ts` — 更新 `scheduled` handler 支持分批
- Modify: `src/utils/types.ts` — 新增 `SyncProgress` 类型

**Approach:**

*增量同步:*
- 读取 `directories.last_synced` 时间戳
- 115 API 的 `listDirectory` 已支持按时间排序（`o: user_utime`），在 sync 时检查文件的 `user_utime` 是否晚于 `last_synced`
- 只对新增/变更的文件执行 upsert

*写入限流:*
- 新增 `SyncProgress` 持久化到 KV_CONFIG（key: `sync:progress:{dirId}`）：
  - `{ dirId, lastOffset, writeCount, date, status }`
- sync 开始时检查 `writeCount` 和 `date`，如果 `date` 是今天且 `writeCount >= 100000`，暂停
- 每批 upsert 后更新 `writeCount`
- 跨天自动重置计数器

*cleanupStaleImages 分批:*
- 当前的 `NOT IN (500K个参数)` 会超 SQLite 限制
- 改为：先查出 D1 中该 `root_dir_id` 的所有 `file_id`（分页查询），与 115 文件列表 Set 比对，分批删除不在集合中的记录
- 每批 DELETE 最多 100 个 file_id（避免参数限制）

*同步进度查询:*
- 新增 admin API 端点 `GET /admin/sync/progress` 返回当前同步进度

**Test scenarios:**
- Happy path: 首次同步 1000 张图片，全部写入，progress 更新
- Happy path: 第二次同步只有 10 张新增，只写入 10 张
- Edge case: 写入计数达到 10 万上限，sync 暂停并保存进度
- Edge case: 跨天后计数器重置，sync 继续
- Edge case: cleanupStaleImages 在 10 万张图片目录下正常工作（分批删除）
- Error path: D1 写入超限时，sync 暂停并保存进度
- Integration: `GET /admin/sync/progress` 返回正确的进度信息

**Verification:**
- 增量同步只处理新增/变更文件
- 写入计数器正确跟踪每日 D1 写入
- 超限时 sync 暂停而非崩溃
- `cleanupStaleImages` 在大规模目录下不超参数限制

---

## System-Wide Impact

- **Interaction graph:** `getDownloadURL` 是 gallery 端点的热路径，移除缓存后每次请求多一次 115 API 调用。`rateLimitedFetch` 的令牌桶（3 rps, burst 5）成为瓶颈点 — 10 个并发请求可能触发限流等待
- **Error propagation:** 新增的 `CloudflareLimitError` 需要从 queries 层传播到 routes 层，中间层（services）需要透传
- **State lifecycle risks:** `client_state` schema 迁移是不可逆操作（删除列），需要确保 U3 先完成（停止读写 seen_images）
- **Unchanged invariants:** API 响应格式不变（`GalleryImageResponse`、`GalleryMetaResponse`），前端无需改动

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 115 API 无时间戳过滤能力，增量同步无法实现 | 降级为"只 upsert 不 cleanup"模式，跳过 stale 检测 |
| 移除 KV 缓存后 115 API 调用量增加，触发 115 侧限流 | `rateLimitedFetch` 已有断路器和退避机制，复用即可 |
| D1 schema 迁移删除列是破坏性操作 | U3 先确保代码不再读写 seen_images，迁移脚本幂等 |
| 首次分批同步跨天时 Worker cron 可能未触发 | sync:progress 持久化到 KV，支持手动触发继续 |

---

## Sources & References

- **Origin document:** [docs/brainstorms/scaling-limits-requirements.md](docs/brainstorms/scaling-limits-requirements.md)
- **Core files:** `src/services/eleven5.ts`, `src/services/image-index.ts`, `src/db/queries.ts`, `src/routes/gallery.ts`, `src/services/cache.ts`, `src/middleware/ratelimit.ts`
- **Schema:** `src/db/schema.sql`
- **Types:** `src/utils/types.ts`
