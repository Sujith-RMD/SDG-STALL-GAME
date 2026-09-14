/*
 * Leaderboard trimming — the Redis counterpart of sql/trim-leaderboard.sql.
 *
 * The SQL script runs
 *     BEGIN -> snapshot keepers -> pre-flight assert -> DELETE -> post-trim
 *     assert -> COMMIT
 * and keeps only the top N rows by score. This module does the same thing to
 * the Redis sorted sets that back the live board (lb:all, lb:day:<date>).
 *
 * WHY A LUA SCRIPT AND NOT A PIPELINE
 * -----------------------------------
 * The trim is read-decide-write: we must read the board, work out which
 * members are the keepers, and only then remove the rest. If another client
 * can write between the read and the write, the decision is stale.
 *
 * Redis has no BEGIN/COMMIT, and with the Upstash REST client
 * WATCH/MULTI/EXEC is not available either: WATCH is *connection*-scoped
 * state and the REST API is stateless, so there is no connection to hold the
 * watch on. (MULTI/EXEC can be pipelined, but without WATCH it gives no
 * read-then-decide guarantee.) A server-side Lua script is therefore the only
 * primitive that makes the whole read-decide-write sequence atomic — Redis
 * runs it to completion with no other command interleaving. That is what
 * TRIM_SCRIPT is, and it is the direct analogue of the SQL transaction.
 *
 * SAFETY STRUCTURE (mirrors the SQL script step for step)
 * ------------------------------------------------------
 *   1. ZCARD              -> total. Empty or already <= N: nothing to do.
 *   2. ZREVRANGE rank N-1 -> the cutoff score, i.e. the score of the last
 *                            keeper.
 *   3. ZCOUNT (cutoff +inf -> how many members outrank the cutoff. If that
 *                            exceeds N the ranking is inconsistent: abort
 *                            BEFORE removing anything (the SQL script's
 *                            pre-flight assertion).
 *   4. Tie group at the cutoff is ordered by (ts ASC, member ASC) — the same
 *                            deterministic tiebreak as the SQL script's
 *                            ORDER BY score DESC, created_at ASC, id ASC.
 *                            `ts` comes from the score:detail:<member> hash.
 *   5. Removal: ZREMRANGEBYSCORE for everything strictly below the cutoff
 *      (predicate evaluated at execution time, so it can never touch a
 *      member at or above the cutoff), then ZREM for the specific
 *      boundary losers.
 *   6. Verification: the survivor count must equal N and no survivor may
 *      score below the cutoff (the SQL script's post-trim assertion).
 *
 * The script is used for BOTH the dry run and the real apply (differing only
 * in one argument), so the plan you preview is produced by exactly the code
 * that performs the delete — the two can never drift apart.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * * No rollback. Redis does not roll Lua back on error, so if the script's
 *   own post-check fails the board may be left partially trimmed. The
 *   post-check is designed to be unreachable (step 5 lands on exactly N
 *   members by construction), so a failure means the script itself is wrong —
 *   and that should be reported loudly rather than papered over. A
 *   `verify_failed` status is surfaced as a 500, never as success.
 * * Not atomic ACROSS boards. `scope: "both"` runs the script once per board;
 *   each board is internally atomic, the pair is not. Nothing reads the two
 *   together in a way that matters.
 * * Does not touch the score:detail:<member> hashes of removed members. They
 *   already carry a 30-day TTL (see api/scores.js) and expire on their own,
 *   so purging them would add a second destructive path for no real gain.
 */

const { redis, redis1 } = require("./redis");
const { todayKey } = require("./score");

const KEEP_DEFAULT = 3;
const KEEP_MAX = 100;
const SCOPES = ["all", "today", "both"];
const DETAIL_PREFIX = "score:detail:";
const REPORT_KEEP_LIMIT = 25; // cap the entries echoed back in the response

/* Status values returned by the script. */
const STATUS_OK = "ok";
const STATUS_DRY_RUN = "dry_run";
const STATUS_EMPTY = "empty";
const STATUS_NOOP = "noop";
const STATUS_PREFLIGHT_FAILED = "preflight_failed";
const STATUS_VERIFY_FAILED = "verify_failed";

/*
 * KEYS[1] = sorted set to trim (e.g. lb:all)
 * ARGV[1] = detail-hash prefix (score:detail:) — a prefix, not a key, so it
 *           travels as an argument rather than being declared in KEYS
 * ARGV[2] = how many entries to keep
 * ARGV[3] = "1" to apply, "0" for a dry run
 *
 * Returns a flat array (RESP2 cannot nest tables):
 *   { status, detail, before, after, expected, cutoff, removed, tiebreak }
 *
 * `after` is the projected count on a dry run and the verified count on an
 * apply, so it always means "members on the board once this is done".
 */
