---
date: 2026-05-27
topic: open-ideation
focus: ""
mode: repo-grounded
---

# Ideation: 115 Gallery Worker — Surprise-Me Run

## Grounding Context

**Project**: TypeScript on Cloudflare Workers (Hono), D1 (SQLite) for image index + client state, KV x3 for config/tokens/sessions. Vanilla JS admin SPA. Zero npm deps beyond Hono.

**Architecture**: In-memory token bucket (3 rps, burst 5) + concurrency semaphore + KV circuit breaker for 115 API. Optimistic concurrency on client_state with version+retry. Daily D1 write counter (100K cap) with pause/resume sync. Idempotent upserts via ON CONFLICT DO UPDATE.

**Recent work**: Scaled to 500K+ images — removed KV download cache, random cursor replacing seen_images, incremental sync with daily write budget, Cloudflare resource limit error handling.

**Pain points**: No public gallery UI. OFFSET pagination degrades at 500K+. Per-request 115 API latency. Sequential sync blocks on paused directories.

**Learnings**: KV key explosion is the primary scale killer. 100K daily D1 writes. SQLite 999-parameter limit. Three-layer rate limiting. Optimistic concurrency.

**External context**: No edge-native gallery apps exist. Immich uses virtual scrolling + CLIP. R2 + D1 read replication. Hono framework. TanStack Virtual.

## Ranked Ideas

### 1. Keyset Cursor Pagination
**Description**: Replace all OFFSET-based queries with WHERE id > ? ORDER BY id LIMIT N. Store last-seen `id` (not ordinal index) in client_state. Makes gallery reads O(1) regardless of collection size.
**Warrant**: `direct:` queries.ts:83 uses OFFSET subquery scanning up to N rows. Code comment says "cursor-based pagination" but implementation uses OFFSET. At 500K rows, OFFSET 400K scans 400K rows.
**Rationale**: This is the read-path performance cliff. Every gallery page load hits this. Fixing it is prerequisite for any public gallery UI.
**Downsides**: Requires client_state schema change.
**Confidence**: 95%
**Complexity**: Low
**Status**: Explored → brainstorming

### 2. Content-Addressable Sync Fingerprinting
**Description**: Before upserting, SELECT sha1 from D1 and skip the write if unchanged. Reduces D1 writes by 90%+ on incremental syncs.
**Warrant**: `direct:` ON CONFLICT UPDATE counts as D1 write even when values are identical. 500K images at 100K writes/day = 5-day sync.
**Rationale**: Directly addresses the #1 sync bottleneck. Makes daily write budget 10x more effective.
**Downsides**: Adds one SELECT per file during sync (D1 reads are free).
**Confidence**: 95%
**Complexity**: Low
**Status**: Explored → brainstorming

### 3. Sync Generation Counter for Stale Cleanup
**Description**: Add `sync_generation` column. After sync, DELETE WHERE sync_generation < current. Single bulk DELETE replaces multi-pass scan-delete cycle.
**Warrant**: `direct:` cleanupStaleImages loads all file_ids into JS Set, paginates D1, builds dynamic IN clauses with 999-parameter workarounds.
**Rationale**: Eliminates O(n) memory pressure and multi-pass D1 read-delete cycle. Pairs with #2 to make sync both cheaper and simpler.
**Downsides**: Requires schema migration.
**Confidence**: 90%
**Complexity**: Low
**Status**: Explored → brainstorming

### 4. Weighted Random Walk
**Description**: Replace uniform random offset with weighted distribution biased toward unexplored index ranges. Small ring buffer in client_state tracks recently visited ranges.
**Warrant**: `external:` Spotify Radio uses "temperature" parameter for exploration vs. exploitation. Birthday paradox means repeats within ~1000 views at 500K.
**Rationale**: Low-cost UX improvement. No extra D1 reads — just math on existing last_index. Transforms random mode from "random" to "discovery."
**Downsides**: Slightly more complex than uniform random.
**Confidence**: 80%
**Complexity**: Low
**Status**: Explored → brainstorming

## Rejected Ideas

| # | Idea | Reason |
|---|------|--------|
| 5 | Public Gallery PWA Shell | Must pair with URL cache; premature without caching layer |
| 6 | Download URL Write-Through Cache | Adds D1 write pressure (50K/day); contradicts recent caching removal decision |
| 4 | Image Metadata Schema Enrichment | 115 API may not provide width/height; premature |
| C5 | ImageSource Abstraction | No immediate pain point; premature |
| C9 | Parallelized Directory Sync | C2+C25 make sync fast enough |
| C18 | Durable Object Coordinator | Overkill; KV lock + heartbeat sufficient |
| C19 | Multi-Tenant Sharing | Subject-replacement |
| C20 | Workers AI Tagging | Exceeds free tier; premature |
