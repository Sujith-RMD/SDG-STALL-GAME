# 🐝 Pollinator Panic

> **You are the last bee of a dying ecosystem.** Pinch your fingers to fly. Pollinate flowers. Bring the land back to life.
> Built for a college orientation stall — one laptop (or a whole row of them), one webcam, no install for players.

**Pollinator Panic** is a camera-controlled, Flappy-Bird-style conservation game. Instead of pressing a key, players *pinch their thumb and index finger together* to flap the bee, guided by real-time AI hand tracking running entirely in the browser. Every round teaches SDG 15 (Life on Land): pollinate flowers, clear plastic, revive native plants — and watch the ecosystem meter respond to your choices.

Scores land on a **global leaderboard shared across every device at the stall**, so a line of students can compete in real time.

---

## 🎮 Gameplay

| Mechanic | Detail |
|---|---|
| **Flap** | Pinch thumb + index fingers (MediaPipe hand tracking, GPU→CPU fallback) — Spacebar/tap works as a backup |
| **🌸 Pollinate** | Collect flowers — +10 pts, ecosystem + |
| **🗑️ Clean plastic** | Grab floating waste — +20 pts, risky: it blocks the flower lane |
| **🌱 Revive natives** | Rare plants below 85% ecosystem — +50 pts |
| **☁️🧴 Avoid** | Smog and pesticide gates — damage the bee and the ecosystem |
| **🔥 Combo** | Chained pickups without a hit multiply live points (up to ×5) |
| **⏱ Round** | 90 seconds, then an impact report + instant global submission |

The **ecosystem meter** is the real score: high eco heals the land and adds a large end-of-round bonus; low eco changes what spawns (natives disappear, hazards dominate).

---

## ✨ Features

- 🧠 **In-browser AI hand tracking** — no server round-trip for vision, ~10 MB model download on first launch
- 🌍 **Global leaderboard** — Upstash Redis sorted sets, all stall laptops share one live board (15s edge cache, immediate refresh after your own submission)
- 📴 **Offline fallback** — if the backend is unreachable, scores persist to `localStorage` and the game keeps working
- 🔐 **Server-authoritative scoring** — the client never sends a score; the server recomputes it from raw stats and rejects impossible ones
- 🛡️ **Hardened** — strict CSP (no `unsafe-inline`/`unsafe-eval`), permission policy, per-IP rate limiting, global daily circuit breaker
- ♻️ **Zero runtime dependencies** — vanilla ES-module frontend, dependency-free Node serverless functions, hand-written Redis REST client
- ✅ **55-check self-testing suite** — runs the real API handlers end-to-end against an in-memory Redis fake, no credentials needed

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla **HTML5 / CSS3 / JavaScript (ES modules)** — no framework, no bundler, no build step |
| Rendering | **Canvas 2D** (game + camera preview) |
| Hand tracking | **MediaPipe Tasks Vision** `@mediapipe/tasks-vision@0.10.14` (WASM, GPU→CPU fallback) via jsDelivr |
| Camera | Native **`getUserMedia`** (720p, user-facing) |
| Audio | **Web Audio API** — synthesized oscillators, no audio files |
| Fonts | **Google Fonts** (Outfit) |
| Backend | **Vercel Serverless Functions** (Node.js, zero-dependency CommonJS) |
| Database | **Upstash Redis** (REST API — ideal for serverless: HTTP, no TCP) |
| Hosting / CDN | **Vercel** (static + functions, edge caching) |
| Security | `vercel.json` headers: CSP, Permissions-Policy, HSTS, X-Frame-Options, nosniff, Referrer-Policy, COOP |
| Testing | Custom zero-dependency Node test harness (55 checks) |
| Analytics | Vercel Web Analytics (platform-injected script) |

### Architecture

```
Browser (vanilla JS · Canvas · MediaPipe hand tracking · Web Audio)
   │  getUserMedia → pinch detection happens 100% locally
   ▼
Vercel Serverless API            Vercel Edge Cache
  POST /api/session  ──────────►  (leaderboard GETs are cached
  POST /api/scores                 15s, stale-while-revalidate 30s)
  GET  /api/leaderboard
   │  zero-dep REST client, one HTTP pipeline per request
   ▼
Upstash Redis
  lb:all / lb:day:YYYYMMDD   (sorted sets — global + daily boards)
  score:detail:<id>          (hashes — per-entry details)
  session:<id> / submitted:<id>  (15-min TTL — replay protection)
  ratelimit:*                (fixed-window counters)
   ↘ if Redis/API is down: localStorage fallback keeps the game playable
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js 18+** (for the test suite and `vercel dev`)
- A webcam
- A free [Upstash Redis](https://console.upstash.com) database (only needed for the global board — the game runs without it)

### Run it

No build step — it's static files + serverless functions.

```bash
# 1. Clone
git clone <your-repo-url> pollinator-panic
cd pollinator-panic

