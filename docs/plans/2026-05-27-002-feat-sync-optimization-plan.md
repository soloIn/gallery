---
title: "feat: Sync & Pagination Optimization for 500K+ Images"
type: feat
status: active
date: 2026-05-27
origin: docs/brainstorms/2026-05-27-sync-optimization-requirements.md
---

# Sync & Pagination Optimization for 500K+ Images

## Summary

四项互补优化：(1) keyset 游标分页替代 OFFSET，读路径 O(1)；(2) sha1 预检查跳过未变更文件，省 90%+ D1 写入；(3) sync_generation 列实现单条 DELETE 清理；(4) 加权随机漫步偏向未探索区域。四项按依赖顺序实现：先 schema 迁移，再分页/同步独立推进，最后加权随机。

---

## Problem Frame

scaling-limits 重构后，500K 规模的基本可用性已解决，但四个遗留瓶颈限制了进一步扩展：OFFSET 分页在深层翻页时 O(n) 扫描、增量同步对未变更文件仍消耗写入预算、cleanupStaleImages 的 JS Set + 分页读删在大表上低效、纯随机浏览缺乏发现感。

---

## Requirements

- R1. Keyset cursor pagination — `getNextImage`/`getRandomImage` 改为 `WHERE id > ?`，client_state 存 `last_id`
- R2. Content-addressable sync fingerprinting — 同步前 SELECT sha1，相同则跳过写入
- R3. Sync generation counter — images 表新增 `sync_generation`，单条 DELETE 清理
- R4. Weighted random walk — client_state 新增 `recent_ranges`，温度桶加权选择

**Origin acceptance criteria:**
- 500K 行时分页查询为 O(1)
- 增量同步（无变更）不消耗 D1 写入
- 陈旧清理为单条 DELETE
- 随机浏览偏向未探索区域
- 迁移脚本幂等可重入
- API 响应格式不变

---

## Scope Boundaries

- 不引入外部依赖或存储服务
- 不改变 API 请求/响应格式（index/total 仍返回，index 改为动态计算）
- 不改动前端 UI
- 不添加新 API 端点
- Public Gallery PWA Shell — deferred
- Download URL Write-Through Cache — deferred
- Image Metadata Schema Enrichment — deferred

---

## Context & Research

### Relevant Code and Patterns

- `src/db/queries.ts` — `getNextImage` (L71-91) OFFSET 子查询、`getRandomImage` (L54-69) OFFSET、`setClientState` (L129-172) 乐观并发、`upsertImage` (L5-33) ON CONFLICT DO UPDATE
- `src/services/image-index.ts` — `syncDirectoryRecursive` (L108-196) 批量 upsert、`cleanupStaleImages` (L198-240) JS Set + 分页读删、`incrementWriteCount` (L26-32) KV 计数
- `src/routes/gallery.ts` — `GET /image/next` (L42-74) 使用 last_index、`GET /image/random` (L77-116) 随机偏移
- `src/db/schema.sql` — images/client_state 表定义
- `src/utils/types.ts` — `ClientState` (L78-83)、`ImageRecord` (L64-75)
- `migrations/0002_remove_seen_images.sql` — 现有迁移，rebuild-table 模式
- `test/db/queries.test.ts` — 查询层测试
- `test/routes/gallery.test.ts` — gallery 端点测试
- `test/services/image-index.test.ts` — 同步逻辑测试

### Key Technical Observations

- `getNextImage` 注释说"cursor-based"但实际用 OFFSET — 确认是性能瓶颈
- `setClientState` 已有乐观并发（version + retry），扩展 last_id 只需改参数
- `syncDirectoryRecursive` 的 batch statements 已是批量模式，加入 sha1 预检查可复用现有批处理结构
- `cleanupStaleImages` 的 JS Set 在 500K 时占用 ~20MB 内存，generation counter 可完全替代
- client_state 每客户端仅 1 行，新增列的迁移成本可忽略
- `getImageCount` 每次 SELECT COUNT(*) 在 500K 行约 50-100ms，可接受；keyset 分页后 index 需要额外 COUNT WHERE id <= ?

---

## Key Technical Decisions

