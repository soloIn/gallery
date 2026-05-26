---
title: "feat: 115 Open Gallery on Cloudflare Workers"
type: feat
status: completed
date: 2026-05-26
---

# feat: 115 Open Gallery on Cloudflare Workers

## Summary

Build a Node.js web application deployed to Cloudflare Workers that serves as an image gallery backed by 115 cloud storage via its Open API. An admin authenticates with 115 via OAuth Authorization Code Flow, configures gallery directories, and exposes a public image API with two retrieval modes — sequential polling and random (with persistent dedup tracking per client). The system includes rate limiting, response caching, and periodic directory sync to avoid hitting 115 API limits.

---

## Problem Frame

The user has images stored in 115 cloud storage directories and wants to expose them as a gallery service accessible via a simple HTTP API. There is no existing tool that combines 115 Open API integration with a lightweight gallery-as-a-service pattern on edge infrastructure. Current alternatives require either running a persistent server or manually sharing 115 links.

---

## Requirements

- R1. Single admin account with credentials configured via project environment variables (no self-registration)
- R2. Admin can connect their 115 account via OAuth Authorization Code Flow (client_id, client_secret from 115 Open Platform app registration)
- R3. Admin can configure one or more 115 directory IDs as gallery roots, with optional subdirectory inclusion
- R4. Image directory index synced manually or on a configurable cron schedule, with rate-limited 115 API calls
- R5. Public image API with two modes: sequential polling (next image per client) and random (non-repeating per client, persistent tracking)
- R6. Client differentiation via caller-supplied `client` query parameter (no auth required for image API)
- R7. 115 API calls subject to concurrency limits, per-second rate caps, and response caching
- R8. Token auto-refresh when access_token expires (7200s lifetime)
- R9. Deployable to Cloudflare Workers with KV + D1 storage

---

## Scope Boundaries

- No multi-user admin (single admin only)
- No image upload or modification — read-only gallery
- No user registration or authentication for API consumers (client ID is caller-defined)
- No image transformation (thumbnails, resizing) — serves 115's URLs directly
- No offline/download caching of image files themselves
- OAuth scope limited to file read operations

### Deferred to Follow-Up Work

- Video file support (only images in v1)
- Image metadata search/filter API
- Webhook/callback for 115 directory changes (instead of polling)
- Multi-tenant admin (multiple 115 accounts)

---

## Context & Research

### 115 Open API Endpoints

| Operation | Method | Endpoint | Base |
|-----------|--------|----------|------|
| OAuth authorize | GET | `/open/authorize` | `qrcodeapi.115.com` |
| Code to Token | POST | `/open/authCodeToToken` | `qrcodeapi.115.com` |
| Refresh Token | POST | `/open/refreshToken` | `qrcodeapi.115.com` |
| List files | GET | `/open/ufile/files` | `proapi.115.com` |
| File info | GET | `/open/folder/get_info` | `proapi.115.com` |
| Download URL | POST | `/open/ufile/downurl` | `proapi.115.com` |

### Key API Parameters for `fs_files`

`cid` (directory ID), `limit` (page size, default 32), `offset`, `type=2` (images only), `asc`, `o` (sort field), `show_dir` (include subdirs), `fc_mix`, `suffix`

### Rate Limit Error Codes

`590075`, `990005`, `990009` — all indicate rate limiting or server busy. Exponential backoff required.

### OAuth Token Lifecycle

- access_token expires in ~7200 seconds (2 hours)
- refresh_token rotates on use (old one invalidated)
- Error `40140122`: exceeded app auth limit
- Error `40140123-40140126`: access_token errors

### External References