# 2. (optional but recommended) link to Vercel and pull env vars
vercel link
vercel env pull .env.local

# 3. Run everything (static site + API functions) locally
vercel dev
# → http://localhost:3000
```

> **Camera note:** browsers only grant camera access on **HTTPS or localhost** — `vercel dev` satisfies this. Opening `index.html` via `file://` will not work.

Without `.env.local` the game still runs: the API answers `503`, the frontend detects it and falls back to the local localStorage leaderboard. Perfect for UI work.

### Environment variables

Never commit real credentials — `.gitignore` protects `.env*`.

| Variable | Required | Description |
|---|---|---|
| `KV_REST_API_URL` | yes* | Upstash REST URL — auto-injected by the **Upstash Marketplace integration** in Vercel (Project → Storage) |
| `KV_REST_API_TOKEN` | yes* | Upstash REST **write** token (not the read-only token — scores must write) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | fallback | Manual alternative — copy both from the Upstash console |
| `RATE_LIMIT_SESSION_PER_HOUR` | no | Default `120` |
| `RATE_LIMIT_SCORES_PER_HOUR` | no | Default `240` |
| `RATE_LIMIT_LEADERBOARD_PER_MIN` | no | Default `120` |
| `GLOBAL_DAILY_SESSION_LIMIT` | no | Default `3000` |
| `ADMIN_TRIM_TOKEN` | no | Secret for the admin trim route. Unset (or under 24 chars) ⇒ the route returns `503` and refuses to run |
| `LEADERBOARD_KEEP` | no | How many entries a trim keeps. Default `3` |
| `RATE_LIMIT_ADMIN_TRIM_PER_MIN` | no | Default `10` |

\* one of the two pairs. See `.env.example`.

---

## 🔌 API Reference

All endpoints are **same-origin only** (no CORS by design), accept/receive JSON, and are rate-limited per IP. The one route under `/api/admin/` additionally requires a secret.

### `POST /api/session`

```jsonc
// request
{ "name": "Bee Hero", "playerToken": "e3a7…" }   // 1–14 chars, control chars stripped;
                                                 // playerToken is OPTIONAL — present on
                                                 // RETRY, omitted on NEW GAME / first visit

// 200
{ "sessionId": "9f1c…", "playerToken": "e3a7…" } // 32-hex crypto-random, 15-min TTL

// errors: 400 invalid name/token · 405 wrong method · 429 rate-limited · 503 backend down
```

### `POST /api/scores`

```jsonc
// request — the client sends RAW STATS, never a score
{
  "sessionId": "9f1c…",
  "durationMs": 87234,
  "flowers": 23, "cleanup": 4, "natives": 2,
  "pipes": 41, "closeCalls": 6, "bestCombo": 9,
  "bee": 72, "eco": 63,
  "playerToken": "e3a7…"           // optional — present on RETRY; legacy clients omit it
}

// 200 — the server computes the authoritative score
{ "score": 512, "rank": 3, "best": 512, "newBest": true }
// best/newBest = the player's personal best after this attempt (RETRY support)

// errors: 400 invalid/impossible stats · 404 session expired · 409 already submitted · 413 body > 4 KB
```

### `GET /api/leaderboard?period=all|today`

```jsonc
// 200
{
  "period": "all",
  "entries": [ { "rank": 1, "name": "Bee Hero", "score": 512, "flowers": 23, "eco": 63 } ],  // top 10
  "aggregates": { "players": 12, "games": 128, "flowers": 1042, "avgEco": 58 }
  // players = unique players (one entry per token); games = finished runs, retries included
}
```

---

## 🧹 Trimming the leaderboard

Keeps only the top N entries of a board and deletes the rest. There are two
implementations of the same operation:

- **`POST /api/admin/trim-leaderboard`** — the live Redis boards. This is the
  one you actually run. Implementation: `api/_lib/trim.js`.