- **last_id 替代 last_index**: client_state 存储上次返回的图片 id 而非序号。index 仍返回给客户端，改为动态计算 `COUNT(*) WHERE id <= last_id`。代价是每次返回多一次 COUNT，但 COUNT 在有索引时 O(1)，且保持了 API 兼容性
- **sha1 预检查粒度**: 批量 SELECT 已有 sha1（`WHERE file_id IN (...)`），过滤后批量 upsert。比逐条 SELECT 效率高，复用现有 batch 机制
- **sync_generation 更新策略**: R2 跳过的文件仍需更新 generation（否则被误删），用轻量 `UPDATE images SET sync_generation = ? WHERE file_id = ?` 替代完整 upsert
- **加权随机温度桶**: 将 id 空间分为 20 个桶，最近访问的桶温度降低，未访问的温度高。按温度加权选择桶后桶内均匀随机。退化为空时均匀随机

---

## Open Questions

### Resolved During Planning

- **R2 跳过的文件如何更新 generation?**: 用单独的 `UPDATE SET sync_generation = ?` 而非完整 upsert，不计入写入预算 — 因为 generation 更新是清理正确性的必要条件，不应被跳过
- **index 动态计算的性能?**: `SELECT COUNT(*) FROM images WHERE id <= ?` 在 id 主键上有索引，O(log n)，可接受

### Deferred to Implementation

- **加权随机的桶数量和温度衰减参数**: 初始 20 桶、温度半衰期 3 次访问，实现时可通过测试调整
- **getRandomImage 的随机 id 选择策略**: 用 COUNT + OFFSET 还是随机 id + WHERE id >= ?，实现时根据测试结果选择

---

## Implementation Units

- U1. **Schema Migrations**

**Goal:** 为 R1/R3/R4 所需的 schema 变更创建幂等迁移脚本，更新 schema.sql 和 types.ts

**Requirements:** R1.3, R1.4, R3.1, R3.6, R4.6

**Dependencies:** None

**Files:**
- Create: `migrations/0003_keyset_and_generation.sql`
- Modify: `src/db/schema.sql`
- Modify: `src/utils/types.ts`

**Approach:**
- 单一迁移脚本包含三步：(1) client_state 新增 `last_id` 和 `recent_ranges` 列，(2) images 新增 `sync_generation` 列，(3) 数据回填
- 使用 rebuild-table 模式（参考 0002），因为 D1/SQLite 的 ALTER TABLE ADD COLUMN 支持但为了一致性沿用已有模式
- 回填逻辑：client_state.last_id 通过 `SELECT id FROM images ORDER BY id ASC LIMIT 1 OFFSET last_index` 计算；images.sync_generation 设为 1
- 迁移脚本用 IF NOT EXISTS / IF EXISTS 保证幂等

**Patterns to follow:**
- `migrations/0002_remove_seen_images.sql` — rebuild-table 模式，幂等检查

**Test scenarios:**
- Happy path: 运行迁移后 schema 包含新列，数据回填正确
- Edge case: 空表运行迁移不报错
- Edge case: 重复运行迁移幂等（第二次运行无副作用）
- Error path: client_state 有 last_index 但 images 表为空时回填 last_id = 0

**Verification:**
- 迁移后 `PRAGMA table_info(client_state)` 包含 last_id 和 recent_ranges
- 迁移后 `PRAGMA table_info(images)` 包含 sync_generation
- 迁移后现有 client_state 的 last_id 正确映射
- 迁移后现有 images 的 sync_generation = 1

---

- U2. **Keyset Cursor Pagination**

**Goal:** 消除 OFFSET 性能悬崖，所有分页查询 O(1)

**Requirements:** R1.1, R1.2, R1.5

