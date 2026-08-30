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

\* one of the two pairs. See `.env.example`.

---

## 🔌 API Reference

All endpoints are **same-origin only** (no CORS by design), accept/receive JSON, and are rate-limited per IP.

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
| Global sessions | 3 000 / rolling 24 h (free-tier circuit breaker, auto-recovers) | `GLOBAL_DAILY_SESSION_LIMIT` |

Limits are deliberately generous: a stall full of students shares one public IP. Exceeding a limit returns `429` + `Retry-After` + clean JSON. If Redis itself is down, the limiter **fails open** (logged server-side) so a limiter outage can never take the game down — the main Redis path already degrades to clean `503`s.

**Other decisions:** CORS is intentionally disabled (game and API share one origin — absence of `Access-Control-Allow-Origin` *is* the policy); Redis credentials exist only in server-side env vars; all user-facing text (leaderboard names included) is rendered via `textContent`; API errors are generic clientside, detailed server-side only.

---

## 🧪 Testing

```bash
npm test
```

**55 checks, zero credentials required.** The suite runs the *real* API handlers end-to-end against an in-memory Redis fake injected through the Redis client's test override, covering: session minting & name validation · server-side scoring & impossible-stat rejection · one-submission-per-session · ranking/aggregates/top-10 · rate limiting (limits, `Retry-After`, multi-IP independence, global cap, concurrent-request atomicity) · Redis-outage behavior · security headers/CSP · secrets audit · XSS-safe rendering · error bodies stay generic.

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
│   └── _lib/
│       ├── redis.js        # zero-dep Upstash REST client (+ test override)
│       ├── ratelimit.js    # Redis fixed-window limiter
│       ├── http.js         # body parsing (4 KB cap), error helpers
│       ├── score.js        # scoring formula + caps
│       └── validate.js     # stat re-validation
├── test/local-check.mjs    # 55-check suite (in-memory Redis fake)
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
