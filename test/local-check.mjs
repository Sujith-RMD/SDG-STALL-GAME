/*
 * Step 1 + Step 2 (rate limiting) + Step 3 (security headers) local verification — no credentials required.
 *
 * Runs the REAL api handlers end-to-end against an in-memory Redis fake
 * (injected through api/_lib/redis.js's test override), covering:
 *   - session minting + name validation
 *   - server-side score computation + impossible-value rejection
 *   - one-submission-per-session enforcement
 *   - ranking, aggregates and the top-10 read model
 *   - the unconfigured-backend (503) path
 *
 * Run:  node test/local-check.mjs   (or: npm test)
 */
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _setOverride, redis } = require("../api/_lib/redis.js");
const { computeScore } = require("../api/_lib/score.js");
const { enforceRateLimit } = require("../api/_lib/ratelimit.js");
const sessionHandler = require("../api/session.js");
const scoresHandler = require("../api/scores.js");
const leaderboardHandler = require("../api/leaderboard.js");

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✔ ${label}`);
}

/* ---------------- in-memory Redis fake (Upstash-compatible shapes) ----- */
const store = new Map();
function purge(k) {
  const e = store.get(k);
  if (e && e.exp && e.exp <= Date.now()) store.delete(k);
}
function entry(k) {
  purge(k);
  if (!store.has(k)) store.set(k, { z: new Map(), h: new Map(), v: null, exp: null });
  return store.get(k);
}

function setOverrideFake() {
  _setOverride(async (commands) =>
    commands.map((cmd) => {
      const [op] = cmd;
      switch (op) {
        case "SET": {
          const [, k, v, ...rest] = cmd;
          const nx = rest.includes("NX");
          purge(k);
          if (nx && store.has(k)) return null;
          const e = entry(k);
          e.v = String(v);
          e.h = new Map();
          e.z = new Map();
          const ex = rest.indexOf("EX");
          if (ex !== -1) e.exp = Date.now() + Number(rest[ex + 1]) * 1000;
          return "OK";
        }
        case "GET": {
          purge(cmd[1]);
          const e = store.get(cmd[1]);
          return e ? e.v : null;
        }
        case "ZADD": {
          // Supports the GT option (Redis >= 6.2): only update when the new
          // score is strictly higher — the personal-best primitive.
          const [, k, ...rest] = cmd;
          const gt = rest.includes("GT");
          const args = rest.filter((a) => a !== "GT");
          const score = Number(args[0]);
          const member = String(args[1]);
          const z = entry(k).z;
          const existing = z.get(member);
          if (gt && existing !== undefined && !(score > existing)) return 0;
          z.set(member, score);
          return existing === undefined ? 1 : 0;
        }
        case "ZREVRANGE": {
          const [, k, start, stop] = cmd;
          const e = store.get(k);
          if (!e) return [];
          const items = [...e.z.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
          const slice = items.slice(Number(start), Number(stop) + 1);
          const out = [];
          for (const [m, s] of slice) {
            out.push(m);
            out.push(String(s));
          }
          return out;
        }
        case "ZSCORE": {
          const e = store.get(cmd[1]);
          if (!e) return null;
          const v = e.z.get(String(cmd[2]));
          return v === undefined ? null : v;
        }
        case "ZCARD": {
          const e = store.get(cmd[1]);
          return e ? e.z.size : 0;
        }
        case "ZREVRANK": {
          const [, k, member] = cmd;
          const e = store.get(k);
          if (!e) return null;
          const items = [...e.z.entries()].sort((a, b) => b[1] - a[1]);
          const idx = items.findIndex(([m]) => m === member);
          return idx === -1 ? null : idx;
        }
        case "HSET": {
          const [, k, ...pairs] = cmd;
          const e = entry(k);
          for (let i = 0; i < pairs.length; i += 2) e.h.set(pairs[i], String(pairs[i + 1]));
          return pairs.length / 2;
        }
        case "HGET": {
          purge(cmd[1]);
          const e = store.get(cmd[1]);
          if (!e) return null;
          const f = String(cmd[2]);
          return e.h.has(f) ? e.h.get(f) : null;
        }
        case "HMGET": {
          const [, k, ...fields] = cmd;
          purge(k);
          const e = store.get(k);
          if (!e) return fields.map(() => null);
          return fields.map((f) => (e.h.has(f) ? e.h.get(f) : null));
        }
        case "INCR": {
          const e = entry(cmd[1]);
          e.v = String((Number(e.v) || 0) + 1);
          return Number(e.v);
        }
        case "INCRBY": {
          const [, k, by] = cmd;
          const e = entry(k);
          e.v = String((Number(e.v) || 0) + Number(by));
          return Number(e.v);
        }
        case "EXPIRE": {
          const [, k, sec] = cmd;
          if (!store.has(k)) return 0;
          entry(k).exp = Date.now() + Number(sec) * 1000;
          return 1;
        }
        case "TTL": {
          purge(cmd[1]);
          const e = store.get(cmd[1]);
          if (!e) return -2;
          return e.exp ? Math.max(0, Math.ceil((e.exp - Date.now()) / 1000)) : -1;
        }
        default:
          throw new Error(`fake redis: unsupported command ${op}`);
      }
    })
  );
}

/* ---------------- mocks ---------------- */
function mockReq({ method = "POST", body = undefined, query = {}, headers = {} } = {}) {
  return { method, body, query, headers };
}
function clearFakeStore() {
  store.clear(); // simulates a wiped Redis — proves limiter state is not in process memory
}
function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res;
}
function streamReq(jsonText) {
  const s = new PassThrough();
  s.method = "POST";
  s.headers = {};
  s.query = {};
  queueMicrotask(() => {
    s.write(Buffer.from(jsonText));
    s.end();
  });
  return s;
}
const HEX = /^[a-f0-9]{32}$/;
const statsFor = (over = {}) => ({
  sessionId: "x", durationMs: 60000, flowers: 3, cleanup: 1, natives: 1,
  pipes: 12, closeCalls: 2, bestCombo: 4, bee: 80, eco: 45, ...over,
});

/* ---------------- 1. unconfigured backend -> 503 ---------------- */
{
  const res = await call(sessionHandler, mockReq({ body: { name: "Bee" } }));
  assert.equal(res.statusCode, 503, "unconfigured backend must 503");
  ok("unconfigured backend -> 503 (frontend falls back to localStorage)");
}

/* ---------------- enable the fake backend ---------------- */
setOverrideFake();

/* ---------------- 2. POST /api/session ---------------- */
{
  const res = await call(sessionHandler, mockReq({ body: { name: "  Bee Hero " } }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body.sessionId, HEX, "sessionId must be 32 hex chars");
  const record = JSON.parse(store.get(`session:${res.body.sessionId}`).v);
  assert.equal(record.name, "Bee Hero", "name must be trimmed");
  ok("valid name -> 200 + cryptographically random sessionId (trimmed, stored with TTL)");
}
{
  const res = await call(sessionHandler, mockReq({ body: { name: "   " } }));
  assert.equal(res.statusCode, 400);
  ok("empty/whitespace name -> 400");
}
{
  const res = await call(sessionHandler, mockReq({ body: { name: "a".repeat(15) } }));
  assert.equal(res.statusCode, 400);
  ok("name longer than 14 chars -> 400");
}
{
  const res = await call(sessionHandler, mockReq({ body: { name: "Bee\nHero\x00" } }));
  assert.equal(res.statusCode, 200);
  const record = JSON.parse(store.get(`session:${res.body.sessionId}`).v);
  assert.ok(!/[\x00-\x1F]/.test(record.name), "control chars must be stripped");
  ok("control characters stripped from name");
}
{
  const res = await call(sessionHandler, mockReq({ body: "{not json" }));
  assert.equal(res.statusCode, 400);
  ok("malformed JSON body -> 400");
}
{
  const res = await call(sessionHandler, mockReq({ method: "GET", body: { name: "Bee" } }));
  assert.equal(res.statusCode, 405);
  ok("GET /api/session -> 405");
}
{
  const res = await call(sessionHandler, streamReq(JSON.stringify({ name: "Streamy" })));
  assert.equal(res.statusCode, 200);
  ok("streamed JSON body (non-preparsed) -> 200");
}

/* ---------------- 3. POST /api/scores ---------------- */
let alphaId, bravoId;
{
  const s = await call(sessionHandler, mockReq({ body: { name: "Alpha" } }));
  alphaId = s.body.sessionId;
  const stats = statsFor({ sessionId: alphaId });
  const res = await call(scoresHandler, mockReq({ body: stats }));
  assert.equal(res.statusCode, 200);
  const expected = computeScore({ flowers: 3, cleanup: 1, natives: 1, pipes: 12, closeCalls: 2, eco: 45 });
  assert.equal(res.body.score, expected, "server computes the score from the game's base constants");
  assert.equal(res.body.score, 300);
  assert.equal(res.body.rank, 1);
  ok(`score computed server-side (${res.body.score} pts) + rank returned`);
}
{
  const res = await call(scoresHandler, mockReq({ body: statsFor({ sessionId: alphaId }) }));
  assert.equal(res.statusCode, 409, "duplicate submission must be rejected");
  ok("duplicate submission of the same session -> 409");
}
{
  const s = await call(sessionHandler, mockReq({ body: { name: "Bravo" } }));
  bravoId = s.body.sessionId;
  const stats = statsFor({
    sessionId: bravoId, flowers: 5, cleanup: 2, natives: 1,
    pipes: 15, closeCalls: 3, eco: 60,
  });
  const res = await call(scoresHandler, mockReq({ body: stats }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.score, 410);
  assert.equal(res.body.rank, 1, "higher score must take rank 1");
  ok("second player ranked above the first (sorted set ranking)");
}
{
  const res = await call(scoresHandler, mockReq({ body: statsFor({ sessionId: "f".repeat(32) }) }));
  assert.equal(res.statusCode, 404);
  ok("submission without a live session -> 404");
}
for (const [label, over] of [
  ["flowers=999 rejected", { flowers: 999 }],
  ["closeCalls > pipes rejected", { closeCalls: 99 }],
  ["durationMs=100 rejected", { durationMs: 100 }],
  ["eco=150 rejected", { eco: 150 }],
  ["bestCombo=999 rejected", { bestCombo: 999 }],
]) {
  const res = await call(scoresHandler, mockReq({ body: statsFor(over) }));
  assert.equal(res.statusCode, 400, label);
  ok(`impossible stats rejected -> 400 (${label})`);
}
{
  const res = await call(scoresHandler, mockReq({ body: statsFor({ sessionId: "not-a-session-id" }) }));
  assert.equal(res.statusCode, 400);
  ok("malformed sessionId -> 400");
}
{
  const body = statsFor({ sessionId: "a".repeat(32) });
  delete body.flowers;
  const res = await call(scoresHandler, mockReq({ body }));
  assert.equal(res.statusCode, 400);
  ok("missing required field -> 400");
}
{
  const res = await call(scoresHandler, mockReq({ method: "GET", body: statsFor() }));
  assert.equal(res.statusCode, 405);
  ok("GET /api/scores -> 405");
}

/* ---------------- 4. GET /api/leaderboard ---------------- */
{
  const res = await call(leaderboardHandler, mockReq({ method: "GET", query: {} }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.entries[0].name, "Bravo");
  assert.equal(res.body.entries[0].score, 410);
  assert.equal(res.body.entries[1].name, "Alpha");
  assert.equal(res.body.entries[0].rank, 1);
  assert.equal(res.body.aggregates.games, 2);
  assert.equal(res.body.aggregates.players, 2); // distinct members on lb:all (unique players)
  assert.equal(res.body.aggregates.flowers, 3 + 5);
  assert.equal(res.body.aggregates.avgEco, Math.round((45 + 60) / 2));
  assert.match(res.headers["cache-control"], /s-maxage=15/);
  ok("leaderboard: highest first, details + aggregates + edge-cache header");
}
{
  const res = await call(leaderboardHandler, mockReq({ method: "GET", query: { period: "today" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.period, "today");
  assert.equal(res.body.entries.length, 2);
  ok("period=today board works");
}
{
  const res = await call(leaderboardHandler, mockReq({ method: "POST", query: {} }));
  assert.equal(res.statusCode, 405);
  ok("POST /api/leaderboard -> 405");
}

/* ---------------- 5. top-10 cap ---------------- */
{
  for (let i = 0; i < 10; i++) {
    const s = await call(sessionHandler, mockReq({ body: { name: `P${i}` } }));
    const stats = statsFor({
      sessionId: s.body.sessionId, flowers: i, cleanup: 0, natives: 0,
      pipes: 10, closeCalls: 0, bestCombo: 0, bee: 100, eco: 10,
    });
    await call(scoresHandler, mockReq({ body: stats }));
  }
  const res = await call(leaderboardHandler, mockReq({ method: "GET", query: { period: "today" } }));
  assert.equal(res.body.entries.length, 10, "only top 10 returned");
  assert.equal(res.body.entries[0].name, "Bravo");
  assert.equal(res.body.entries[1].name, "Alpha");
  assert.equal(res.body.aggregates.games, 12);
  ok("top-10 cap enforced (12 players submitted, 10 returned)");
}

/* ---------------- 6. backend down again -> 503 ---------------- */
_setOverride(null);
{
  const res = await call(sessionHandler, mockReq({ body: { name: "Bee" } }));
  assert.equal(res.statusCode, 503);
  ok("backend failing at runtime -> 503 (never 500/crash)");
}

/* ==================== Step 2: rate limiting ==================== */
/* The limiter state lives in Redis (the fake store), so a fresh fake
 * keeps the per-IP budgets from the Step 1 checks irrelevant here. The
 * Step 2 checks use dedicated IPs/keys to stay independent of Step 1
 * traffic and of each other. */
setOverrideFake();

/* ---------------- 7. fixed-window core: allow, exhaust, 429, Retry-After -- */
{
  const req = mockReq({ headers: { "x-real-ip": "7.7.7.7" } });
  const r1 = mockRes(); const a1 = await enforceRateLimit(req, r1, "test-direct", 2, 60);
  const r2 = mockRes(); const a2 = await enforceRateLimit(req, r2, "test-direct", 2, 60);
  const r3 = mockRes(); const a3 = await enforceRateLimit(req, r3, "test-direct", 2, 60);
  assert.ok(a1 && a2, "requests below the limit succeed");
  assert.equal(a1.remaining, 1);
  assert.equal(a2.remaining, 0);
  assert.equal(a3, null, "request exceeding the limit is blocked");
  assert.equal(r3.statusCode, 429);
  const ra = Number(r3.headers["retry-after"]);
  assert.ok(Number.isFinite(ra) && ra >= 1 && ra <= 60, "Retry-After present and sane");
  assert.equal(r3.body.error, "Too many requests. Please try again later.");
  assert.equal(r3.headers["cache-control"], "no-store", "429 is never cached");
  ok("limiter: below-limit allowed, exceeding -> 429 + Retry-After + clean JSON");
}

/* ---------------- 8. counters live in Redis, not process memory ----------- */
{
  const req = mockReq({ headers: { "x-real-ip": "7.7.7.7" } });
  const blocked = mockRes();
  assert.equal(await enforceRateLimit(req, blocked, "test-direct", 2, 60), null, "still locked");
  clearFakeStore(); // simulate a wiped Redis
  const fresh = mockRes();
  const a = await enforceRateLimit(req, fresh, "test-direct", 2, 60);
  assert.ok(a, "clearing Redis resets the limiter (state was in Redis)");
  ok("counters are shared through Redis, not process memory");
}

/* ---------------- 9. independent IPs -------------------------------------- */
{
  const ipA = mockReq({ headers: { "x-real-ip": "7.7.7.7" } }); // count 1 after check 8
  const ipB = mockReq({ headers: { "x-real-ip": "8.8.8.8" } });
  const ra2 = mockRes(); const a2 = await enforceRateLimit(ipA, ra2, "test-direct", 2, 60);
  assert.ok(a2, "IP A hits its second allowed request");
  const ra3 = mockRes();
  assert.equal(await enforceRateLimit(ipA, ra3, "test-direct", 2, 60), null, "IP A now exhausted");
  const rb1 = mockRes();
  assert.ok(await enforceRateLimit(ipB, rb1, "test-direct", 2, 60), "IP B unaffected by IP A");
  ok("multiple IPs have independent limits");
}

/* ---------------- 10. leaderboard endpoint limit (120/min per IP) --------- */
{
  const req = mockReq({ method: "GET", query: {}, headers: { "x-real-ip": "9.9.9.9" } });
  let last = null;
  for (let i = 0; i < 120; i++) last = await call(leaderboardHandler, req);
  assert.equal(last.statusCode, 200, "requests at the limit succeed (120/min)");
  const blocked = await call(leaderboardHandler, req);
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers["retry-after"]) >= 1);
  assert.equal(blocked.body.error, "Too many requests. Please try again later.");
  ok("/api/leaderboard per-IP limit: 120 OK, 121st -> 429 with Retry-After");
}

/* ---------------- 11. each endpoint has its own budget -------------------- */
{
  // 9.9.9.9 is exhausted on the LEADERBOARD route only.
  const s = await call(sessionHandler, mockReq({ body: { name: "RateLimit" }, headers: { "x-real-ip": "9.9.9.9" } }));
  assert.equal(s.statusCode, 200, "session endpoint has its own limit");
  const stats = statsFor({
    sessionId: s.body.sessionId, flowers: 5, cleanup: 2, natives: 1,
    pipes: 15, closeCalls: 3, bestCombo: 2, bee: 90, eco: 70,
  });
  const sc = await call(scoresHandler, mockReq({ body: stats, headers: { "x-real-ip": "9.9.9.9" } }));
  assert.equal(sc.statusCode, 200, "scores endpoint has its own limit");
  ok("per-endpoint limits are independent (leaderboard 429 does not block session/scores)");
}

/* ---------------- 12. cross-IP independence at endpoint level ------------- */
{
  const res = await call(leaderboardHandler, mockReq({ method: "GET", query: {}, headers: { "x-real-ip": "5.5.5.5" } }));
  assert.equal(res.statusCode, 200, "another IP still gets 200");
  ok("exhausting one IP's leaderboard budget leaves other IPs untouched");
}

/* ---------------- 13. global daily session circuit breaker ---------------- */
{
  const key = "ratelimit:global-sessions:global";
  const [curRaw] = await redis([["GET", key]]);
  const current = Number(curRaw || 0);
  process.env.GLOBAL_DAILY_SESSION_LIMIT = String(current + 1); // lazy-read per request
  const okRes = await call(sessionHandler, mockReq({ body: { name: "CapOK" } }));
  assert.equal(okRes.statusCode, 200, "session under the global cap succeeds");
  const blockedRes = await call(sessionHandler, mockReq({ body: { name: "CapBlocked" } }));
  assert.equal(blockedRes.statusCode, 429, "global cap rejects with 429");
  assert.match(blockedRes.body.error, /capacity/);
  assert.ok(Number(blockedRes.headers["retry-after"]) >= 1, "Retry-After until window reset");
  delete process.env.GLOBAL_DAILY_SESSION_LIMIT;
  const recovered = await call(sessionHandler, mockReq({ body: { name: "CapRecovered" } }));
  assert.equal(recovered.statusCode, 200, "no permanent lockout — recovers after reset");
  ok("global daily session cap: 429 at limit + Retry-After + auto-recovery");
}

/* ---------------- 14. simultaneous requests cannot bypass the limit ------- */
{
  const req = mockReq({ headers: { "x-real-ip": "6.6.6.6" } });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => enforceRateLimit(req, mockRes(), "test-concurrent", 5, 60))
  );
  const allowed = results.filter(Boolean).length;
  assert.equal(allowed, 5, "exactly 5 of 10 simultaneous requests allowed");
  ok("atomic counter: 10 simultaneous requests, limit 5 -> exactly 5 allowed");
}

/* ---------------- 15. oversized requests still 413 ------------------------ */
{
  const viaBody = await call(sessionHandler, mockReq({ body: "x".repeat(5000) }));
  assert.equal(viaBody.statusCode, 413, "preparsed oversized body -> 413");
  const viaStream = await call(sessionHandler, streamReq("y".repeat(5000)));
  assert.equal(viaStream.statusCode, 413, "streamed oversized body -> 413");
  ok("oversized requests still rejected with 413 (4 KB limit intact)");
}

/* ---------------- 16. Redis down: limiter fails open, APIs stay clean ----- */
{
  _setOverride(null);
  const lb = await call(leaderboardHandler, mockReq({ method: "GET", query: {}, headers: { "x-real-ip": "4.4.4.4" } }));
  assert.equal(lb.statusCode, 503, "leaderboard degrades to clean 503, no crash");
  const sess = await call(sessionHandler, mockReq({ body: { name: "DownCheck" } }));
  assert.equal(sess.statusCode, 503, "session degrades to clean 503");
  assert.notEqual(sess.statusCode, 429, "limiter failure must NOT 429 (fail-open)");
  setOverrideFake();
  ok("Redis failure: limiter fails open, endpoints return clean 503, never crash");
}

/* ==================== Step 3: security hardening ==================== */
setOverrideFake();
{
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  // vercel.json: valid JSON + the core security headers
  const vc = JSON.parse(read("vercel.json"));
  const headerBlock = vc.headers?.[0];
  assert.ok(headerBlock && headerBlock.source === "/(.*)", "headers apply to all routes");
  const getHeader = (k) => {
    const h = (headerBlock.headers || []).find((x) => x.key.toLowerCase() === k.toLowerCase());
    return h && h.value;
  };
  const csp = getHeader("Content-Security-Policy");
  assert.ok(csp, "CSP present");
  assert.equal(getHeader("X-Content-Type-Options"), "nosniff");
  assert.ok(getHeader("Referrer-Policy"), "Referrer-Policy present");
  assert.ok(getHeader("Permissions-Policy"), "Permissions-Policy present");
  assert.equal(getHeader("X-Frame-Options"), "DENY");
  ok("vercel.json: valid + CSP / nosniff / Referrer-Policy / Permissions-Policy / X-Frame-Options");

  // CSP permits exactly the resources this project actually uses — and nothing looser
  for (const required of [
    "'self'",
    "'wasm-unsafe-eval'", // MediaPipe WASM inference (WebAssembly compilation only — NOT generic eval)
    "https://cdn.jsdelivr.net", // MediaPipe tasks-vision module + WASM files
    "https://fonts.googleapis.com", // Google Fonts stylesheet
    "https://fonts.gstatic.com", // Google Fonts font files
    "https://storage.googleapis.com", // hand_landmarker.task model download
    "data:", // inline SVG favicon
  ]) {
    assert.ok(csp.includes(required), `CSP allows ${required}`);
  }
  assert.ok(!csp.includes("'unsafe-inline'"), "no unsafe-inline");
  assert.ok(!csp.includes("'unsafe-eval'"), "no generic unsafe-eval");
  ok("CSP: every real resource allowed, no unsafe-inline, no generic unsafe-eval");

  // Permissions-Policy must NOT block the game's camera
  const pp = getHeader("Permissions-Policy");
  assert.ok(pp.includes("camera=(self)"), "camera access preserved for the game");
  assert.ok(pp.includes("microphone=()"), "microphone denied (game uses video only)");
  ok("Permissions-Policy: camera=(self) kept, unnecessary powerful features denied");

  // index.html: no inline scripts (CSP-safe watchdog) and no inline styles
  const html = read("index.html");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline <script> blocks");
  assert.ok(html.includes("js/boot-watchdog.js"), "boot watchdog loaded as external file");
  assert.ok(fs.existsSync(new URL("../js/boot-watchdog.js", import.meta.url)), "watchdog file exists");
  assert.ok(!/\sstyle="/i.test(html), "no inline style attributes (bar colors moved to CSS)");
  ok("index.html: no inline scripts/styles — CSP stays free of unsafe-inline");

  // Secrets & repo hygiene
  assert.ok(/\.env\.local/.test(read(".gitignore")), ".gitignore ignores .env.local");
  const envExample = read(".env.example");
  // Real Upstash REST tokens are 60+ alphanumeric chars; the placeholder
  // values in the example are dash-separated words and must not match.
  assert.ok(!/[A-Za-z0-9]{40,}/.test(envExample), "no real-looking token in .env.example");
  const pkg = JSON.parse(read("package.json"));
  assert.ok(!pkg.dependencies || !pkg.dependencies["@vercel/analytics"], "unused analytics dependency removed");
  const frontendJs = ["js/main.js", "js/ui.js", "js/game.js", "js/vision.js", "js/ecosystem.js", "js/boot-watchdog.js"]
    .map((f) => read(f)).join("\n");
  assert.ok(!/UPSTASH_REDIS|KV_REST_API|REST_TOKEN/i.test(frontendJs), "no Redis credential references in frontend code");
  ok("secrets audit: .gitignore covers .env.local, example has placeholders only, zero creds client-side");

  // XSS: all rendered content (leaderboard names included) goes through textContent
  const uiJs = read("js/ui.js");
  const assignments = uiJs.match(/innerHTML\s*=\s*[^;]+/g) || [];
  assert.ok(assignments.length > 0, "sanity: innerHTML usages found in ui.js");
  for (const a of assignments) {
    assert.ok(/innerHTML\s*=\s*""\s*$/.test(a), `innerHTML only ever cleared, never assigned content: ${a}`);
  }
  ok("XSS review: names/text rendered via textContent; innerHTML only ever cleared");

  // API error bodies stay generic + are never cacheable
  const leaky = /upstash|redis|token|authorization|bearer|wasm|\.js\b/i;
  const e400 = await call(sessionHandler, mockReq({ body: { name: "" } }));
  assert.equal(e400.statusCode, 400);
  assert.ok(!leaky.test(JSON.stringify(e400.body)), "400 body generic");
  const e404 = await call(scoresHandler, mockReq({
    body: statsFor({
      sessionId: "ffffffffffffffffffffffffffffffff", flowers: 1, cleanup: 0,
      natives: 0, pipes: 5, closeCalls: 0, bestCombo: 0, bee: 100, eco: 50,
    }),
  }));
  assert.equal(e404.statusCode, 404);
  assert.ok(!leaky.test(JSON.stringify(e404.body)), "404 body generic");
  assert.equal(e404.headers["cache-control"], "no-store", "error responses are no-store");
  const r429 = mockRes();
  await enforceRateLimit(mockReq({ headers: { "x-real-ip": "3.3.3.3" } }), r429, "test-leak", 0, 60);
  assert.equal(r429.statusCode, 429);
  assert.ok(!leaky.test(JSON.stringify(r429.body)), "429 body generic");
  ok("API errors: generic bodies (400/404/429), no internal details, never cached");

  // Normal flows unaffected by the header work
  const lbOk = await call(leaderboardHandler, mockReq({ method: "GET", query: {}, headers: { "x-real-ip": "2.2.2.2" } }));
  assert.equal(lbOk.statusCode, 200);
  assert.match(lbOk.headers["cache-control"], /s-maxage=15/, "normal edge caching preserved");
  ok("normal leaderboard flow + edge-cache header unchanged");
}

/* ==================== Step 4: retry + personal best ==================== */
{
  // --- session: token echo / mint / reject malformed ---
  const TOK_A = "a".repeat(32);
  const s1 = await call(sessionHandler, mockReq({ body: { name: "Sujith", playerToken: TOK_A } }));
  assert.equal(s1.statusCode, 200);
  assert.equal(s1.body.playerToken, TOK_A, "provided token echoed");
  const s1b = await call(sessionHandler, mockReq({ body: { name: "Sujith" } }));
  assert.match(s1b.body.playerToken, /^[a-f0-9]{32}$/, "server mints a token when absent");
  assert.notEqual(s1b.body.playerToken, TOK_A);
  const badS = await call(sessionHandler, mockReq({ body: { name: "Sujith", playerToken: "nope" } }));
  assert.equal(badS.statusCode, 400, "invalid token format -> 400");
  ok("session: token echoed / minted when absent / malformed -> 400");

  // --- first attempt: entry keyed by playerToken ---
  const p1 = { ...statsFor({ sessionId: s1.body.sessionId, flowers: 10, cleanup: 2, natives: 1, pipes: 20, closeCalls: 1, bestCombo: 3, bee: 90, eco: 60 }), playerToken: TOK_A };
  const r1 = await call(scoresHandler, mockReq({ body: p1 }));
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.score, 435); // 10*10 + 2*20 + 1*50 + 20*5 + 1*25 + 60*2
  assert.equal(r1.body.newBest, true);
  assert.equal(r1.body.best, 435);
  const [z1] = await redis([["ZSCORE", "lb:all", TOK_A]]);
  assert.equal(Number(z1), 435, "lb:all member is the playerToken");
  ok("first attempt: leaderboard entry keyed by playerToken, newBest true");

  // --- RETRY with a NEW session + same token, HIGHER score ---
  const s1c = await call(sessionHandler, mockReq({ body: { name: "Sujith", playerToken: TOK_A } }));
  assert.notEqual(s1c.body.sessionId, s1.body.sessionId, "retry gets a genuinely new session");
  const p2 = { ...statsFor({ sessionId: s1c.body.sessionId, flowers: 12, cleanup: 2, natives: 1, pipes: 20, closeCalls: 1, bestCombo: 3, bee: 90, eco: 60 }), playerToken: TOK_A };
  const r2 = await call(scoresHandler, mockReq({ body: p2 }));
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.score, 455);
  assert.equal(r2.body.newBest, true);
  assert.equal(r2.body.best, 455, "best = the new personal best after the attempt");
  const [z2] = await redis([["ZSCORE", "lb:all", TOK_A]]);
  assert.equal(Number(z2), 455, "personal best updated to the higher score");
  ok("retry higher: SAME player entry updated to 455 (not a duplicate)");

  // --- RETRY with a LOWER score: best stays ---
  const s1d = await call(sessionHandler, mockReq({ body: { name: "Sujith", playerToken: TOK_A } }));
  const p3 = { ...statsFor({ sessionId: s1d.body.sessionId, flowers: 8, cleanup: 2, natives: 1, pipes: 20, closeCalls: 1, bestCombo: 3, bee: 90, eco: 60 }), playerToken: TOK_A };
  const r3 = await call(scoresHandler, mockReq({ body: p3 }));
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.body.score, 415);
  assert.equal(r3.body.newBest, false);
  assert.equal(r3.body.best, 455);
  const [z3] = await redis([["ZSCORE", "lb:all", TOK_A]]);
  assert.equal(Number(z3), 455, "lower retry cannot lower the personal best");
  const [dz] = await redis([["HGET", `score:detail:${TOK_A}`, "flowers"]]);
  assert.equal(dz, "12", "details still describe the best run");
  const [dt] = await redis([["TTL", `score:detail:${TOK_A}`]]);
  assert.ok(Number(dt) > 0 && Number(dt) <= 2592000, "detail hash has bounded retention");
  ok("retry lower: best stays 455, details match the best run, TTL bounded");

  // --- one-submission-per-session intact ---
  const dup = await call(scoresHandler, mockReq({ body: p1 }));
  assert.equal(dup.statusCode, 409);
  ok("old session replay -> 409 (one-submission-per-session intact)");

  // --- token bound to the session ---
  const sX = await call(sessionHandler, mockReq({ body: { name: "X", playerToken: "b".repeat(32) } }));
  const pX = { ...statsFor({ sessionId: sX.body.sessionId }), playerToken: TOK_A };
  const rX = await call(scoresHandler, mockReq({ body: pX }));
  assert.equal(rX.statusCode, 400);
  assert.match(rX.body.error, /mismatch/);
  const rBad = await call(scoresHandler, mockReq({ body: { ...statsFor({ sessionId: sX.body.sessionId }), playerToken: "zzz" } }));
  assert.equal(rBad.statusCode, 400, "malformed payload token -> 400");
  ok("token bound to session: mismatched/malformed playerToken -> 400");

  // --- same display name, different players -> separate entries ---
  const TOK_B = "b".repeat(32);
  const sB = await call(sessionHandler, mockReq({ body: { name: "Sujith", playerToken: TOK_B } }));
  const rB = await call(scoresHandler, mockReq({ body: { ...statsFor({ sessionId: sB.body.sessionId, flowers: 5 }), playerToken: TOK_B } }));
  assert.equal(rB.statusCode, 200);
  assert.equal(rB.body.newBest, true);
  const [zb] = await redis([["ZSCORE", "lb:all", TOK_B]]);
  assert.equal(Number(zb), rB.body.score);
  assert.notEqual(Number(zb), 455);
  ok("same display name, different token -> independent personal best");

  // --- daily board keeps the per-player daily best ---
  const todayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const [d1] = await redis([["ZSCORE", `lb:day:${todayKey}`, TOK_A]]);
  assert.equal(Number(d1), 455, "daily board keeps the day's best per player");
  ok("daily leaderboard: personal best per player (ZADD GT)");

  // --- legacy payload without playerToken -> sessionId member ---
  const sL = await call(sessionHandler, mockReq({ body: { name: "Legacy" } }));
  const rL = await call(scoresHandler, mockReq({ body: statsFor({ sessionId: sL.body.sessionId, flowers: 3 }) }));
  assert.equal(rL.statusCode, 200);
  const [zl] = await redis([["ZSCORE", "lb:all", sL.body.sessionId]]);
  assert.equal(Number(zl), rL.body.score, "legacy member = sessionId");
  ok("legacy clients (no playerToken): sessionId member, behavior unchanged");
}

console.log(`\nALL ${passed} CHECKS PASSED ✅`);