**Dependencies:** U1

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/routes/gallery.ts`
- Modify: `test/db/queries.test.ts`
- Modify: `test/routes/gallery.test.ts`

**Approach:**
- `getNextImage` 改为 `WHERE id > ?1 ORDER BY id ASC LIMIT 1`，参数从 last_index 改为 last_id
- `getRandomImage` 改为先 COUNT，生成随机 offset，再 `SELECT * FROM images ORDER BY id ASC LIMIT 1 OFFSET ?`（保持简单，COUNT O(1) + 小范围 OFFSET 可接受）
- 新增 `getImageIndexById(db, id)` 辅助函数：`SELECT COUNT(*) FROM images WHERE id <= ?` 用于动态计算 index
- `setClientState` 参数扩展为 `Partial<Pick<ClientState, "last_index" | "last_id">>`
- gallery.ts 的 `/image/next` 使用 last_id 游标，返回前调用 getImageIndexById 计算 index
- gallery.ts 的 `/image/random` 保持随机偏移逻辑但使用 last_id
- API 响应格式不变：仍返回 `{ url, name, index, total }`

**Patterns to follow:**
- `src/db/queries.ts` 现有的 `setClientState` 乐观并发模式

**Test scenarios:**
- Happy path: getNextImage(last_id=0) 返回第一张图，next_id 为该图 id
- Happy path: getNextImage(last_id=N) 返回 id > N 的第一张图
- Edge case: getNextImage 到达末尾后回到第一张（循环）
- Edge case: 空表返回 null
- Happy path: getRandomImage 返回有效图片，index 在 [0, total) 范围内
- Integration: gallery /image/next 端点使用 last_id 正确递增
- Integration: gallery /image/random 端点使用 last_id 正确返回

**Verification:**
- 500K 行模拟：getNextImage 查询计划不包含 SCAN（可通过 EXPLAIN 验证）
- API 响应格式不变
- 现有测试全部通过

---

- U3. **Content-Addressable Sync Fingerprinting**

**Goal:** 增量同步跳过未变更文件，减少 90%+ D1 写入

**Requirements:** R2.1, R2.2, R2.3, R2.4, R2.5

**Dependencies:** U1

**Files:**
- Modify: `src/services/image-index.ts`
- Modify: `test/services/image-index.test.ts`

**Approach:**
- 在 `syncDirectoryRecursive` 的批次处理中，先批量 SELECT 已有 sha1：`SELECT file_id, sha1 FROM images WHERE file_id IN (...)`
- 构建 Map<file_id, sha1>，过滤出真正需要写入的文件（新文件或 sha1 不同）
- 仅对需要写入的文件构建 batch statements
- 跳过的文件不调用 `incrementWriteCount`
- 新文件（D1 中无记录）直接 INSERT，无需额外检查
- 复用现有 batch 执行逻辑

**Patterns to follow:**
- `src/services/image-index.ts` 现有的 batch statements 模式（L120-188）

**Test scenarios:**
- Happy path: 文件 sha1 未变时跳过写入，incrementWriteCount 不被调用
- Happy path: 文件 sha1 变更时正常 upsert
- Happy path: 新文件正常 INSERT
- Edge case: 批次中混合新文件、变更文件、未变更文件
- Edge case: 空批次（所有文件未变更）
- Integration: 增量同步（无变更）不消耗 D1 写入预算

**Verification:**
- 未变更文件的增量同步 D1 写入次数为 0
- 新文件和变更文件正常写入
- 写入计数器仅统计实际写入

---

- U4. **Sync Generation Counter**

**Goal:** 单条 DELETE 替代多轮 scan-delete 清理

**Requirements:** R3.2, R3.3, R3.4, R3.5

**Dependencies:** U3

**Files:**
- Modify: `src/services/image-index.ts`
- Modify: `src/db/queries.ts`
- Modify: `test/services/image-index.test.ts`
- Modify: `test/db/queries.test.ts`

**Approach:**
- `upsertImage` 新增 `syncGeneration` 参数，INSERT/UPDATE 时设置 `sync_generation`
- 新增 `updateImageGeneration(db, file_id, generation)` 轻量更新函数
- 同步开始时从 KV 读取/递增 generation 计数器（key: `sync:generation`）
- R2 跳过的文件调用 `updateImageGeneration` 而非完整 upsert
- `cleanupStaleImages` 重写为 `DELETE FROM images WHERE root_dir_id = ?1 AND sync_generation < ?2`，单条语句
- 移除现有 JS Set + 分页读删逻辑

**Patterns to follow:**
- `src/services/image-index.ts` 现有的 KV 计数模式（`getDailyWriteCount`/`incrementWriteCount`）

**Test scenarios:**
- Happy path: 同步完成后陈旧图片被删除，保留的图片 generation 正确
- Happy path: R2 跳过的文件 generation 正确更新
- Edge case: 首次同步（所有文件都是新的）
- Edge case: 目录下所有文件都被删除（全部陈旧）
- Integration: 完整同步流程 — 新文件 + 变更文件 + 未变更文件 + 陈旧文件
- Error path: generation KV key 不存在时默认为 1

**Verification:**
- 陈旧清理为单条 DELETE 语句（不再有分页读删循环）
- 不再将所有 file_id 加载到 JS 内存
- 与 R2 协同：跳过的文件不被误删

---

- U5. **Weighted Random Walk**

**Goal:** 随机浏览从"混乱"升级为"发现"

**Requirements:** R4.1, R4.2, R4.3, R4.4, R4.5

**Dependencies:** U2

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/routes/gallery.ts`
- Modify: `src/utils/types.ts`
- Modify: `test/db/queries.test.ts`
- Modify: `test/routes/gallery.test.ts`

