---
date: 2026-05-27
topic: scaling-limits
---

# Cloudflare Free Tier Scaling for 500K+ Images

## Summary

优化 115 Gallery Worker 在 Cloudflare 免费版上支持 50 万+ 图片的架构。核心改动：去掉 per-image KV 下载缓存、实现增量同步与首次分批、简化随机图片查询为无状态游标。目标是在不升级付费版的前提下，让 500K 图片规模的日常使用不受限制影响。

---

## Problem Frame

当前架构在小规模（几千张图）下工作良好，但存在三个在 500K 规模下会触发 Cloudflare 免费版限制的瓶颈：

1. **KV key 膨胀** — `cache:download:{pickCode}` 为每个图片创建独立 KV key，500K 图片意味着 500K+ 个 key，且 30 分钟过期后 key 仍残留（KV 不自动删除过期 key）
2. **同步写入限制** — 免费版 D1 每天 10 万次写入，全量同步 500K 图片需要 5 天
3. **随机查询效率** — `seen_images` JSON 数组最多 500 个 file_id，`NOT IN (?,?...)` 查询在大表上性能下降

---

## Requirements

**KV 缓存策略**
- R1. 移除 `getDownloadURL` 的 KV 缓存层，每次图片请求直接调用 115 API 获取下载 URL
- R2. 保留 `KV_CONFIG` 中的 `app:config`、`sync:lock`、`circuit:115:api` 等非下载缓存的 key
- R3. 移除 `cache:download:*` 和 `cache:fs_files:*` 相关的 KV 写入逻辑

**增量同步**
- R4. 实现增量同步：基于目录 `last_synced` 时间戳，只拉取新增/变更的文件
- R5. 首次全量同步支持分批进行，每日 D1 写入不超过 10 万次，同步进度持久化以支持跨天继续
- R6. 同步进度状态可查询（当前进度、剩余预估）

**随机图片查询**
- R7. `/api/image/random` 改为随机游标模式：`index = (last + random_offset) % total`，不存储 seen 状态
- R8. 从 `client_state` 表移除 `seen_images` 列，简化表结构
- R9. 保留 `/api/image/next` 的顺序游标逻辑不变

**数据迁移**
- R10. 提供 D1 schema 迁移脚本，安全删除 `seen_images` 列
- R11. 迁移脚本幂等，可重复执行不报错

---

## Success Criteria

- 500K 图片规模下，日常使用（每天 1000-3000 次请求）不触发任何 Cloudflare 免费版限制
- KV key 数量保持常数级（O(1)），不随图片数量增长
- 首次全量同步可自动分批完成，无需人工干预
- API 返回格式不变，前端无需改动

---

## Scope Boundaries

- 不引入外部数据库或存储服务（R2、Turso、PlanetScale 等）
- 不改变 API 接口的请求/响应格式
- 不改动前端 UI
- 不优化 D1 查询索引（当前索引在 500K 规模下性能足够）
- 不处理 115 cloud API 自身的限制

---

## Key Decisions

- **去掉 KV 下载缓存**：115 API 响应速度快（token 已缓存），每次请求多一次 API 调用的代价远低于 KV key 膨胀的风险
- **随机游标替代 seen 数组**：500K 图片中随机游标的重复概率极低（<0.01%），且无需存储状态
- **增量同步分批**：利用 D1 的 `ON CONFLICT DO UPDATE` 实现幂等 upsert，配合写入计数器控制每日上限
- **保留 D1 图片索引**：D1 是实现高效游标遍历和随机访问的必要层。115 API 不支持随机偏移，直接调 API 无法替代 D1 索引。当前字段（~300-500 字节/行）在 500K 规模下仅占 ~200MB，远低于 5GB 限制，无需精简
- **保留现有 D1 schema**：不删除 `name`/`sha1`/`size`/`suffix` 等字段，保持 API 返回格式不变

---

## Dependencies / Assumptions

- 115 cloud API 支持按时间戳过滤目录文件列表（增量同步依赖此能力）
- 115 API 的 download URL 接口无严格频率限制
- Cloudflare 免费版的限制在可预见未来不会进一步收紧