- [p115client Python implementation](https://github.com/ChenyangGao/p115client) — authoritative reference for 115 Open API endpoints and parameters
- [Hono framework docs](https://hono.dev/) — edge-first routing framework
- [Cloudflare Workers D1 docs](https://developers.cloudflare.com/d1/)
- [Cloudflare Workers KV docs](https://developers.cloudflare.com/kv/)

---

## Key Technical Decisions

- **Hono framework**: Lightweight, edge-first, built-in middleware. Better DX than raw Workers for routing/middleware, no cold-start penalty.
- **KV for ephemeral data + D1 for structured data**: KV for tokens, sessions, config (key-value, eventual consistency acceptable). D1 for image index and client state (SQL queries needed for pagination, random selection, aggregation).
- **In-memory rate limiter per Worker instance**: Token bucket resets on cold start — acceptable tradeoff for simplicity. KV-based circuit breaker as safety net.
- **D1 for random image selection**: Use `SELECT * FROM images WHERE id NOT IN (?) ORDER BY RANDOM() LIMIT 1` with the seen-list. For large seen-lists (>500), reset instead of growing the query.
- **Download URL caching in KV (30 min TTL)**: Download URLs from 115 are time-limited. 30-minute cache balances freshness vs API call reduction.
- **SHA-256 password hashing via Web Crypto API**: No external crypto dependency needed in Workers environment.
- **Vanilla JS frontend**: No build step, served as static assets via Workers Sites or inline. Keeps deployment simple.

---

## Open Questions

### Resolved During Planning

- **Q: How to handle OAuth callback in Workers?** A: Standard redirect flow — Worker serves as the redirect_uri endpoint at `/auth/callback`, exchanges code for token server-side.
- **Q: How to store seen-images for random mode when the list gets large?** A: Cap at 500 entries. When exceeded, reset the seen list and notify client that all images have been shown. D1 row stores JSON array.
- **Q: How to trigger scheduled sync?** A: Use Cloudflare Workers `scheduled` event handler with cron trigger in `wrangler.toml`.

### Deferred to Implementation

- Exact pagination strategy for `fs_files` when a directory has thousands of images (max 32 per page, need loop)
- Whether 115's `download_url` response headers require proxying or if direct URLs work from client browsers

---

## Output Structure

```
gallery/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   └── ratelimit.ts
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── admin.ts
│   │   └── gallery.ts
│   ├── services/
│   │   ├── eleven5.ts
│   │   ├── image-index.ts
│   │   └── cache.ts
│   ├── db/
│   │   ├── schema.sql
│   │   └── queries.ts
│   └── utils/
│       ├── crypto.ts
│       └── types.ts
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── test/
    ├── services/
    │   ├── eleven5.test.ts
    │   └── image-index.test.ts
    ├── routes/
    │   ├── auth.test.ts
    │   ├── admin.test.ts
    │   └── gallery.test.ts
    └── middleware/
        └── ratelimit.test.ts
```

---

## Implementation Units

- U1. **Project Scaffolding and Configuration**

**Goal:** Initialize the Cloudflare Worker project with Hono, TypeScript, KV/D1 bindings, and base configuration.

**Requirements:** R9

**Dependencies:** None

**Files:**
- Create: `wrangler.toml`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `src/config.ts`
- Create: `src/utils/types.ts`

**Approach:**
- `wrangler dev` for local development with `--d1` and `--kv` flags
- Hono app with CORS middleware, error handling middleware
- Config module reads from `env` bindings (KV_CONFIG, KV_TOKEN, KV_SESSION, DB)
- Type definitions for 115 API responses, image records, client state, config shape

**Test scenarios:**
- Happy path: Worker starts and responds to `GET /` with 200
- Happy path: CORS headers present on API responses
- Happy path: Config module returns correct values from env bindings

**Verification:** `wrangler dev` starts without errors, `GET /health` returns 200.

---

- U2. **D1 Schema and Query Layer**

**Goal:** Create the database schema and typed query helpers for images, client state, and directories.

**Requirements:** R4, R5, R6

**Dependencies:** U1

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/queries.ts`
- Test: `test/db/queries.test.ts`

**Approach:**
- Three tables: `images`, `client_state`, `directories` (schema from draft plan)
- Query helpers: `upsertImage`, `getImagesByDir`, `getRandomUnseenImage`, `getNextImage`, `getClientState`, `setClientState`, `upsertDirectory`, `getDirectories`
- `getRandomUnseenImage` takes a seen-IDs array, uses `NOT IN` clause with `ORDER BY RANDOM() LIMIT 1`
- `getNextImage` uses client's `last_index`, returns next by `id` ASC, wraps at boundary

**Test scenarios:**
- Happy path: Insert image, retrieve by dir_id, verify fields
- Happy path: `getRandomUnseenImage` excludes seen IDs, returns unseen image
- Edge case: `getRandomUnseenImage` with all images seen returns null
- Edge case: `getNextImage` wraps around when at last image
- Edge case: `upsertImage` with duplicate `file_id` updates existing row
- Error path: Empty directory returns empty array, no error

**Verification:** All query helpers pass unit tests against a local D1 instance.

---

- U3. **115 OAuth Service**

**Goal:** Implement the full OAuth Authorization Code Flow with token storage and auto-refresh.

**Requirements:** R2, R8

**Dependencies:** U1

**Files:**
- Create: `src/services/eleven5.ts`
- Create: `src/utils/crypto.ts`
- Test: `test/services/eleven5.test.ts`

**Approach:**
- `getAuthorizeURL(clientId, redirectUri, state)` — builds the 115 authorize URL
- `exchangeCode(env, code)` — POST to `/open/authCodeToToken`, stores tokens in KV_TOKEN as JSON `{access_token, refresh_token, expires_at}`
- `refreshAccessToken(env)` — POST to `/open/refreshToken`, updates KV_TOKEN
- `ensureToken(env)` — checks `expires_at`, calls `refreshAccessToken` if within 5 minutes of expiry. Returns valid access_token.
- `apiRequest(env, method, path, params?)` — wraps fetch with `Authorization: Bearer` header, auto-calls `ensureToken` first, retries once on 401
- State parameter for CSRF protection: random string, stored in KV with 10-min TTL, validated on callback
- Password hashing: `crypto.subtle.digest('SHA-256', ...)` for admin password

**Test scenarios:**
- Happy path: `getAuthorizeURL` returns correct URL with all params
- Happy path: `exchangeCode` stores tokens in KV with correct expiry
- Happy path: `ensureToken` returns cached token when not expired
- Happy path: `ensureToken` refreshes token when expired
- Error path: `exchangeCode` with invalid code returns error, no tokens stored
- Error path: `refreshAccessToken` with expired refresh_token clears KV and throws
- Integration: `apiRequest` auto-refreshes on 401 and retries

**Verification:** OAuth flow completes end-to-end in `wrangler dev` with test 115 app credentials.

---

- U4. **Admin Authentication and Session Management**

**Goal:** Implement admin login, session creation/validation, and auth middleware.

**Requirements:** R1

**Dependencies:** U1, U3 (crypto utils)

**Files:**
- Create: `src/routes/admin.ts`
- Create: `src/middleware/auth.ts`
- Test: `test/routes/admin.test.ts`
- Test: `test/middleware/auth.test.ts`

**Approach:**
- `POST /admin/login` — validates username/password against KV_CONFIG hash, creates session token (random UUID), sets HTTP-only cookie + stores in KV_SESSION with 24h TTL
- Auth middleware: reads session from cookie or `Authorization: Bearer` header, validates against KV_SESSION, injects `admin` flag into context
- `POST /admin/logout` — deletes session from KV, clears cookie
- On first request: if no admin hash in KV_CONFIG, hash the `ADMIN_PASS` env var and store it
- All `/admin/*` routes except `/admin/login` require auth middleware

**Test scenarios:**
- Happy path: Valid credentials create session, return cookie
- Happy path: Authenticated request passes middleware, reaches protected route
- Error path: Wrong password returns 401, no session created
- Error path: Expired/invalid session returns 401
- Edge case: First boot hashes `ADMIN_PASS` from env and stores in KV
- Edge case: Concurrent login attempts each create separate sessions

**Verification:** Login flow works end-to-end, protected routes reject unauthenticated requests.

---

- U5. **115 API Client with Rate Limiting and Caching**

**Goal:** Build the 115 API client layer with concurrency control, rate limiting, response caching, and error handling.

**Requirements:** R7, R8

**Dependencies:** U3

**Files:**
- Create: `src/services/cache.ts`
- Create: `src/middleware/ratelimit.ts`
- Modify: `src/services/eleven5.ts`
- Test: `test/middleware/ratelimit.test.ts`
- Test: `test/services/eleven5.test.ts`

**Approach:**
- In-memory token bucket: 3 req/s capacity, burst of 5. Resets on Worker cold start (acceptable).
- Concurrency pool: Max 10 in-flight requests using a simple promise-based semaphore
- KV response cache: `cacheFetch(env, key, fetcher, ttl)` — checks KV first, calls fetcher on miss, stores result with TTL
- Cache keys: `fs_files:{cid}:{offset}:{limit}`, `download:{pickcode}`
- Circuit breaker: Track rate-limit errors in KV (`circuit:{timestamp}`). If 3+ in 60s, reject new requests for 60s with 503.
- Exponential backoff on 429/rate-limit errors: 1s, 2s, 4s, 8s, max 30s, max 3 retries
- `listDirectory(env, cid, offset, limit)` — cached `fs_files` call with type=2 (images only)
- `getDownloadURL(env, pickCode)` — cached `download_url` call

**Test scenarios:**
- Happy path: First call fetches from API, second call returns cached response
- Happy path: Cache expires after TTL, next call fetches fresh
- Happy path: 10 concurrent requests all complete (semaphore allows)
- Edge case: 11th concurrent request waits for semaphore slot
- Error path: Rate limit error triggers backoff and retry
- Error path: Circuit breaker opens after 3 rate-limit errors, returns 503
- Integration: `listDirectory` paginates through all results in a large directory

**Verification:** Rate limiter correctly throttles requests, cache reduces API calls, circuit breaker activates under load.

---

- U6. **Gallery Directory Management**

**Goal:** Admin API for configuring gallery directories and viewing the 115 directory tree.

**Requirements:** R3

**Dependencies:** U4, U5

**Files:**
- Modify: `src/routes/admin.ts`
- Test: `test/routes/admin.test.ts`

**Approach:**
- `GET /admin/directories` — list configured gallery directories from D1
- `POST /admin/directories` — add a directory (dir_id, include_subdirs flag), validates against 115 API that dir exists
- `DELETE /admin/directories/:id` — remove directory and its images from index
- `GET /admin/browse?cid={id}` — browse 115 directory tree (list subdirs of given directory)
- `POST /admin/sync` — trigger manual sync for all configured directories
- `GET /admin/settings` — return current settings (sync interval, rate limits)
- `PUT /admin/settings` — update settings in KV_CONFIG
- All routes protected by auth middleware

**Test scenarios:**
- Happy path: Add directory, verify stored in D1 with correct metadata
- Happy path: Browse returns subdirectory list from 115 API
- Happy path: Delete directory removes it and all associated image records
- Error path: Add non-existent directory ID returns 400
- Error path: Unauthenticated request to any admin route returns 401
- Edge case: Add directory that's already configured returns 409

**Verification:** Full CRUD for directories works, 115 directory browsing returns real data.

---

- U7. **Image Index Sync Service**

**Goal:** Sync image metadata from 115 directories into D1, with pagination, subdirectory support, and scheduled execution.

**Requirements:** R3, R4

**Dependencies:** U2, U5

**Files:**
- Create: `src/services/image-index.ts`
- Test: `test/services/image-index.test.ts`

**Approach:**
- `syncDirectory(env, dirId, includeSubdirs)` — paginates through `fs_files` with type=2, upserts each image into D1. Updates `directories.last_synced` timestamp.
- For subdirectories: recursively calls `fs_files` with `show_dir=1`, processes each subdir
- Pagination: `offset += limit` loop until response returns fewer items than limit
- Uses the rate limiter from U5 for all 115 API calls
- `syncAll(env)` — iterates all configured directories, calls `syncDirectory` for each
- `scheduled` handler in `index.ts` — reads cron config from KV_CONFIG, calls `syncAll`
- Upsert strategy: `INSERT OR REPLACE` on `file_id` unique constraint
- After sync: clean up images whose `file_id` no longer appears in directory listing (optional, configurable)

**Test scenarios:**
- Happy path: Sync single directory, all images appear in D1
- Happy path: Sync with subdirectories includes images from nested dirs
- Happy path: Re-sync updates changed files (new images added, stale ones handled)
- Happy path: `syncAll` processes all configured directories sequentially
- Edge case: Empty directory results in 0 images, no error
- Edge case: Directory with 1000+ images paginates correctly
- Error path: 115 API error during sync skips that directory, continues others
- Error path: Rate limit during sync triggers backoff, sync resumes

**Verification:** `POST /admin/sync` triggers sync, D1 contains correct image count matching 115 directory.

---

- U8. **Image Retrieval API**

**Goal:** Public API for fetching images in polling and random modes, with per-client state tracking.

**Requirements:** R5, R6

**Dependencies:** U2, U7

**Files:**
- Create: `src/routes/gallery.ts`
- Test: `test/routes/gallery.test.ts`

**Approach:**
- `GET /api/image/next?client={id}` — reads `last_index` from `client_state`, returns image at that index (ordered by `id`), increments index. Wraps to 0 at end. Returns `{ url, name, index, total }`.
- `GET /api/image/random?client={id}` — reads `seen_images` JSON array from `client_state`, queries D1 for random unseen image. Appends to seen list. When all seen: resets list, sets `recycled: true` in response. Returns `{ url, name, remaining, total, recycled? }`.
- `GET /api/image/meta?client={id}` — returns `{ total, currentIndex, seenCount }` for the client.
- `client` parameter is required — returns 400 if missing.
- No authentication required for gallery API endpoints.
- Image `url` field is the 115 download URL (from cached `getDownloadURL`).

**Test scenarios:**
- Happy path: First call to `/next` returns first image, second call returns second
- Happy path: `/next` wraps around after last image
- Happy path: `/random` returns non-repeating images across calls
- Happy path: `/random` resets and sets `recycled: true` when all images seen
- Happy path: Different `client` values maintain independent state
- Edge case: Empty gallery (no images synced) returns 404 with clear message
- Edge case: `/next` with new client starts at index 0
- Error path: Missing `client` parameter returns 400

**Verification:** Both modes return correct images, client state persists across requests, wraparound works.

---

- U9. **Frontend SPA**

**Goal:** Build the admin panel and gallery viewer as a single-page application.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** U4, U6, U8

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/style.css`
- Modify: `src/index.ts` (static file serving)

**Approach:**
- Single HTML shell with JS-driven routing (hash-based: `#/admin`, `#/gallery`)
- Admin view: login form, 115 connection status, directory browser, sync controls, settings form
- Gallery view: image display, next/random toggle, client ID input (persisted in localStorage), auto-advance toggle with configurable interval
- API calls via `fetch()` with cookie-based auth for admin endpoints
- Minimal CSS (system font stack, responsive grid for images)
- Serve `public/` files from Hono's static middleware

**Test scenarios:**
- Happy path: Admin can log in, see directory list, trigger sync
- Happy path: Gallery view loads image on page load, next/random buttons work
- Happy path: Client ID persists across page refreshes via localStorage
- Edge case: Expired admin session redirects to login view
- Edge case: Empty gallery shows "no images" message

**Verification:** Full user flow works in browser: login, configure directory, sync, browse gallery.

---

- U10. **Deployment and Integration Testing**

**Goal:** Deploy to Cloudflare Workers, configure all bindings, and verify end-to-end.

**Requirements:** R9

**Dependencies:** U1-U9

**Files:**
- Modify: `wrangler.toml` (production config)

**Approach:**
- Create KV namespaces via `wrangler kv namespace create`
- Create D1 database via `wrangler d1 create`
- Run D1 migrations: `wrangler d1 execute gallery --file=src/db/schema.sql`
- Set secrets: `wrangler secret put ADMIN_PASS`, `wrangler secret put ELEVEN5_CLIENT_SECRET`
- Deploy: `wrangler deploy`
- Register 115 Open Platform app with Worker URL as redirect_uri
- End-to-end test: OAuth flow, directory sync, image retrieval

**Test scenarios:**
- Happy path: `wrangler deploy` succeeds, Worker responds to requests
- Happy path: OAuth flow completes in production with real 115 credentials
- Happy path: Scheduled sync runs on cron, images indexed
- Happy path: Public API returns images to unauthenticated callers

**Verification:** Live Worker at `*.workers.dev` serves gallery images via both polling and random modes.

---

## System-Wide Impact

- **Interaction graph:** Frontend -> Hono routes -> 115 API service -> KV/D1. Auth middleware intercepts admin routes. Rate limiter wraps all 115 outbound calls.
- **Error propagation:** 115 API errors bubble up as 502/503 to gallery API consumers. Rate-limit errors trigger backoff internally, surface as 503 only when circuit breaker opens.
- **State lifecycle risks:** Token refresh is a critical path — if refresh_token expires (user deauthorized app), all 115 operations fail until admin re-authorizes. KV eventual consistency means a token refresh may briefly serve stale token on other edge locations.
- **API surface parity:** All 115 API calls go through the single `eleven5.ts` service — rate limiting and caching apply uniformly.
- **Unchanged invariants:** 115's download URLs are time-limited and require specific headers (User-Agent, possibly cookies). The gallery API proxies or passes through these requirements.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 115 API rate limits are not publicly documented (discovered empirically) | Conservative limits (3 req/s), circuit breaker, exponential backoff |
| KV eventual consistency may cause brief stale-token reads after refresh | Acceptable — token refresh includes retry logic, worst case is one extra refresh call |
| D1 `NOT IN` with large seen-list may be slow | Cap seen-list at 500 entries, reset when exceeded |
| 115 download URLs may require specific headers not passable to browser | May need to proxy image requests through Worker (deferred to implementation) |
| Cloudflare Workers 30s CPU time limit may be tight for large directory sync | Paginate and process incrementally, not all at once |
| Single admin credential in env vars — no way to change password without redeploy | Acceptable for v1. Document: change `ADMIN_PASS` secret and redeploy |

---

## Sources & References

- [115 Open Platform API docs](https://www.yuque.com/115yun/open/)
- [p115client — Python 115 Open API client](https://github.com/ChenyangGao/p115client) — API endpoint reference
- [Hono framework](https://hono.dev/)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
- [Cloudflare D1 docs](https://developers.cloudflare.com/d1/)
- [Cloudflare KV docs](https://developers.cloudflare.com/kv/)
