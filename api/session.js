/*
 * POST /api/session
 * Body: { "name": "PlayerName", "playerToken"?: "<32 hex chars>" }
 * -> 200 { "sessionId": "<32 hex chars>", "playerToken": "<32 hex chars>" }
 *
 * Validates the name server-side, mints a cryptographically random session
 * id and stores the session in Redis with a 15 minute TTL. The game sends
 * this id back with the score submission in POST /api/scores.
 *
 * playerToken (Step 4): the server-issued identity that groups an individual
 * player's retry attempts into ONE personal-best leaderboard entry. A client
 * may present an existing token (RETRY flow — new session, same player) or
 * omit it (NEW GAME flow — a fresh identity is minted). It is stored in the
 * session record so score submissions can be bound to it.
 */

const crypto = require("node:crypto");
const { redis, RedisUnavailableError } = require("./_lib/redis");
const { cleanName, isPlayerToken } = require("./_lib/validate");
const { readJsonBody, httpError, isErrorHttp } = require("./_lib/http");
const { enforceRateLimit, limitFromEnv, DEFAULTS } = require("./_lib/ratelimit");

const SESSION_TTL_SECONDS = 15 * 60;

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") throw httpError(405, "Method not allowed");

    /*
     * Per-IP abuse limit — generous by design: at the orientation stall many
     * students share one public IP. Runs before any body parsing or Redis
     * work so abuse is rejected as early as possible.
     */
    if (!(await enforceRateLimit(req, res, "session", limitFromEnv("RATE_LIMIT_SESSION_PER_HOUR", DEFAULTS.sessionPerIpPerHour), 3600))) return;

    const body = await readJsonBody(req);
    const name = cleanName(body.name);
    if (!name) throw httpError(400, "Invalid name: must be 1-14 characters");

    /*
     * Global daily circuit breaker (all IPs combined): protects the Upstash
     * free tier from a bot, bug, or runaway client. Rolling 24h window in
     * Redis — automatically recovers, never a permanent lockout. Checked
     * only after name validation so garbage traffic burns per-IP budget,
     * not the global quota.
     */
    if (!(await enforceRateLimit(req, res, "global-sessions", limitFromEnv("GLOBAL_DAILY_SESSION_LIMIT", DEFAULTS.globalSessionsPerDay), 86400, {
      identifier: "global",
      message: "Server is at capacity right now. Please try again later.",
    }))) return;

    const sessionId = crypto.randomBytes(16).toString("hex");

    /*
     * Player identity for the retry flow: reuse the client's existing token
     * (RETRY) or mint a new one (NEW GAME / first visit). Format-checked —
     * it is user-supplied input like the name.
     */
    let playerToken;
    if (body.playerToken === undefined || body.playerToken === null || body.playerToken === "") {
      playerToken = crypto.randomBytes(16).toString("hex");
    } else if (isPlayerToken(String(body.playerToken))) {
      playerToken = String(body.playerToken);
    } else {
      throw httpError(400, "Invalid playerToken");
    }

    const record = JSON.stringify({ name, playerToken, createdAt: Date.now() });

    await redis([
      ["SET", `session:${sessionId}`, record, "EX", String(SESSION_TTL_SECONDS)],
    ]);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ sessionId, playerToken });
  } catch (err) {
    handleError(res, err);
  }
};

function handleError(res, err) {
  res.setHeader("Cache-Control", "no-store"); // never cache error responses
  if (isErrorHttp(err)) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof RedisUnavailableError) {
    console.error("[session] redis unavailable:", err.message);
    res.status(503).json({ error: "Leaderboard backend unavailable" });
    return;
  }
  console.error("[session] unexpected error:", err);
  res.status(500).json({ error: "Internal server error" });
}
