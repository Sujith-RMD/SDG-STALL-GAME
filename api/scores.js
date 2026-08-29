/*
 * POST /api/scores
 * Body: {
 *   sessionId, durationMs, flowers, cleanup, natives,
 *   pipes, closeCalls, bestCombo, bee, eco, playerToken?
 * }
 * -> 200 {
 *      "score": <number>, "rank": <number|null>,
 *      "best": <number>, "newBest": <boolean>
 *    }
 *
 * The final score is NEVER taken from the client. Raw statistics are
 * validated against the game's real limits and the score is recomputed
 * server-side (see _lib/score.js). Each session may submit exactly once.
 *
 * Personal best (Step 4): leaderboard members are the server-issued
 * playerToken, so retry attempts by the same player collapse into ONE entry
 * whose score is the maximum (atomic ZADD GT). A payload without a
 * playerToken — e.g. a stale cached frontend — falls back to the sessionId
 * as the member, preserving the pre-Step-4 behavior.
 */

const { redis, RedisUnavailableError } = require("./_lib/redis");
const { validateStats, isPlayerToken } = require("./_lib/validate");
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

    /*
     * Player identity (Step 4): the leaderboard member is the playerToken
     * bound to this session — NOT a client-invented value. A mismatched
     * token is rejected so one player's attempts can never be filed under
     * another player's identity.
     */
    let member = stats.sessionId; // legacy fallback: payload without a token keeps the old behavior
    const claimedToken = typeof body.playerToken === "string" ? body.playerToken.trim().toLowerCase() : null;
    if (claimedToken) {
      if (!isPlayerToken(claimedToken)) throw httpError(400, "Invalid playerToken");
      if (session.playerToken && session.playerToken !== claimedToken) {
        throw httpError(400, "Session player mismatch");
      }
      member = claimedToken;
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
    const detailKey = `score:detail:${member}`;
    const ts = Date.now();

    /*
     * Personal best: ZADD GT atomically keeps the HIGHEST score per member —
     * a lower retry can never lower the entry, and no read-modify-write race
     * exists. The all-time best is read first purely to report `best` /
     * `newBest` to the UI.
     */
    const prevRaw = (await redis([["ZSCORE", "lb:all", member]]))[0];
    const previousBest = prevRaw == null ? null : Number(prevRaw);
    const isNewBest = previousBest == null || score > previousBest;

    const commands = [
      ["ZADD", "lb:all", "GT", String(score), member],
      ["ZADD", dayKey, "GT", String(score), member],
    ];
    if (isNewBest) {
      // Details always describe the run that produced the displayed best.
      commands.push(
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
        // Bounded retention: details of long-gone entries stop occupying the
        // free tier after 30 days.
        ["EXPIRE", detailKey, "2592000"],
      );
    }
    commands.push(
      ["INCR", "stats:games"],
      ["INCRBY", "stats:flowers", String(stats.flowers)],
      ["INCRBY", "stats:ecosum", String(Math.round(stats.eco))],
      ["EXPIRE", dayKey, "604800"],
    );

    await redis(commands);

    // Rank within today's board (1-based). All-time rank is not needed now.
    const rank = (await redis([["ZREVRANK", dayKey, member]]))[0];

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      score,
      rank: typeof rank === "number" ? rank + 1 : null,
      best: isNewBest ? score : previousBest,
      newBest: isNewBest,
    });
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
    console.error("[scores] redis unavailable:", err.message);
    res.status(503).json({ error: "Leaderboard backend unavailable" });
    return;
  }
  console.error("[scores] unexpected error:", err);
  res.status(500).json({ error: "Internal server error" });
}
