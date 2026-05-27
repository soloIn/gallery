---
date: 2026-05-27
topic: sync-optimization
---

# Sync & Pagination Optimization for 500K+ Images

## Summary

四项互补优化，提升 115 Gallery Worker 在 500K 图片规模下的读写效率和浏览体验：keyset 游标分页（消除 OFFSET 性能悬崖）、内容寻址同步指纹（减少 90%+ D1 写入）、同步代数计数器（单条 DELETE 替代多轮清理）、加权随机漫步（从"随机"升级为"发现"）。四项独立可交付，但组合后为未来公开 Gallery UI 铺平道路。

---

## Problem Frame

当前架构已通过 scaling-limits 重构（增量同步、每日写入预算、随机游标）解决了 500K 规模的基本可用性，但存在四个遗留瓶颈：

1. **读路径性能悬崖** — `getNextImage` 和 `getRandomImage` 使用 OFFSET 子查询（`queries.ts:64,84`），注释写着"cursor-based pagination"但实际是 OFFSET。500K 行时 OFFSET 400K 扫描 400K 行，每次翻页都是 O(n)。
2. **同步写入浪费** — `ON CONFLICT DO UPDATE` 即使值完全不变也计入 D1 写入次数。500K 图片 × 100K 写入/天 = 每次全量同步 5 天。增量同步时文件未变更仍消耗写入预算。
3. **陈旧图片清理低效** — `cleanupStaleImages` 将所有 file_id 加载到 JS Set，分页读取 D1，动态构建 IN 子句（受 999 参数限制）。500K 图片时内存压力大、多轮读删。
4. **纯随机缺乏发现感** — 均匀随机在 500K 集合中约 1000 次浏览就会出现生日悖论重复，浏览体验是"混乱"而非"发现"。

---

## Requirements

### R1: Keyset Cursor Pagination

**目标**: 所有分页查询从 O(n) 降为 O(1)，无论集合大小。

- R1.1: `getNextImage` 改为 `WHERE id > ? ORDER BY id ASC LIMIT 1`，用 `last_id` 替代 `last_index` 作为游标
- R1.2: `getRandomImage` 改为先查 COUNT，生成随机 offset，再用 `ORDER BY id ASC LIMIT 1 OFFSET ?`（COUNT 是 O(1)，OFFSET 在小随机范围内可接受；或用 `WHERE id >= ? ORDER BY id ASC LIMIT 1` 配合随机 id 选择）
- R1.3: `client_state` 表新增 `last_id INTEGER` 列（或替代 `last_index`），存储上次返回的图片 id 而非序号
- R1.4: 迁移脚本：为现有 client_state 记录计算 `last_id`（通过 `SELECT id FROM images ORDER BY id ASC LIMIT 1 OFFSET last_index`），幂等可重入
- R1.5: API 响应格式不变（仍返回 index 和 total），index 改为动态计算 `SELECT COUNT(*) FROM images WHERE id <= ?`

**变更文件**:
- `src/db/queries.ts` — 重写 `getNextImage`、`getRandomImage`、`setClientState`
- `src/utils/types.ts` — `ClientState` 接口更新
- `src/db/schema.sql` — client_state 表定义更新
- `migrations/` — 新增迁移脚本
- `src/routes/gallery.ts` — 使用新游标 API
- `test/db/queries.test.ts` — 更新测试
- `test/routes/gallery.test.ts` — 更新测试

**验收标准**:
- 500K 行时 `getNextImage` 查询时间与 offset 无关（常数级）
- 现有 client_state 数据自动迁移，无数据丢失
- API 响应格式不变

---

### R2: Content-Addressable Sync Fingerprinting

**目标**: 增量同步时跳过未变更文件，减少 90%+ D1 写入。

- R2.1: 同步时先 `SELECT sha1 FROM images WHERE file_id = ?`，若 sha1 相同则跳过 upsert
- R2.2: 仅当 sha1 不存在（新文件）或 sha1 不同（文件变更）时执行 `ON CONFLICT DO UPDATE`
- R2.3: 对新文件（D1 中无记录），直接执行 INSERT（无需 SELECT）
- R2.4: 批量处理优化：对同一批次的文件，先批量 SELECT 已有 sha1（`WHERE file_id IN (...)`），过滤后再批量 upsert
- R2.5: 每次跳过的文件不计入 D1 写入预算（`incrementWriteCount` 仅统计实际写入）

**变更文件**:
- `src/services/image-index.ts` — `syncDirectoryRecursive` 增加 sha1 预检查逻辑
- `test/services/image-index.test.ts` — 新增测试

