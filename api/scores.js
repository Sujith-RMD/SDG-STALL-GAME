/*
 * POST /api/scores
 * Body: {
 *   sessionId, durationMs, flowers, cleanup, natives,
 *   pipes, closeCalls, bestCombo, bee, eco
 * }
 * -> 200 { "score": <number>, "rank": <number|null> }
 *
 * The final score is NEVER taken from the client. Raw statistics are
 * validated against the game's real limits and the score is recomputed
 * server-side (see _lib/score.js). Each session may submit exactly once.
 */

const { redis, RedisUnavailableError } = require("./_lib/redis");
const { validateStats } = require("./_lib/validate");
const { CAPS, todayKey, computeScore } = require("./_lib/score");
const { readJsonBody, httpError, isErrorHttp } = require("./_lib/http");
const { enforceRateLimit, limitFromEnv, DEFAULTS } = require("./_lib/ratelimit");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") throw httpError(405, "Method not allowed");

    /*
     * Per-IP abuse limit — runs before session lookup so spam does no
     * Redis work. A 429 here never consumes the session's one-submission
     * slot; that claim happens later, atomically via SET NX.
     */
    if (!(await enforceRateLimit(req, res, "scores", limitFromEnv("RATE_LIMIT_SCORES_PER_HOUR", DEFAULTS.scoresPerIpPerHour), 3600))) return;

    const body = await readJsonBody(req);
    const check = validateStats(body, CAPS);
    if (!check.ok) throw httpError(400, check.error);
    const stats = check.stats;

    // The session must exist (15 min TTL from POST /api/session).
    const sessionRaw = (await redis([["GET", `session:${stats.sessionId}`]]))[0];
    if (!sessionRaw) throw httpError(404, "Session not found or expired");
    let session;
    try {
      session = JSON.parse(sessionRaw);
    } catch {
      session = { name: "Anonymous Bee" };
    }

    // Exactly one submission per session (atomic claim).
    const claimed = (await redis([
      ["SET", `submitted:${stats.sessionId}`, "1", "EX", "900", "NX"],
    ]))[0];
    if (claimed !== "OK" && claimed !== 1) {
      throw httpError(409, "Score already submitted for this session");
    }

    const score = computeScore(stats);
    const dayKey = `lb:day:${todayKey()}`;
    const detailKey = `score:detail:${stats.sessionId}`;
    const ts = Date.now();

    await redis([
      ["ZADD", "lb:all", score, stats.sessionId],
      ["ZADD", dayKey, score, stats.sessionId],
      ["HSET", detailKey,
        "name", session.name || "Anonymous Bee",
        "score", String(score),
        "flowers", String(stats.flowers),
        "cleanup", String(stats.cleanup),
        "natives", String(stats.natives),
        "pipes", String(stats.pipes),
        "closeCalls", String(stats.closeCalls),
        "bestCombo", String(stats.bestCombo),
        "eco", String(Math.round(stats.eco)),
        "ts", String(ts)],
      ["INCR", "stats:games"],
      ["INCRBY", "stats:flowers", String(stats.flowers)],
      ["INCRBY", "stats:ecosum", String(Math.round(stats.eco))],
      ["EXPIRE", dayKey, "604800"],
    ]);

    // Rank within today's board (1-based). All-time rank is not needed now.
    const rank = (await redis([["ZREVRANK", dayKey, stats.sessionId]]))[0];

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      score,
      rank: typeof rank === "number" ? rank + 1 : null,
    });
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
    console.error("[scores] redis unavailable:", err.message);
    res.status(503).json({ error: "Leaderboard backend unavailable" });
    return;
  }
  console.error("[scores] unexpected error:", err);
  res.status(500).json({ error: "Internal server error" });
}