- **`sql/trim-leaderboard.sql`** — the same trim expressed as SQL, for a
  Postgres/MySQL/SQLite copy of the data. Runnable in all three dialects, with
  a self-test at `sql/trim-leaderboard.selftest.py`.

### `POST /api/admin/trim-leaderboard`

```jsonc
// headers: Authorization: Bearer <ADMIN_TRIM_TOKEN>   (or X-Admin-Token: <value>)

// request — the body is OPTIONAL
{
  "confirm": true,      // REQUIRED to delete anything
  "dryRun":  false,     // force a preview even alongside confirm:true
  "scope":   "all",     // "all" (default) | "today" | "both"
  "keep":    3          // 1..100, default LEADERBOARD_KEEP or 3
}

// 200
{
  "ok": true, "applied": true, "dryRun": false, "scope": "all", "keep": 3,
  "boards": [{
    "key": "lb:all", "status": "ok",
    "before": 12, "after": 3, "expected": 3, "removed": 9, "wouldRemove": 9,
    "cutoff": 220, "tiebreak": "timestamp", "countVerified": true,
    "kept": [ { "rank": 1, "member": "e3a7…", "name": "Bee Hero", "score": 512, "ts": 1756… } ]
  }],
  "warnings": ["lb:all was trimmed: GET /api/leaderboard derives aggregates.players …"]
}

// errors: 400 bad field/value · 401 bad or absent secret · 405 wrong method
//         409 the board moved mid-trim (nothing removed) · 413 body > 4 KB
//         429 rate-limited · 500 post-trim verification failed · 503 not configured / backend down
```

**🔒 Dry run is the default.** An empty body, or any body without
`"confirm": true`, only reports what *would* happen — so a mistyped `curl`
cannot wipe the board. Deleting takes an explicit `"confirm": true`.

```bash
# preview (safe)
curl -X POST https://your-app.vercel.app/api/admin/trim-leaderboard \
  -H "Authorization: Bearer $ADMIN_TRIM_TOKEN"

# keep only the top 3
curl -X POST https://your-app.vercel.app/api/admin/trim-leaderboard \
  -H "Authorization: Bearer $ADMIN_TRIM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirm": true}'
```

**How it stays safe.** Redis has no `BEGIN`/`COMMIT`, and `WATCH`/`MULTI`/`EXEC`
is unusable over the stateless Upstash REST API (`WATCH` is connection-scoped),
so the read-decide-write sequence runs as a **single Lua script** — the only
primitive that makes it atomic. The script mirrors the SQL version step for step:
read the cutoff score → **pre-flight check** that no entry outranks the cutoff
more times than there are keepers (abort *before* deleting if so) → remove
everything strictly below the cutoff with `ZREMRANGEBYSCORE` → remove the
boundary losers → **post-check** that the survivor count is N and that no
survivor scores below the cutoff. The handler then reads the board back
independently and refuses to report success if the two disagree.

**Ties.** If several entries share the N-th-place score, the tie is broken by
`ts` ascending (earliest wins), then by member — the same rule as the SQL
script's `ORDER BY score DESC, created_at ASC, id ASC`. An entry with no
recorded `ts` loses to one with provenance. If more than 500 entries are tied,
the script keeps the right *count* but falls back to Redis rank order and says
so in `warnings`.

**Two things to know before running it.**

1. **`aggregates.players` drops.** `GET /api/leaderboard` reports
   `players` as `ZCARD lb:all`, so trimming `lb:all` lowers that number. The
   `stats:*` counters are deliberately *not* rewritten (they are historical
   totals) and the drift is reported in `warnings`.
2. **No rollback.** Redis does not roll Lua back on error, so a failed
   post-check means the board may be partially trimmed. That check is
   unreachable by construction, so a failure means the script is wrong — which
   is why it returns `500` rather than pretending to have succeeded. Inspect
   the board before retrying.

> ⚠️ **Redis rank direction.** Redis sorted-set ranks ascend by score, so rank
> `0` is the **lowest** entry. To keep the highest 3 with a bare command you
> want `ZREMRANGEBYRANK lb:all 0 -4` — *not* `… 3 -1`, which keeps the three
> **lowest** scores. There is no "keep the top N" command in Redis, which is
> exactly why the route uses a Lua script that computes the cutoff score.

---

## 🔁 Retry & New Game (personal best)