**验收标准**:
- 未变更文件的增量同步不消耗 D1 写入次数
- 500K 图片的增量同步（无变更）在秒级完成
- 新文件和变更文件正常写入

---

### R3: Sync Generation Counter for Stale Cleanup

**目标**: 用单条 DELETE 替代多轮 scan-delete 清理周期。

- R3.1: `images` 表新增 `sync_generation INTEGER NOT NULL DEFAULT 0` 列
- R3.2: 同步开始时获取或递增全局 generation 计数器（KV key: `sync:generation`）
- R3.3: 每次 upsert 时设置 `sync_generation = 当前 generation`
- R3.4: 同步完成后执行 `DELETE FROM images WHERE root_dir_id = ? AND sync_generation < ?`，单条语句清理所有陈旧图片
- R3.5: 与 R2 共存：跳过的文件也需要更新 `sync_generation`（否则会被误删），但不计入写入预算
- R3.6: 迁移脚本：为现有 images 设置 `sync_generation = 1`，幂等可重入

**变更文件**:
- `src/db/schema.sql` — images 表新增列
- `src/db/queries.ts` — `upsertImage` 增加 `sync_generation` 参数
- `src/services/image-index.ts` — 重写 `cleanupStaleImages`，移除 JS Set + 分页读删逻辑
- `migrations/` — 新增迁移脚本
- `test/db/queries.test.ts` — 更新测试
- `test/services/image-index.test.ts` — 更新测试

**验收标准**:
- 500K 图片的陈旧清理为单条 DELETE 语句
- 不再需要将所有 file_id 加载到 JS 内存
- 与 R2 协同：跳过的文件 generation 正确更新，不被误删
- 迁移后现有数据 generation 为 1

---

### R4: Weighted Random Walk

**目标**: 随机浏览从"混乱"升级为"发现"，偏向未探索区域。

- R4.1: `client_state` 新增 `recent_ranges TEXT` 列，存储最近 N 次访问的 id 范围（JSON 数组，最多 10 个条目）
- R4.2: 随机选择时，将 id 空间分为 K 个桶（如 20 个），计算每个桶的"温度"（最近访问过的桶温度低，未访问的温度高）
- R4.3: 按温度加权选择桶，再在桶内均匀随机选择 id
- R4.4: 选择后更新 `recent_ranges`，超出 10 条时 FIFO 淘汰
- R4.5: 退化行为：当 `recent_ranges` 为空时（新客户端或列缺失），退化为均匀随机，确保向后兼容
- R4.6: 迁移脚本：新增 `recent_ranges` 列，默认值 `'[]'`

**变更文件**:
- `src/db/queries.ts` — `getRandomImage` 重写为加权选择
- `src/utils/types.ts` — `ClientState` 接口新增 `recent_ranges`
- `src/db/schema.sql` — client_state 表新增列
- `migrations/` — 新增迁移脚本
- `src/routes/gallery.ts` — 随机请求传递 client state
- `test/db/queries.test.ts` — 新增加权随机测试
- `test/routes/gallery.test.ts` — 更新测试

**验收标准**:
- 连续随机浏览 100 次，重复率低于均匀随机
- 新客户端行为与当前一致（均匀随机）
- `recent_ranges` 为空时行为正确

---

## Success Criteria

- 500K 行时所有分页查询为 O(1)
- 增量同步（无变更文件）不消耗 D1 写入预算
- 陈旧图片清理为单条 DELETE，内存使用 O(1)
- 随机浏览可感知地偏向未探索区域
- 所有迁移脚本幂等可重入
- 现有测试全部通过，新功能有对应测试

---

## Scope Boundaries

**In scope**:
- 上述四项优化的实现、测试、迁移
- API 响应格式保持不变

**Deferred for later**:
- Public Gallery PWA Shell（需先完成 R1 分页优化）
- Download URL Write-Through Cache（需 PWA 存在才有价值）
- Image Metadata Schema Enrichment（width/height/format/taken_at）
- 前端 UI 改动

**Outside this product's identity**:
- R2 Image Cache（矛盾：最近刻意移除了 per-image 缓存）
- Multi-Tenant Sharing（主题替换）
- Workers AI Tagging（超出免费版）

---

## Dependencies / Assumptions

- D1 的 `COUNT(*)` 在有索引时为 O(1)（SQLite 优化）
- `WHERE id > ? ORDER BY id ASC LIMIT 1` 在 `id` 主键上为 O(log n)
- 115 API 的 sha1 字段在文件内容不变时保持稳定
- 现有 client_state 数据量小（每个客户端 1 行），迁移成本可忽略