const TRIM_SCRIPT = `
local key    = KEYS[1]
local prefix = ARGV[1]
local keep   = tonumber(ARGV[2])
local apply  = ARGV[3] == '1'

-- Guard: a board where a huge number of members share the cutoff score would
-- make the tie-ordering loop expensive. Above this many we keep the count
-- right and fall back to Redis rank order instead of the timestamp order.
local MAX_BOUNDARY = 500

local function report(status, detail, before, after, expected, cutoff, removed, tiebreak)
  return { status, detail, before, after, expected, cutoff, removed, tiebreak }
end

local before = redis.call('ZCARD', key)
if before == 0 then
  return report('empty', '', 0, 0, 0, 0, 0, 'none')
end

local expected = keep
if before < expected then expected = before end

-- Nothing to trim. (Also makes a second run a no-op, like the SQL script.)
if before <= expected then
  return report('noop', '', before, before, expected, 0, 0, 'none')
end

-- The cutoff is the score of the last keeper, i.e. the entry at rank expected.
local edge = redis.call('ZREVRANGE', key, expected - 1, expected - 1, 'WITHSCORES')
if #edge < 2 then
  return report('preflight_failed',
    'no entry found at rank ' .. tostring(expected), before, before, expected, 0, 0, 'none')
end
local cutoffText = edge[2]
local cutoff = tonumber(cutoffText)

-- Pre-flight: everything strictly above the cutoff is a keeper, so there can
-- never be more of them than the number of keepers. If there are, the board
-- and our read of it disagree -> abort without removing anything.
local above = redis.call('ZCOUNT', key, '(' .. cutoffText, '+inf')
if above > expected then
  return report('preflight_failed',
    tostring(above) .. ' entries outrank the cutoff but only ' .. tostring(expected) .. ' are kept',
    before, before, expected, cutoff, 0, 'none')
end

local needFromBoundary = expected - above

local boundary = redis.call('ZRANGEBYSCORE', key, cutoffText, cutoffText)
local tiebreak = 'timestamp'
local doomed = {}

if #boundary > MAX_BOUNDARY then
  tiebreak = 'rank'
else
  -- Deterministic tiebreak: ts ascending (entries with no recorded ts sort
  -- last, so entries with known provenance win), then member ascending.
  local ordered = {}
  for i = 1, #boundary do
    local member = boundary[i]
    local raw = redis.call('HGET', prefix .. member, 'ts')
    local ts = nil
    if raw then ts = tonumber(raw) end
    ordered[i] = { member, ts }
  end

  table.sort(ordered, function(a, b)
    if a[2] ~= b[2] then
      if a[2] == nil then return false end
      if b[2] == nil then return true end
      return a[2] < b[2]
    end
    return a[1] < b[1]
  end)

  for i = needFromBoundary + 1, #ordered do
    doomed[#doomed + 1] = ordered[i][1]
  end
end

if not apply then
  -- Projected outcome, identical to what an apply would produce.
  return report('dry_run', '', before, expected, expected, cutoff, 0, tiebreak)
end

-- 1) Everything strictly below the cutoff.
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. cutoffText)

-- 2) The boundary losers. Either by rank (fallback) or by explicit member
--    list, chunked because unpack() has an argument-count cap.
--
--    NOTE ON RANK DIRECTION: Redis sorted-set ranks ASCEND by score, so rank
--    0 is the LOWEST entry and ZREMRANGEBYRANK key 0 -1 clears the whole set.
--    At this point the board holds the 'above' members (score > cutoff)
--    followed by the #boundary members tied at it, so the ones we drop are
--    the lowest (#boundary - needFromBoundary) of them: ASC ranks 0 .. that-1.
if tiebreak == 'rank' then
  local drop = #boundary - needFromBoundary
  if drop > 0 then
    redis.call('ZREMRANGEBYRANK', key, 0, drop - 1)
  end
else
  local i = 1
  while i <= #doomed do
    local chunk = {}
    for j = i, math.min(i + 499, #doomed) do
      chunk[#chunk + 1] = doomed[j]
    end
    redis.call('ZREM', key, unpack(chunk))
    i = i + 500
  end
end

-- Post-trim verification.
local after = redis.call('ZCARD', key)
if after ~= expected then
  return report('verify_failed',
    'expected ' .. tostring(expected) .. ' entries after the trim, found ' .. tostring(after),
    before, after, expected, cutoff, before - after, tiebreak)
end

-- Every survivor must score at or above the cutoff. Together with the count
-- check this proves the survivors are the top 'expected' entries by score.
local lowest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if #lowest == 2 and tonumber(lowest[2]) < cutoff then
  return report('verify_failed',
    'a surviving entry scores below the cutoff (' .. tostring(lowest[2]) .. ' < ' .. tostring(cutoff) .. ')',
    before, after, expected, cutoff, before - after, tiebreak)
end

return report('ok', '', before, after, expected, cutoff, before - after, tiebreak)
`;

/** The Redis keys a scope covers. `today` is the daily board for UTC today. */
function boardKeys(scope) {
  const all = "lb:all";
  const today = `lb:day:${todayKey()}`;
  if (scope === "today") return [today];
  if (scope === "both") return [all, today];
  return [all];
}

function isScope(value) {
  return SCOPES.includes(value);
}