- **🔁 RETRY — same player, new session.** Every attempt gets a fresh 15-minute session (one-submission-per-session intact) filed under the same server-issued `playerToken`.
- **👤 NEW GAME — new identity.** Clears the client token so the next student mints their own — no accounts, no login.
- **Personal best:** a player's board entry always holds their **highest** score (atomic `ZADD GT`) — a lower retry never replaces it, and the stored run details always describe the best run.
- **Same display name ≠ same player.** Identity is the token, never the typed name — two students both named "Alex" stay separate entries.
- **A page refresh always starts a fresh identity.** `sessionStorage` survives F5, so the token is wiped at page boot instead of risking a merge into the previous player's entry.

---

## 🧮 Scoring (server-side authority)

The server recomputes every score from base constants — the live combo multiplier is deliberately **not** creditable, which makes the ranked score deterministic and combo-farm-proof:

```
score = flowers×10 + cleanup×20 + natives×50 + pipes×5 + closeCalls×25 + round(eco × 2)
```

Every stat is re-validated against plausibility caps derived from spawn rates and the 90-second round:

| Stat | Cap | Stat | Cap |
|---|---|---|---|
| durationMs | 5 000 – 95 000 | pipes | 90 |
| flowers | 60 | bestCombo | 60 |
| cleanup | 40 | bee / eco | 0 – 100 |
| natives | 15 | | |

Violations → `400` before any Redis work. One submission per session (atomic `SET NX`), sessions expire after 15 minutes, daily boards persist 7 days.

---

## 🛡️ Security

**Headers** (via `vercel.json`, all routes): strict `Content-Security-Policy` allowing exactly the resources the game uses and nothing else — no `unsafe-inline` (the boot watchdog lives in an external file, meter colors in CSS), no generic `unsafe-eval` (only `'wasm-unsafe-eval'`, required for MediaPipe WASM inference); `Permissions-Policy` keeps `camera=(self)` while denying microphone/geolocation/etc.; plus HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP.

**Rate limiting** (Upstash fixed-window counters, atomic `SET NX` + `INCR`, shared across all serverless instances):

| Scope | Limit | Env override |
|---|---|---|
| `POST /api/session` | 120 / IP / hour | `RATE_LIMIT_SESSION_PER_HOUR` |
| `POST /api/scores` | 240 / IP / hour | `RATE_LIMIT_SCORES_PER_HOUR` |
| `GET /api/leaderboard` | 120 / IP / min (origin hits; edge cache absorbs polling) | `RATE_LIMIT_LEADERBOARD_PER_MIN` |
| `POST /api/admin/trim-leaderboard` | 10 / IP / min | `RATE_LIMIT_ADMIN_TRIM_PER_MIN` |
| Global sessions | 3 000 / rolling 24 h (free-tier circuit breaker, auto-recovers) | `GLOBAL_DAILY_SESSION_LIMIT` |

Limits are deliberately generous: a stall full of students shares one public IP. Exceeding a limit returns `429` + `Retry-After` + clean JSON. If Redis itself is down, the limiter **fails open** (logged server-side) so a limiter outage can never take the game down — the main Redis path already degrades to clean `503`s.

**The admin trim route is the one exception to "fail open".** It is authenticated with `ADMIN_TRIM_TOKEN` (constant-time compared, `Authorization: Bearer …` or `X-Admin-Token: …`) and **fails closed**: if the secret is missing or under 24 characters the route returns `503` and refuses to run. The rate limiter runs *before* the token check, so it is the only thing standing between the secret and an offline brute-force attempt.

**Other decisions:** CORS is intentionally disabled (game and API share one origin — absence of `Access-Control-Allow-Origin` *is* the policy); Redis credentials exist only in server-side env vars; all user-facing text (leaderboard names included) is rendered via `textContent`; API errors are generic clientside, detailed server-side only.

---

## 🧪 Testing

```bash
npm test
```

**71 checks, zero credentials required.** The suite runs the *real* API handlers end-to-end against an in-memory Redis fake injected through the Redis client's test override, covering: session minting & name validation · server-side scoring & impossible-stat rejection · one-submission-per-session · ranking/aggregates/top-10 · rate limiting (limits, `Retry-After`, multi-IP independence, global cap, concurrent-request atomicity) · Redis-outage behavior · security headers/CSP · secrets audit · XSS-safe rendering · error bodies stay generic · **admin trim** (auth fails closed, dry-run default, ties, idempotency, scopes, small/empty boards, validation).

