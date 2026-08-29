/*
 * POST /api/session
 * Body: { "name": "PlayerName" }
 * -> 200 { "sessionId": "<32 hex chars>" }
 *
 * Validates the name server-side, mints a cryptographically random session
 * id and stores the session in Redis with a 15 minute TTL. The game sends
 * this id back with the score submission in POST /api/scores.
 */

const crypto = require("node:crypto");
const { redis, RedisUnavailableError } = require("./_lib/redis");
const { cleanName } = require("./_lib/validate");
const { readJsonBody, httpError, isErrorHttp } = require("./_lib/http");

const SESSION_TTL_SECONDS = 15 * 60;

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") throw httpError(405, "Method not allowed");

    const body = await readJsonBody(req);
    const name = cleanName(body.name);
    if (!name) throw httpError(400, "Invalid name: must be 1-14 characters");

    const sessionId = crypto.randomBytes(16).toString("hex");
    const record = JSON.stringify({ name, createdAt: Date.now() });

    await redis([
      ["SET", `session:${sessionId}`, record, "EX", String(SESSION_TTL_SECONDS)],
    ]);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ sessionId });
  } catch (err) {
    handleError(res, err);
  }
};

function handleError(res, err) {
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
