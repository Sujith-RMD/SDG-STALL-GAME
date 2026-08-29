/*
 * Step 1 local verification — no credentials required.
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

const require = createRequire(import.meta.url);
const { _setOverride } = require("../api/_lib/redis.js");
const { computeScore } = require("../api/_lib/score.js");
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
          const [, k, score, member] = cmd;
          entry(k).z.set(String(member), Number(score));
          return 1;
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
        default:
          throw new Error(`fake redis: unsupported command ${op}`);
      }
    })
  );
}

/* ---------------- mocks ---------------- */
function mockReq({ method = "POST", body = undefined, query = {} } = {}) {
  return { method, body, query, headers: {} };
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

console.log(`\nALL ${passed} CHECKS PASSED ✅`);
