/*
 * POST /api/admin/trim-leaderboard
 *
 * Keeps only the top N entries of the leaderboard and deletes the rest — the
 * Redis counterpart of sql/trim-leaderboard.sql. The atomic read-decide-write
 * logic lives in api/_lib/trim.js; this file is the guarded HTTP shell.
 *
 * Request (body optional):
 *   {
 *     "confirm": true,          // REQUIRED to actually delete anything
 *     "dryRun":  false,         // force a preview even with confirm:true
 *     "scope":   "all",         // "all" (default) | "today" | "both"
 *     "keep":    3              // 1..100, default from LEADERBOARD_KEEP or 3
 *   }
 *   -> 200 { applied, dryRun, scope, keep, boards: [...], warnings: [...] }
 *
 * DRY RUN IS THE DEFAULT. An empty body, or a body without `confirm: true`,
 * only reports what would happen. Deleting requires an explicit
 * `"confirm": true`, so a mistyped curl cannot wipe the board.
 *
 * AUTHENTICATION
 * Requires the ADMIN_TRIM_TOKEN environment variable, presented either as
 * `Authorization: Bearer <value>` or `X-Admin-Token: <value>`, compared in
 * constant time. This route FAILS CLOSED — unlike the rate limiter, which
 * deliberately fails open, a destructive endpoint that is not configured must
 * refuse to run rather than default to permitting access. A token shorter
 * than 24 characters is treated as unconfigured, because a guessable secret
 * on a delete-everything endpoint is worse than no endpoint.
 *
 * ORDERING OF THE GUARDS
 * method -> configured -> rate limit -> authorization -> body validation.
 * The limiter runs BEFORE the token check on purpose: it is the only thing
 * standing between the token and an offline brute-force attempt.
 *
 * SIDE EFFECT WORTH KNOWING
 * GET /api/leaderboard reports aggregates.players as ZCARD lb:all. Trimming
 * lb:all therefore lowers that reported figure. The stats:* counters are left
 * alone (they are historical totals), and the drift is reported back in
 * `warnings` rather than being silently corrected.
 */

const crypto = require("crypto");
const { RedisUnavailableError } = require("../_lib/redis");
const { readOptionalJsonBody, httpError, isErrorHttp } = require("../_lib/http");
const { enforceRateLimit, limitFromEnv, DEFAULTS } = require("../_lib/ratelimit");
const {
  trimLeaderboard,
  isScope,
  KEEP_DEFAULT,
  KEEP_MAX,
  SCOPES,
  STATUS_PREFLIGHT_FAILED,
  STATUS_VERIFY_FAILED,
} = require("../_lib/trim");

/** Minimum acceptable secret length; shorter is treated as unconfigured. */
const MIN_TOKEN_LENGTH = 24;

/** Rejected outright if present, so `{"dryrun":true}` cannot silently apply. */
const ALLOWED_FIELDS = ["confirm", "dryRun", "scope", "keep"];

const SAFE_FIELD_NAME = /^[A-Za-z0-9_]{1,40}$/;

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store"); // an admin route is never cacheable
    if (req.method !== "POST") throw httpError(405, "Method not allowed");

    const secret = adminSecret();

    // Throttle token guessing before doing any comparison.
    const limit = limitFromEnv("RATE_LIMIT_ADMIN_TRIM_PER_MIN", DEFAULTS.adminTrimPerIpPerMin);
    if (!(await enforceRateLimit(req, res, "admin-trim", limit, 60))) return;

    assertAuthorized(req, secret);

    const options = parseOptions(await readOptionalJsonBody(req));
    const report = await trimLeaderboard(options);

    /*
     * A failed pre-flight means the board moved under us and nothing was
     * removed; a failed post-check means the script's own invariant broke.
     * Neither is ever reported as success.
     */
    const failed = report.boards.filter(
      (b) => b.status === STATUS_PREFLIGHT_FAILED || b.status === STATUS_VERIFY_FAILED
    );
    if (failed.length) {
      const verificationFailed = failed.some((b) => b.status === STATUS_VERIFY_FAILED);
      res.status(verificationFailed ? 500 : 409).json({
        error: verificationFailed
          ? "Trim verification failed — the affected board may be partially trimmed"
          : "Leaderboard state changed during the trim — the affected board was left untouched",
        ...report,
      });
      return;
    }

    // Anything else that left `ok` false — currently a read-back that
    // disagrees with the script — is also a failure, never a 200.
    if (!report.ok) {
      res.status(500).json({
        error: "Trim verification failed — the board did not match the expected result",
        ...report,
      });
      return;
    }

    res.status(200).json(report);
  } catch (err) {
    handleError(res, err);
  }
};

/* ------------------------------------------------------------------ auth -- */

/**
 * Read and validate the admin secret from the environment.
 * Fails closed: an absent or too-short value disables the endpoint entirely.
 */
function adminSecret() {
  const value = process.env.ADMIN_TRIM_TOKEN;
  if (typeof value !== "string" || value.length < MIN_TOKEN_LENGTH) {
    console.error(
      "[admin/trim-leaderboard] ADMIN_TRIM_TOKEN is missing or shorter than " +
      `${MIN_TOKEN_LENGTH} characters; refusing to run`
    );
    throw httpError(503, "Admin trim endpoint is not configured");
  }
  return value;
}

/** Extract the presented secret from either supported header. */
function presentedSecret(req) {
  const headers = (req && req.headers) || {};

  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(auth.trim());
    if (match) return match[1];
  }

  const direct = headers["x-admin-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  return null;
}

function assertAuthorized(req, secret) {
  const presented = presentedSecret(req);
  if (!presented || !constantTimeEqual(secret, presented)) {
    // Same response either way: never reveal whether a secret was absent or wrong.
    throw httpError(401, "Unauthorized");
  }
}

function constantTimeEqual(expected, presented) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  // Length is not secret-dependent in a way that matters here, and
  // timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* -------------------------------------------------------------- validation -- */

function parseOptions(body) {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      // Echo the name only when it is plainly safe — never reflect arbitrary input.
      throw httpError(
        400,
        SAFE_FIELD_NAME.test(key) ? `Unknown field: ${key}` : "Unknown field in request body"
      );
    }
  }

  const scope = body.scope === undefined ? "all" : body.scope;
  if (!isScope(scope)) {
    throw httpError(400, `scope must be one of: ${SCOPES.join(", ")}`);
  }

  const keep = body.keep === undefined
    ? limitFromEnv("LEADERBOARD_KEEP", KEEP_DEFAULT)
    : body.keep;
  if (!Number.isInteger(keep) || keep < 1 || keep > KEEP_MAX) {
    throw httpError(400, `keep must be an integer between 1 and ${KEEP_MAX}`);
  }

  if (body.confirm !== undefined && typeof body.confirm !== "boolean") {
    throw httpError(400, "confirm must be a boolean");
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    throw httpError(400, "dryRun must be a boolean");
  }

  // Deleting requires BOTH an explicit confirm:true and no explicit dryRun:true.
  const apply = body.confirm === true && body.dryRun !== true;

  return { scope, keep, dryRun: !apply };
}

/* ----------------------------------------------------------------- errors -- */

function handleError(res, err) {
  res.setHeader("Cache-Control", "no-store"); // never cache error responses
  if (isErrorHttp(err)) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof RedisUnavailableError) {
    console.error("[admin/trim-leaderboard] redis unavailable:", err.message);
    res.status(503).json({ error: "Leaderboard backend unavailable" });
    return;
  }
  console.error("[admin/trim-leaderboard] unexpected error:", err);
  res.status(500).json({ error: "Internal server error" });
}