**Approach:**
- `ClientState` 接口新增 `recent_ranges: string`（JSON 数组字符串）
- `getRandomImage` 重写为加权选择：
  1. 获取 total count 和 min/max id
  2. 将 id 空间分为 20 个桶
  3. 解析 recent_ranges，计算每个桶的温度（最近访问过的 -1，未访问的 +1，clamp 到 [0.1, 2.0]）
  4. 按温度加权随机选择桶
  5. 在桶内均匀随机选择 id
  6. 用 `WHERE id >= ? ORDER BY id ASC LIMIT 1` 获取实际记录
- gallery.ts 的 `/image/random` 更新 recent_ranges 并写回 client_state
- 退化行为：recent_ranges 为空或解析失败时退化为均匀随机

**Patterns to follow:**
- `src/db/queries.ts` 现有的 `getRandomImage` 结构

**Test scenarios:**
- Happy path: 连续随机 20 次，访问分布偏向未探索区域
- Edge case: 新客户端（recent_ranges 为空）行为与均匀随机一致
- Edge case: 所有桶都被访问过（温度均低，但仍能选择）
- Edge case: 只有 1 张图片时行为正确
- Error path: recent_ranges JSON 解析失败时退化为均匀随机
- Integration: gallery /image/random 端点正确更新 recent_ranges

**Verification:**
- 新客户端行为与当前一致
- 连续浏览 100 次的重复率低于均匀随机
- recent_ranges 正确持久化到 client_state

---

## System-Wide Impact

- **Interaction graph:** `getNextImage`/`getRandomImage` 被 `gallery.ts` 的两个端点调用；`syncDirectoryRecursive` 被 `syncAll` 调用；`cleanupStaleImages` 在 `syncDirectory` 完成后调用
- **Error propagation:** D1 查询错误已通过 `withD1ErrorHandling` 处理；新增的 COUNT 查询和 generation UPDATE 沿用同一模式
- **State lifecycle risks:** R2 跳过写入但 R3 需要更新 generation — 如果 generation UPDATE 失败但同步继续，下次同步会误删这些文件。需要在 UPDATE 失败时回退到完整 upsert
- **API surface parity:** `/api/image/next` 和 `/api/image/random` 响应格式不变，前端无需改动
- **Unchanged invariants:** 乐观并发控制（version + retry）不变；每日写入预算机制不变；同步 lock 机制不变

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| R2 跳过的文件 generation UPDATE 失败导致误删 | UPDATE 失败时回退到完整 upsert（保证 generation 正确） |
| COUNT(*) WHERE id <= ? 在无索引时性能未知 | id 是 PRIMARY KEY，SQLite 自动创建索引，COUNT 为 O(log n) |
| 加权随机参数（桶数、温度衰减）需要调优 | 初始值保守（20 桶），通过测试验证分布，参数提取为常量便于调整 |
| 迁移脚本回填 500K 行的 last_id 可能耗时 | 回填使用单条 UPDATE + 子查询，D1 单次请求超时 30s 足够 |

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-27-sync-optimization-requirements.md`
- **Existing plan:** `docs/plans/2026-05-27-001-refactor-scaling-limits-plan.md`
- **Migration pattern:** `migrations/0002_remove_seen_images.sql`
- **Key source files:** `src/db/queries.ts`, `src/services/image-index.ts`, `src/routes/gallery.ts`