/** Read the current entries of a board, highest first (mirrors api/leaderboard.js). */
async function readBoard(key, limit = REPORT_KEEP_LIMIT) {
  const flat = await redis1(["ZREVRANGE", key, "0", String(limit - 1), "WITHSCORES"]);
  const members = [];
  const scores = [];
  for (let i = 0; i < flat.length; i += 2) {
    members.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  if (!members.length) return [];

  const details = await redis(members.map((m) => ["HMGET", `${DETAIL_PREFIX}${m}`, "name", "ts"]));
  return members.map((member, i) => {
    const d = details[i] || [];
    return {
      rank: i + 1,
      member,
      name: typeof d[0] === "string" ? d[0] : "Anonymous Bee",
      score: scores[i],
      ts: d[1] == null ? null : Number(d[1]),
    };
  });
}

/**
 * Run the trim script against one board.
 * @returns the script's raw report for that key
 */
async function trimBoard(key, keep, dryRun) {
  const raw = await redis1([
    "EVAL", TRIM_SCRIPT, "1", key, DETAIL_PREFIX, String(keep), dryRun ? "0" : "1",
  ]);

  if (!Array.isArray(raw) || raw.length < 8) {
    throw new Error(`trim script returned an unexpected result for ${key}`);
  }

  const [status, detail, before, after, expected, cutoff, removed, tiebreak] = raw;
  return {
    key,
    status: String(status),
    detail: String(detail || ""),
    before: Number(before),
    after: Number(after),
    expected: Number(expected),
    cutoff: Number(cutoff),
    removed: Number(removed),
    tiebreak: String(tiebreak),
  };
}

/**
 * Trim one or more leaderboard keys down to the top `keep` entries.
 *
 * @param {{ scope?: string, keep?: number, dryRun?: boolean }} options
 * @returns {Promise<{ applied: boolean, dryRun: boolean, scope: string, keep: number,
 *                     boards: Array<object>, warnings: string[], ok: boolean }>}
 */
async function trimLeaderboard({ scope = "all", keep = KEEP_DEFAULT, dryRun = true } = {}) {
  if (!isScope(scope)) throw new Error(`unknown scope: ${scope}`);
  if (!Number.isInteger(keep) || keep < 1 || keep > KEEP_MAX) {
    throw new Error(`keep must be an integer between 1 and ${KEEP_MAX}`);
  }

  const keys = boardKeys(scope);
  const boards = [];
  const warnings = [];
  let ok = true;

  for (const key of keys) {
    const result = await trimBoard(key, keep, dryRun);

    /*
     * Independent read-back. The script verifies its own work, but reading
     * the board again from the handler means a script that silently did the
     * wrong thing still gets caught here rather than being reported as
     * success.
     */
    const kept = await readBoard(key);
    const countMatches = dryRun ? true : kept.length === result.after;

    if (result.status === STATUS_PREFLIGHT_FAILED || result.status === STATUS_VERIFY_FAILED) {
      ok = false;
      warnings.push(`${key}: ${result.detail}`);
    }
    if (!countMatches) {
      ok = false;
      warnings.push(
        `${key}: read-back found ${kept.length} entries but the script reported ${result.after}`
      );
    }
    if (result.tiebreak === "rank") {
      warnings.push(
        `${key}: too many entries tied at the cutoff score (${result.cutoff}) — ` +
        `kept ${result.expected} in Redis rank order instead of timestamp order`
      );
    }
    if (result.status === STATUS_VERIFY_FAILED) {
      warnings.push(
        `${key}: the trim may be incomplete and was NOT rolled back (Redis does not ` +
        `roll back Lua scripts). Inspect the board before retrying.`
      );
    }

    boards.push({
      key,
      status: result.status,
      before: result.before,
      after: result.after,
      expected: result.expected,
      cutoff: result.cutoff,
      removed: result.removed,
      wouldRemove: result.before - result.expected,
      tiebreak: result.tiebreak,
      detail: result.detail || null,
      countVerified: countMatches,
      kept,
    });
  }

  /*
   * Documented side effect: GET /api/leaderboard reports aggregates.players
   * as ZCARD lb:all, so trimming that board lowers the reported player count.
   * The aggregates are deliberately NOT rewritten here — they are historical
   * totals, and silently editing them would be worse than reporting the drift.
   */
  if (keys.includes("lb:all") && boards.some((b) => b.removed > 0)) {
    warnings.push(
      "lb:all was trimmed: GET /api/leaderboard derives aggregates.players from " +
      "ZCARD lb:all, so the reported player count will now be " +
      `${boards.find((b) => b.key === "lb:all").after}. The stats:* counters are untouched.`
    );
  }

  return {
    ok,
    applied: !dryRun && ok,
    dryRun,
    scope,
    keep,
    boards,
    warnings,
  };
}

module.exports = {
  trimLeaderboard,
  trimBoard,
  readBoard,
  boardKeys,
  isScope,
  TRIM_SCRIPT,
  KEEP_DEFAULT,
  KEEP_MAX,
  SCOPES,
  DETAIL_PREFIX,
  REPORT_KEEP_LIMIT,
  STATUS_OK,
  STATUS_DRY_RUN,
  STATUS_EMPTY,
  STATUS_NOOP,
  STATUS_PREFLIGHT_FAILED,
  STATUS_VERIFY_FAILED,
};
