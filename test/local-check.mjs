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
const { computeScore, todayKey: dayKeyOf } = require("../api/_lib/score.js");
const { enforceRateLimit } = require("../api/_lib/ratelimit.js");
const { TRIM_SCRIPT } = require("../api/_lib/trim.js");
const sessionHandler = require("../api/session.js");
const scoresHandler = require("../api/scores.js");
const leaderboardHandler = require("../api/leaderboard.js");
const adminTrimHandler = require("../api/admin/trim-leaderboard.js");

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✔ ${label}`);
}

/* ---------------- in-memory Redis fake (Upstash-compatible shapes) ----- */
const store = new Map();

/*
 * Fault injection for the admin trim route: when non-zero, the fake's EVAL
 * misreports the post-trim count. Used to prove the handler's independent
 * read-back rejects an inconsistent result instead of returning 200.
 */
let evalCountFault = 0;

function purge(k) {
  const e = store.get(k);
  if (e && e.exp && e.exp <= Date.now()) store.delete(k);
}
function entry(k) {
  purge(k);
  if (!store.has(k)) store.set(k, { z: new Map(), h: new Map(), v: null, exp: null });
  return store.get(k);
}

/* ---------------- sorted-set helpers (fake + the EVAL model share these) ---
 * Redis orders a sorted set by score ASCENDING, ties broken by member
 * lexicographically ASCENDING. ZREVRANGE reverses that whole order, so equal
 * scores come back with members in DESCENDING lexicographic order. */
function zItems(key, dir = "asc") {
  const e = store.get(key);
  if (!e) return [];
  const items = [...e.z.entries()].sort(
    (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  return dir === "rev" ? items.reverse() : items;
}

/** Parse a Redis score bound: a number, "-inf", "+inf", or "(n" for exclusive. */
function parseBound(text) {
  const s = String(text);
  if (s === "-inf") return { value: -Infinity, exclusive: false };
  if (s === "+inf" || s === "inf") return { value: Infinity, exclusive: false };
  if (s.startsWith("(")) return { value: Number(s.slice(1)), exclusive: true };
  return { value: Number(s), exclusive: false };
}

function scoreInRange(score, minText, maxText) {
  const lo = parseBound(minText);
  const hi = parseBound(maxText);
  const atLeast = lo.exclusive ? score > lo.value : score >= lo.value;
  const atMost = hi.exclusive ? score < hi.value : score <= hi.value;
  return atLeast && atMost;
}

/** Inclusive index range with Redis's negative-index semantics. */
function sliceRange(items, start, stop) {
  const n = items.length;
  let s = Number(start);
  let e = Number(stop);
  if (s < 0) s = Math.max(0, n + s);
  if (e < 0) e = n + e;
  if (s >= n || e < s) return [];
  return items.slice(s, e + 1);
}

/** WITHSCORES flattening, matching the REST client's unwrapped result shape. */
function flatten(items, withScores) {
  if (!withScores) return items.map(([m]) => m);
  const out = [];
  for (const [m, s] of items) {
    out.push(m);
    out.push(String(s));
  }
  return out;
}

/*
 * JS model of TRIM_SCRIPT (api/_lib/trim.js), used by the fake's EVAL.
 *
 * The fake Redis cannot execute Lua, so this mirrors the script operation for
 * operation so the admin route can be exercised end to end. It is a MODEL, not
 * the script itself — the structural checks in Step 7 assert that the real
 * script still performs every safety step, and the handler independently reads
 * the board back after the call, so a model/script divergence cannot quietly
 * produce a false "success".
 */
function trimScriptModel(key, prefix, keepArg, applyArg) {
  const keep = Number(keepArg);
  const apply = applyArg === "1";
  const MAX_BOUNDARY = 500;

  const report = (status, detail, before, after, expected, cutoff, removed, tiebreak) =>
    [status, detail, before, after, expected, cutoff, removed, tiebreak];

  const zcard = () => (store.get(key) ? store.get(key).z.size : 0);

  const before = zcard();
  if (before === 0) return report("empty", "", 0, 0, 0, 0, 0, "none");

  const expected = Math.min(keep, before);
  if (before <= expected) return report("noop", "", before, before, expected, 0, 0, "none");

  const edge = zItems(key, "rev")[expected - 1];
  if (!edge) {
    return report("preflight_failed", `no entry found at rank ${expected}`, before, before, expected, 0, 0, "none");
  }
  const cutoff = edge[1];

  const above = zItems(key, "asc").filter(([, s]) => s > cutoff).length;
  if (above > expected) {
    return report(
      "preflight_failed",
      `${above} entries outrank the cutoff but only ${expected} are kept`,
      before, before, expected, cutoff, 0, "none"
    );
  }

  const needFromBoundary = expected - above;
  const boundary = zItems(key, "asc").filter(([, s]) => s === cutoff).map(([m]) => m);

  let tiebreak = "timestamp";
  const doomed = [];

  if (boundary.length > MAX_BOUNDARY) {
    tiebreak = "rank";
  } else {
    const ordered = boundary.map((member) => {
      const hash = store.get(`${prefix}${member}`);
      const raw = hash ? hash.h.get("ts") : undefined;
      return [member, raw === undefined || raw === null ? null : Number(raw)];
    });
    // ts ascending, entries with no recorded ts last, then member ascending.
    ordered.sort((a, b) => {
      if (a[1] !== b[1]) {
        if (a[1] === null) return 1;
        if (b[1] === null) return -1;
        return a[1] - b[1];
      }
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    for (let i = needFromBoundary; i < ordered.length; i++) doomed.push(ordered[i][0]);
  }

  if (!apply) return report("dry_run", "", before, expected, expected, cutoff, 0, tiebreak);

  // 1) everything strictly below the cutoff
  const entrySet = store.get(key).z;
  for (const [m, s] of [...entrySet.entries()]) {
    if (s < cutoff) entrySet.delete(m);
  }

  // 2) the boundary losers — by rank (lowest first) or by explicit member
  if (tiebreak === "rank") {
    const drop = boundary.length - needFromBoundary;
    if (drop > 0) {
      for (const [m] of zItems(key, "asc").slice(0, drop)) entrySet.delete(m);
    }
  } else {
    for (const m of doomed) entrySet.delete(m);
  }

  const after = zcard();
  if (after !== expected) {
    return report(
      "verify_failed",
      `expected ${expected} entries after the trim, found ${after}`,
      before, after, expected, cutoff, before - after, tiebreak
    );
  }
  const lowest = zItems(key, "asc")[0];
  if (lowest && lowest[1] < cutoff) {
    return report(
      "verify_failed",
      `a surviving entry scores below the cutoff (${lowest[1]} < ${cutoff})`,
      before, after, expected, cutoff, before - after, tiebreak
    );
  }
  return report("ok", "", before, after, expected, cutoff, before - after, tiebreak);
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
          const [, k, start, stop, ...flags] = cmd;
          return flatten(sliceRange(zItems(k, "rev"), start, stop), flags.includes("WITHSCORES"));
        }
        case "ZRANGE": {
          const [, k, start, stop, ...flags] = cmd;
          return flatten(sliceRange(zItems(k, "asc"), start, stop), flags.includes("WITHSCORES"));
        }
        case "ZRANGEBYSCORE": {
          const [, k, min, max, ...flags] = cmd;
          const inRange = zItems(k, "asc").filter(([, s]) => scoreInRange(s, min, max));
          return flatten(inRange, flags.includes("WITHSCORES"));
        }
        case "ZCOUNT": {
          const [, k, min, max] = cmd;
          return zItems(k, "asc").filter(([, s]) => scoreInRange(s, min, max)).length;
        }
        case "ZREMRANGEBYSCORE": {
          const [, k, min, max] = cmd;
          const e = store.get(k);
          if (!e) return 0;
          let removed = 0;
          for (const [m, s] of [...e.z.entries()]) {
            if (scoreInRange(s, min, max)) {
              e.z.delete(m);
              removed += 1;
            }
          }
          return removed;
        }
        case "ZREMRANGEBYRANK": {
          // Ranks ASCEND by score: rank 0 is the LOWEST entry.
          const [, k, start, stop] = cmd;
          const e = store.get(k);
          if (!e) return 0;
          const doomed = sliceRange(zItems(k, "asc"), start, stop).map(([m]) => m);
          for (const m of doomed) e.z.delete(m);
          return doomed.length;
        }
        case "ZREM": {
          const [, k, ...members] = cmd;
          const e = store.get(k);
          if (!e) return 0;
          let removed = 0;
          for (const m of members) {
            if (e.z.delete(String(m))) removed += 1;
          }
          return removed;
        }
        case "DEL": {
          const [, ...keys] = cmd;
          let removed = 0;
          for (const k of keys) {
            if (store.delete(k)) removed += 1;
          }
          return removed;
        }
        case "EVAL": {
          const [, script, numKeys, ...rest] = cmd;
          if (script !== TRIM_SCRIPT) throw new Error("fake redis: unrecognised script");
          const n = Number(numKeys);
          // KEYS[1] = rest[0]; ARGV[1..] = rest[n..]
          const out = trimScriptModel(rest[0], rest[n], rest[n + 1], rest[n + 2]);
          if (evalCountFault) out[3] = Number(out[3]) + evalCountFault; // index 3 = `after`
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

/* ---------------- 15b. pre-parsed body 4 KB cap (Step 6 / A5) ------------- */
{
  // Vercel pre-parses JSON into req.body — that path previously BYPASSED the
  // 4 KB cap (it was only enforced on streamed/string bodies).
  const oversized = await call(sessionHandler, mockReq({ body: { pad: "x".repeat(5000) } }));
  assert.equal(oversized.statusCode, 413, "pre-parsed object over 4 KB -> 413");
  assert.equal(oversized.body.error, "Request body too large");
  const fine = await call(sessionHandler, mockReq({ body: { name: "PreParsed" } }));
  assert.equal(fine.statusCode, 200, "pre-parsed object under the cap still accepted");
  ok("pre-parsed req.body enforces the 4 KB cap without breaking valid bodies");
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

/* ==================== Step 6: audit fixes (A3 / A1) ==================== */
{
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  // A3: a page load (fresh or refresh) must never RESTORE a playerToken —
  // sessionStorage survives F5, and restoring it at boot is exactly what let
  // a new student's attempts merge into the previous player's identity after
  // an organizer refresh. RETRY is in-page and unaffected by the boot wipe.
  const mainJs = read("js/main.js");
  assert.ok(
    !/sessionStorage\.getItem\(TOKEN_KEY\)/.test(mainJs),
    "main.js must not restore playerToken from sessionStorage at boot"
  );
  assert.ok(
    /sessionStorage\.removeItem\(TOKEN_KEY\)/.test(mainJs),
    "main.js must wipe any stale playerToken at page boot"
  );
  ok("identity lifecycle: page boot never restores a stale playerToken (A3)");

  // A1: every element id referenced from ui.js must exist in index.html —
  // the removed againBtn: $("play-again") silently resolved to null after
  // Step 4 renamed the button. This guard fails on any future rename drift.
  const uiJs = read("js/ui.js");
  const html = read("index.html");
  const ids = [...uiJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 35, "sanity: ui.js element references found");
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `ui.js references missing elements: ${missing.join(", ")}`);
  ok("ui.js element ids all exist in index.html (no orphaned DOM references) (A1)");
}

/* ==================== Step 7: admin leaderboard trim ==================== */
/*
 * Covers POST /api/admin/trim-leaderboard — the Redis counterpart of
 * sql/trim-leaderboard.sql.
 *
 * The fake Redis cannot execute Lua, so its EVAL delegates to trimScriptModel
 * above. Everything else is the real production path: auth, validation, the
 * dry-run default, the report, and the handler's own read-back verification.
 * The structural checks at the end of this block assert that the real Lua
 * script still performs each safety step, so a model/script divergence cannot
 * pass silently.
 */
setOverrideFake();
{
  const ADMIN = "test-admin-secret-0123456789abcdef"; // 34 chars, over the 24 minimum
  const DAY_KEY = `lb:day:${dayKeyOf()}`;
  process.env.ADMIN_TRIM_TOKEN = ADMIN;
  process.env.RATE_LIMIT_ADMIN_TRIM_PER_MIN = "500"; // keep this suite out of the limiter's way

  const adminReq = (body, headers = {}) =>
    mockReq({ body, headers: { "x-real-ip": "10.0.0.1", authorization: `Bearer ${ADMIN}`, ...headers } });

  const boardSize = (k) => (store.get(k) ? store.get(k).z.size : 0);
  const boardMembers = () => [...(store.get("lb:all")?.z.keys() ?? [])];
  const topMembers = () => zItems("lb:all", "rev").map(([m]) => m);

  async function seedBoard() {
    // A 500 · B 400 · C 300 (ts 3000) · D 300 (ts 4000) · E 200 · F 100
    // The 3rd place is a tie, so the ts tiebreak decides between C and D.
    await redis([
      ["ZADD", "lb:all", "500", "A"], ["HSET", "score:detail:A", "name", "Ana", "ts", "1000"],
      ["ZADD", "lb:all", "400", "B"], ["HSET", "score:detail:B", "name", "Ben", "ts", "2000"],
      ["ZADD", "lb:all", "300", "C"], ["HSET", "score:detail:C", "name", "Cara", "ts", "3000"],
      ["ZADD", "lb:all", "300", "D"], ["HSET", "score:detail:D", "name", "Dev", "ts", "4000"],
      ["ZADD", "lb:all", "200", "E"], ["HSET", "score:detail:E", "name", "Eve", "ts", "5000"],
      ["ZADD", "lb:all", "100", "F"], ["HSET", "score:detail:F", "name", "Fay", "ts", "6000"],
    ]);
  }

  /* ---------------- 17. auth: fail closed, constant-time, two headers ------ */
  {
    const saved = process.env.ADMIN_TRIM_TOKEN;

    delete process.env.ADMIN_TRIM_TOKEN;
    const missing = await call(adminTrimHandler, adminReq({}));
    assert.equal(missing.statusCode, 503, "an unconfigured admin route must refuse to run");
    assert.equal(missing.body.error, "Admin trim endpoint is not configured");

    process.env.ADMIN_TRIM_TOKEN = "tooshort";
    const weak = await call(adminTrimHandler, adminReq({}));
    assert.equal(weak.statusCode, 503, "a guessable secret counts as unconfigured");

    process.env.ADMIN_TRIM_TOKEN = saved;
    ok("admin auth: missing or too-short secret -> 503 (fails closed, never open)");
  }
  {
    const none = await call(adminTrimHandler, mockReq({ body: {}, headers: { "x-real-ip": "10.0.0.2" } }));
    assert.equal(none.statusCode, 401);

    const wrong = await call(adminTrimHandler, adminReq({}, { authorization: `Bearer ${"z".repeat(34)}` }));
    assert.equal(wrong.statusCode, 401);

    const wrongLength = await call(adminTrimHandler, adminReq({}, { authorization: "Bearer x" }));
    assert.equal(wrongLength.statusCode, 401, "a different-length secret -> 401, not a crash");

    const viaHeader = await call(adminTrimHandler,
      mockReq({ body: {}, headers: { "x-real-ip": "10.0.0.2", "x-admin-token": ADMIN } }));
    assert.equal(viaHeader.statusCode, 200, "X-Admin-Token is accepted");

    ok("admin auth: absent/wrong/wrong-length secret -> 401; X-Admin-Token accepted");
  }

  /* ---------------- 18. dry run is the default ---------------------------- */
  {
    clearFakeStore();
    await seedBoard();

    const res = await call(adminTrimHandler, adminReq({}));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.applied, false, "a bodyless request must NOT delete anything");
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.keep, 3);

    const board = res.body.boards[0];
    assert.equal(board.key, "lb:all");
    assert.equal(board.status, "dry_run");
    assert.equal(board.before, 6);
    assert.equal(board.wouldRemove, 3);
    assert.equal(board.after, 3, "`after` is the projected count on a dry run");
    assert.equal(board.removed, 0, "a dry run removes nothing");
    assert.equal(board.cutoff, 300);
    assert.equal(board.tiebreak, "timestamp");
    assert.equal(boardSize("lb:all"), 6, "the board is untouched");

    ok("dry run is the default: reports the plan, deletes nothing");
  }

  /* ---------------- 19. confirm:true applies, and only the top 3 remain ---- */
  {
    const res = await call(adminTrimHandler, adminReq({ confirm: true }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.applied, true);
    assert.equal(res.body.dryRun, false);

    const board = res.body.boards[0];
    assert.equal(board.status, "ok");
    assert.equal(board.before, 6);
    assert.equal(board.after, 3);
    assert.equal(board.removed, 3);
    assert.equal(board.expected, 3);
    assert.equal(board.countVerified, true, "the handler's read-back agrees with the script");

    assert.deepEqual(board.kept.map((e) => e.member), ["A", "B", "C"]);
    assert.deepEqual(board.kept.map((e) => e.score), [500, 400, 300]);
    assert.equal(board.kept[0].rank, 1);
    assert.equal(board.kept[0].name, "Ana");

    assert.equal(boardSize("lb:all"), 3, "exactly 3 entries remain");
    assert.deepEqual(topMembers(), ["A", "B", "C"]);
    assert.ok(!boardMembers().includes("D"), "D lost the 3rd-place tie on ts");
    assert.ok(!boardMembers().includes("E"));
    assert.ok(!boardMembers().includes("F"));

    assert.ok(
      res.body.warnings.some((w) => /aggregates\.players/.test(w)),
      "the aggregates.players side effect is reported"
    );

    ok("apply: exactly the 3 highest-scoring entries remain; boundary tie resolved by ts");
  }

  /* ---------------- 20. idempotency -------------------------------------- */
  {
    const before = boardSize("lb:all");
    const res = await call(adminTrimHandler, adminReq({ confirm: true }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.boards[0].status, "noop", "a second run has nothing to trim");
    assert.equal(res.body.boards[0].removed, 0);
    assert.equal(boardSize("lb:all"), before);
    ok("idempotent: a second apply removes nothing");
  }

  /* ---------------- 21. tie against an entry with no recorded ts ---------- */
  {
    clearFakeStore();
    await redis([
      ["ZADD", "lb:all", "500", "A"], ["HSET", "score:detail:A", "name", "Ana", "ts", "1000"],
      ["ZADD", "lb:all", "400", "B"], ["HSET", "score:detail:B", "name", "Ben", "ts", "2000"],
      ["ZADD", "lb:all", "300", "C"], ["HSET", "score:detail:C", "name", "Cara", "ts", "3000"],
      ["ZADD", "lb:all", "300", "LEGACY"], // no detail hash at all -> no ts
      ["ZADD", "lb:all", "100", "Z"],
    ]);
    const res = await call(adminTrimHandler, adminReq({ confirm: true }));
    assert.equal(res.statusCode, 200);
    assert.equal(boardSize("lb:all"), 3);
    assert.deepEqual(topMembers(), ["A", "B", "C"]);
    assert.ok(!boardMembers().includes("LEGACY"), "no recorded ts loses the tie to a known one");
    ok("boundary tie: an entry with no recorded ts loses to one with provenance");
  }

  /* ---------------- 22. small and empty boards --------------------------- */
  {
    clearFakeStore();
    await redis([
      ["ZADD", "lb:all", "10", "only"], ["HSET", "score:detail:only", "name", "Solo", "ts", "1"],
    ]);
    const small = await call(adminTrimHandler, adminReq({ confirm: true }));
    assert.equal(small.statusCode, 200);
    assert.equal(small.body.boards[0].status, "noop");
    assert.equal(boardSize("lb:all"), 1, "a board smaller than `keep` is left alone");

    clearFakeStore();
    const empty = await call(adminTrimHandler, adminReq({ confirm: true }));
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.body.boards[0].status, "empty");
    assert.equal(empty.body.boards[0].before, 0);
    ok("small/empty board: no error, nothing removed");
  }

  /* ---------------- 23. keep override and explicit dryRun:true ----------- */
  {
    clearFakeStore();
    await seedBoard();

    const preview = await call(adminTrimHandler, adminReq({ confirm: true, dryRun: true }));
    assert.equal(preview.body.applied, false, "explicit dryRun:true beats confirm:true");
    assert.equal(boardSize("lb:all"), 6, "the preview deleted nothing");

    const res = await call(adminTrimHandler, adminReq({ confirm: true, keep: 2 }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.keep, 2);
    assert.equal(boardSize("lb:all"), 2);
    assert.deepEqual(topMembers(), ["A", "B"]);
    ok("keep override trims to 2; explicit dryRun:true suppresses the delete");
  }

  /* ---------------- 24. scope: today vs both ----------------------------- */
  {
    clearFakeStore();
    await seedBoard();
    await redis([
      ["ZADD", DAY_KEY, "900", "X"], ["ZADD", DAY_KEY, "800", "Y"],
      ["ZADD", DAY_KEY, "700", "Z"], ["ZADD", DAY_KEY, "100", "W"],
    ]);

    const today = await call(adminTrimHandler, adminReq({ confirm: true, scope: "today" }));
    assert.equal(today.statusCode, 200);
    assert.equal(today.body.boards.length, 1);
    assert.equal(today.body.boards[0].key, DAY_KEY);
    assert.equal(boardSize(DAY_KEY), 3, "the daily board is trimmed");
    assert.equal(boardSize("lb:all"), 6, "scope=today leaves the all-time board alone");

    const both = await call(adminTrimHandler, adminReq({ confirm: true, scope: "both" }));
    assert.equal(both.body.boards.length, 2);
    assert.equal(boardSize("lb:all"), 3);
    assert.equal(boardSize(DAY_KEY), 3);
    ok("scope: `today` trims only the daily board; `both` trims each board");
  }

  /* ---------------- 25. stats counters are not rewritten ----------------- */
  {
    clearFakeStore();
    await seedBoard();
    await redis([["SET", "stats:games", "99"], ["SET", "stats:flowers", "500"]]);

    await call(adminTrimHandler, adminReq({ confirm: true }));

    const [games] = await redis([["GET", "stats:games"]]);
    const [flowers] = await redis([["GET", "stats:flowers"]]);
    assert.equal(games, "99", "stats:games must not be rewritten by a trim");
    assert.equal(flowers, "500");
    ok("aggregate counters are left alone — only the board is trimmed");
  }

  /* ---------------- 26. validation -------------------------------------- */
  {
    for (const [label, body] of [
      ["unknown field rejected", { confirm: true, dryrun: true }],
      ["keep above the cap rejected", { keep: 101 }],
      ["keep below 1 rejected", { keep: 0 }],
      ["non-integer keep rejected", { keep: 2.5 }],
      ["string keep rejected", { keep: "3" }],
      ["unknown scope rejected", { scope: "yesterday" }],
      ["non-boolean confirm rejected", { confirm: "yes" }],
      ["non-boolean dryRun rejected", { dryRun: "no" }],
    ]) {
      const res = await call(adminTrimHandler, adminReq(body));
      assert.equal(res.statusCode, 400, label);
    }
    ok("validation: unknown fields and out-of-range values -> 400");
  }

  /* ---------------- 27. method, body cap, error hygiene ------------------ */
  {
    const get = await call(adminTrimHandler,
      mockReq({ method: "GET", headers: { "x-real-ip": "10.0.0.3", authorization: `Bearer ${ADMIN}` } }));
    assert.equal(get.statusCode, 405);

    const big = await call(adminTrimHandler, adminReq({ pad: "x".repeat(5000) }));
    assert.equal(big.statusCode, 413, "the 4 KB body cap still applies");

    const leaky = /upstash|redis|token|authorization|bearer|wasm|\.js\b/i;
    const bodies = [
      (await call(adminTrimHandler, mockReq({ body: {}, headers: { "x-real-ip": "10.0.0.4" } }))).body,
      (await call(adminTrimHandler, adminReq({ keep: 999 }))).body,
    ];
    const saved = process.env.ADMIN_TRIM_TOKEN;
    delete process.env.ADMIN_TRIM_TOKEN;
    bodies.push((await call(adminTrimHandler, adminReq({}))).body);
    process.env.ADMIN_TRIM_TOKEN = saved;

    for (const b of bodies) {
      assert.ok(!leaky.test(JSON.stringify(b)), `admin error body leaks internals: ${JSON.stringify(b)}`);
    }
    ok("admin route: 405 / 413 intact, error bodies generic (no internals)");
  }

  /* ---------------- 28. rate limited per IP ----------------------------- */
  {
    process.env.RATE_LIMIT_ADMIN_TRIM_PER_MIN = "3";
    const headers = { "x-real-ip": "10.9.9.9", authorization: `Bearer ${ADMIN}` };

    let last = null;
    for (let i = 0; i < 3; i++) last = await call(adminTrimHandler, mockReq({ body: {}, headers }));
    assert.equal(last.statusCode, 200, "requests at the limit succeed");

    const blocked = await call(adminTrimHandler, mockReq({ body: {}, headers }));
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);

    process.env.RATE_LIMIT_ADMIN_TRIM_PER_MIN = "500";
    ok("admin route is rate limited per IP (3 OK, 4th -> 429 with Retry-After)");
  }

  /* ---------------- 29. Redis down -> clean 503 ------------------------- */
  {
    _setOverride(null);
    const res = await call(adminTrimHandler, adminReq({ confirm: true }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "Leaderboard backend unavailable");
    assert.notEqual(res.statusCode, 200, "never a false success when the backend is down");
    setOverrideFake();
    ok("Redis down -> 503, never a crash and never a false success");
  }

  /* ---------------- 30. the Lua script retains every safety step --------- */
  {
    for (const [label, needle] of [
      ["read the board size", "ZCARD"],
      ["read the cutoff at rank `expected`", "ZREVRANGE', key, expected - 1, expected - 1"],
      ["count entries above the cutoff", "ZCOUNT"],
      ["abort before deleting when the pre-flight fails", "return report('preflight_failed'"],
      ["read the tie group at the cutoff", "ZRANGEBYSCORE"],
      ["break the tie on the recorded ts", "HGET"],
      ["remove everything below the cutoff", "ZREMRANGEBYSCORE"],
      ["remove the boundary losers by member", "redis.call('ZREM',"],
      ["assert the survivor count", "entries after the trim"],
      ["assert no survivor scores below the cutoff", "a surviving entry scores below the cutoff"],
      ["return success only after verifying", "return report('ok'"],
    ]) {
      assert.ok(TRIM_SCRIPT.includes(needle), `trim script must still ${label}`);
    }
    // Regression guard: Redis ranks ascend by score, so removing "rank
    // expected .. -1" would delete the KEEPERS. The fallback must count up
    // from rank 0 instead.
    assert.ok(
      !/ZREMRANGEBYRANK'[^\n]*key, expected/.test(TRIM_SCRIPT),
      "rank fallback must not use descending-rank semantics (that deletes the keepers)"
    );
    ok("trim script retains every safety step (structural check on the Lua source)");
  }
  /* ---------------- 31. an inconsistent result is never reported as OK ---- */
  {
    clearFakeStore();
    await seedBoard();

    // Make the script claim 4 survivors when it actually leaves 3.
    evalCountFault = 1;
    const res = await call(adminTrimHandler, adminReq({ confirm: true }));
    evalCountFault = 0;

    assert.equal(res.statusCode, 500, "a read-back that disagrees with the script must not be a 200");
    assert.equal(res.body.ok, false);
    assert.equal(res.body.applied, false, "never claim to have applied a trim we could not verify");
    assert.ok(
      res.body.warnings.some((w) => /read-back found/.test(w)),
      "the disagreement is reported in warnings"
    );
    ok("read-back guard: a script that misreports its result -> 500, never a false success");
  }
}

console.log(`\nALL ${passed} CHECKS PASSED ✅`);
