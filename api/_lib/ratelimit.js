/*
 * Redis-backed rate limiting — reusable across all API routes (and by any
 * future application-form endpoint).
 *
 * Algorithm: atomic fixed-window counter.
 *   SET key 0 EX <window> NX   — creates the window (with TTL) only if absent
 *   INCR key                   — atomic request count within the window
 *   TTL key                    — seconds until the window resets
 * All three run in ONE Redis pipeline; INCR is the serialization point, so
 * concurrent requests can never push more than `limit` requests through a
 * window. State lives entirely in Redis — shared across all Vercel
 * serverless instances, never in process memory.
 *
 * Trade-off (accepted): fixed windows allow a ~2x burst across a window
 * boundary. Acceptable because the limits are intentionally generous for
 * the stall environment, where many players share one public IP.
 *
 * REDIS FAILURE BEHAVIOR (documented decision): FAIL-OPEN.
 * If the limiter cannot run, requests proceed and the error is logged
 * server-side (no secrets). Rationale: rate limiting is abuse protection,
 * not data integrity. The integrity controls (session validation,
 * one-submission-per-session, score plausibility caps) live on the main
 * Redis path anyway, which already degrades to clean 503s during an
 * outage. Failing closed here would add a new single point of total
 * failure for zero integrity gain, and would contradict the project rule
 * that Redis problems must never make the game unusable.
 *
 * IP identification: prefers Vercel's `x-real-ip`, then the first entry of
 * `x-forwarded-for`. Values are sanitized with a strict IP-charset check;
 * anything missing/malformed falls back to the shared bucket "unknown".
 * (At the stall, many laptops share one public IP — limits are set
 * generously for exactly that reason.)
 */

const { redis } = require("./redis");

const DEFAULTS = {
  sessionPerIpPerHour: 120,     // POST /api/session per IP per hour
  scoresPerIpPerHour: 240,      // POST /api/scores per IP per hour
  leaderboardPerIpPerMin: 120,  // GET /api/leaderboard per IP per minute (origin hits only)
  globalSessionsPerDay: 3000,   // global circuit breaker: sessions per rolling 24h
  adminTrimPerIpPerMin: 10,     // POST /api/admin/trim-leaderboard per IP per minute
};

/** Read a limit from env with a safe fallback (read at call time, so tests/ops can tune it). */
function limitFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const IP_RE = /^[a-fA-F0-9:.]{1,45}$/; // IPv4/IPv6 safe charset, max length

function clientIp(req) {
  const h = (req && req.headers) || {};
  const xff = typeof h["x-forwarded-for"] === "string" ? h["x-forwarded-for"].split(",")[0] : undefined;
  for (const candidate of [h["x-real-ip"], xff]) {
    if (typeof candidate === "string") {
      const v = candidate.trim();
      if (IP_RE.test(v)) return v;
    }
  }
  return "unknown";
}

/**
 * Atomic fixed-window check.
 * @returns {{ allowed: boolean, count: number, limit: number, remaining: number, retryAfter: number, windowSeconds: number }}
 */
async function rateLimit(identifier, route, limit, windowSeconds) {
  const key = `ratelimit:${route}:${identifier}`;
  const [setRes, countRaw, ttlRaw] = await redis([
    ["SET", key, "0", "EX", String(windowSeconds), "NX"],
    ["INCR", key],
    ["TTL", key],
  ]);

  const count = Number(countRaw) || 0;
  let ttl = Number(ttlRaw);
  if (!Number.isFinite(ttl) || ttl < 0) {
    // Self-heal: a window without TTL would otherwise lock forever.
    await redis([["EXPIRE", key, String(windowSeconds)]]);
    ttl = windowSeconds;
  }

  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfter: Math.max(1, ttl),
    windowSeconds,
  };
}

/**
 * Rate-limit a request and send the 429 response when exhausted.
 * @returns the rate-limit info when allowed (caller proceeds),
 *          or null when a 429 has already been sent (caller must stop).
 */
async function enforceRateLimit(req, res, route, limit, windowSeconds, { identifier, message } = {}) {
  let rl;
  try {
    rl = await rateLimit(identifier ?? clientIp(req), route, limit, windowSeconds);
  } catch (err) {
    console.error(`[ratelimit] ${route} limiter unavailable, failing open:`, err && err.message);
    return { allowed: true, failOpen: true };
  }

  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.setHeader("Cache-Control", "no-store"); // never cache a 429
    res.status(429).json({ error: message || "Too many requests. Please try again later." });
    return null;
  }
  return rl;
}

module.exports = { rateLimit, enforceRateLimit, clientIp, limitFromEnv, DEFAULTS };
