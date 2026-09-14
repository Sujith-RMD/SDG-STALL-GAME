# pollinator-panic — project notes

A browser game (MediaPipe hand tracking) with a Redis-backed global leaderboard on
Vercel. Zero npm dependencies by design — keep it that way unless asked.

## Architecture facts
- **No SQL anywhere.** The leaderboard is Redis sorted sets:
  - `lb:all` — all-time, one member per `playerToken` (legacy: `sessionId`)
  - `lb:day:<YYYYMMDD>` — daily board, 7-day TTL
  - `score:detail:<member>` — hash of display details, 30-day TTL
  - `stats:games`, `stats:flowers`, `stats:ecosum` — counters
  - `GET /api/leaderboard` derives `aggregates.players` from `ZCARD lb:all`
- `api/_lib/redis.js` is a hand-rolled Upstash REST client. It has a **test
  override** (`_setOverride`) — that is how `test/local-check.mjs` runs the real
  handlers against an in-memory fake with no credentials.
- The Upstash REST API is **stateless**, so `WATCH`/`MULTI`/`EXEC` optimistic
  locking is unavailable. For atomic read-decide-write use a **Lua script**.
- Scores are always recomputed server-side from raw stats (`api/_lib/score.js`).
  The client never sends a score.

## Conventions
- **Comment style:** files open with a block comment explaining the design decision
  and the trade-off taken, not just what the code does. Match it.
- **Error handling:** every handler has a `handleError` that maps `httpError`
  (`{ status, message, __httpError: true }`) → JSON, `RedisUnavailableError` → 503,
  else 500. Bodies must stay generic — a test greps them for
  `upstash|redis|token|authorization|bearer|wasm|.js`.
- **Cache-Control:** success paths set their own; errors are always `no-store`.
- **Rate limiting:** fails **open** by documented decision (abuse protection, not
  integrity). Any destructive/admin route must instead **fail closed**.
- **Admin routes:** fail closed on a missing or <24-char secret · timing-safe
  compare · limiter *before* auth to throttle guessing · **dry run by default,
  explicit `"confirm": true` to mutate** · reject unknown body fields so a typo
  (`dryrun`) cannot silently apply.
- **Body size cap is 4 KB** and applies to pre-parsed bodies too (`api/_lib/http.js`).

## Tests
- `npm test` → `test/local-check.mjs`, a single sequential script of numbered
  blocks. Add new work as a new `Step N` block. **71 checks.**
- `python sql/trim-leaderboard.selftest.py` → 12 checks for the SQL trim.
- The fake Redis must be extended with any new command a handler uses; it throws
  `unsupported command` otherwise.

## Known sharp edges
- **Redis ranks ascend by score** — rank `0` is the lowest. To keep the top 3 you
  need `ZREMRANGEBYRANK key 0 -4`, not `3 -1`. There is no "keep top N" command.
- The Lua trim script has never been run against a real Redis (no redis-server /
  lua / docker available locally). It is covered by a JS model in the fake plus a
  structural test; the handler independently reads the board back afterwards.
