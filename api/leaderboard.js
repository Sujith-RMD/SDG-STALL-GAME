/*
 * GET /api/leaderboard?period=all|today
 * -> 200 {
 *      period,
 *      entries: [{ rank, name, score, flowers, eco }],
 *      aggregates: { games, flowers, avgEco }
 *    }
 *
 * Ranked with a Redis sorted set (highest first). The response carries a
 * short edge-cache header so a whole stall of laptops polling the board
 * doesn't hit Redis on every request.
 */

const { redis, RedisUnavailableError } = require("./_lib/redis");
const { todayKey } = require("./_lib/score");
const { httpError, isErrorHttp } = require("./_lib/http");
const { enforceRateLimit, limitFromEnv, DEFAULTS } = require("./_lib/ratelimit");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") throw httpError(405, "Method not allowed");

    /*
     * Per-IP origin limit. Edge-cached responses (s-maxage=15) never reach
     * this function, so the limiter only sees real origin hits — normal
     * stall polling stays far under it. Edge caching itself is unchanged.
     */
    if (!(await enforceRateLimit(req, res, "leaderboard", limitFromEnv("RATE_LIMIT_LEADERBOARD_PER_MIN", DEFAULTS.leaderboardPerIpPerMin), 60))) return;

    const period = req.query?.period === "today" ? "today" : "all";
    const key = period === "today" ? `lb:day:${todayKey()}` : "lb:all";

    const [top, gamesRaw, flowersRaw, ecoSumRaw] = await redis([
      ["ZREVRANGE", key, 0, 9, "WITHSCORES"],
      ["GET", "stats:games"],
      ["GET", "stats:flowers"],
      ["GET", "stats:ecosum"],
    ]);

    const ids = [];
    const scores = [];
    for (let i = 0; i < top.length; i += 2) {
      ids.push(top[i]);
      scores.push(Number(top[i + 1]));
    }

    // One pipeline for all display details of the top 10.
    const details = ids.length
      ? await redis(ids.map((id) => ["HMGET", `score:detail:${id}`, "name", "flowers", "eco"]))
      : [];

    const entries = ids.map((id, i) => {
      const d = details[i] || [];
      return {
        rank: i + 1,
        name: typeof d[0] === "string" ? d[0] : "Anonymous Bee",
        score: scores[i],
        flowers: Number(d[1] ?? 0),
        eco: Number(d[2] ?? 0),
      };
    });

    const games = Number(gamesRaw ?? 0);
    const flowersTotal = Number(flowersRaw ?? 0);
    const ecoSum = Number(ecoSumRaw ?? 0);
    const aggregates = {
      games,
      flowers: flowersTotal,
      avgEco: games > 0 ? Math.round(ecoSum / games) : 0,
    };

    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=30");
    res.status(200).json({ period, entries, aggregates });
  } catch (err) {
    handleError(res, err);
  }
};

function handleError(res, err) {
  res.setHeader("Cache-Control", "no-store"); // never cache error responses (success paths manage their own caching)
  if (isErrorHttp(err)) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof RedisUnavailableError) {
    console.error("[leaderboard] redis unavailable:", err.message);
    res.status(503).json({ error: "Leaderboard backend unavailable" });
    return;
  }
  console.error("[leaderboard] unexpected error:", err);
  res.status(500).json({ error: "Internal server error" });
}