**One honest gap.** The fake Redis cannot execute Lua, so its `EVAL` delegates to a JS model of the trim script (`trimScriptModel` in `test/local-check.mjs`) — everything else in the admin path is production code. Two things compensate: the handler reads the board back after every trim and refuses to report success if the count disagrees, and the last check in the suite asserts structurally that the real Lua still performs each safety step (including a regression guard against the inverted `ZREMRANGEBYRANK` rank direction). The Lua itself has not been executed against a real Redis in this repo.

```bash
python sql/trim-leaderboard.selftest.py   # SQL variant: 12 checks
```

---

## 📁 Project Structure

```
pollinator-panic/
├── index.html              # single page (game + leaderboard panel)
├── css/style.css
├── js/
│   ├── main.js             # game loop, UI flow, leaderboard client
│   ├── game.js             # gameplay, physics, SFX/music (Web Audio)
│   ├── vision.js           # MediaPipe hand tracking + pinch detection
│   ├── ecosystem.js        # ecosystem model
│   ├── ui.js               # DOM updates (textContent-only rendering)
│   └── boot-watchdog.js    # load-failure helper (CSP-safe external file)
├── api/
│   ├── session.js          # POST — session minting
│   ├── scores.js           # POST — submissions
│   ├── leaderboard.js      # GET  — boards + aggregates
│   ├── admin/
│   │   └── trim-leaderboard.js  # POST — keep the top N entries (token-gated, dry-run default)
│   └── _lib/
│       ├── redis.js        # zero-dep Upstash REST client (+ test override)
│       ├── ratelimit.js    # Redis fixed-window limiter
│       ├── http.js         # body parsing (4 KB cap), error helpers
│       ├── score.js        # scoring formula + caps
│       ├── trim.js         # atomic trim: Lua script + verification report
│       └── validate.js     # stat re-validation
├── sql/
│   ├── trim-leaderboard.sql          # same trim as SQL (Postgres / MySQL / SQLite)
│   └── trim-leaderboard.selftest.py  # 12-check proof it works (in-memory SQLite)
├── test/local-check.mjs    # 71-check suite (in-memory Redis fake)
├── vercel.json             # security headers
├── .env.example            # variable names only — no secrets
└── package.json            # zero dependencies
```

---

## ☁️ Deploying

1. Push to GitHub/GitLab and import the repo in **Vercel** (framework preset: *Other* — no build command, output = repo root).
2. **Vercel → Project → Storage → add Upstash Redis** (Marketplace integration). It injects `KV_REST_API_URL` + `KV_REST_API_TOKEN` automatically — done.
3. Deploy. First launch on a device downloads the ~10 MB hand-tracking model; afterwards it's cached.
4. Optional: enable **Web Analytics** in the Vercel dashboard (the page already loads the insights script).

After deploying, sanity-check: camera prompt works → pinch flies the bee → finishing a round shows "🌍 Submitted to the global board" and the score appears without a reload → DevTools console shows no CSP violations.

---

## 🧰 Troubleshooting

| Symptom | Fix |
|---|---|
| "Camera is off" / no permission prompt | Site must be served over HTTPS or localhost; check browser camera permissions; close other apps using the webcam |
| "Game failed to fully load" after 7 s | The AI library/model downloads from CDNs on first launch — check the network, then hard-refresh (`Ctrl+F5`) |
| Console shows CSP violations | A new external resource was added — extend `vercel.json`'s CSP deliberately, never with `unsafe-inline` |
| Leaderboard shows local scores only | Backend unreachable (see status line) — check Vercel env vars; the game is still fully playable |
| `429 Too many requests` | Working as intended — wait for the `Retry-After` window (limits are per-IP; stall Wi-Fi shares one IP) |

---

## 📜 Design Notes

- **Why REST Redis?** Serverless functions can't hold TCP pools; Upstash's HTTP API fits perfectly. The client is ~95 lines: one `fetch` pipeline per operation.
- **Why fixed-window rate limits?** Simple, atomic (`INCR` is the serialization point), and the generous limits make the ~2× window-boundary burst irrelevant.
- **Why localStorage fallback?** A stall with flaky venue Wi-Fi must never stop the game; the board just switches scope with a clear status message.
- **Why no `@upstash/ratelimit` / `@upstash/redis`?** Two Redis commands cover it. Fewer dependencies, fewer supply-chain surprises, and the existing client already pipelines.

---

*Built as an educational demo for a college orientation stall (SDG 15: Life on Land). No formal license attached yet — reach out before reusing the assets.*
