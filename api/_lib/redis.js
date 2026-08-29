/*
 * Tiny Upstash Redis REST client — zero dependencies.
 *
 * Uses the REST pipeline endpoint: one POST can carry many commands and
 * returns one result per command. Credentials come from environment
 * variables and are only ever read server-side — this file runs exclusively
 * inside Vercel Serverless Functions and is never bundled for the browser.
 */

/*
 * Credentials from the Vercel Upstash Marketplace integration, which injects
 * KV_REST_API_URL + KV_REST_API_TOKEN (the write token) automatically.
 * Falls back to the plain Upstash console REST variables (UPSTASH_REDIS_REST_*)
 * for manual setups and local .env.local files.
 * Server-side only — these values must never reach frontend JavaScript.
 */
const BASE_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

class RedisUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RedisUnavailableError";
  }
}

/*
 * Test hook: when set, redis() routes commands to the provided async
 * function instead of the REST API. Used only by test/local-check.mjs to
 * verify the full request flow without live credentials.
 */
let override = null;

/**
 * Execute a pipeline of Redis commands.
 * @param {Array<Array<string|number>>} commands e.g. [["SET","k","v","EX","900"],["INCR","n"]]
 * @returns {Promise<Array<*>>} one unwrapped result per command
 */
async function redis(commands) {
  if (override) return override(commands);

  if (!BASE_URL || !REST_TOKEN) {
    throw new RedisUnavailableError(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not configured"
    );
  }

  /*
   * Pipeline endpoint per the official Upstash REST API:
   *   POST {REST_URL}/pipeline  with a two-dimensional JSON array body,
   *   each row being [command, arg0, arg1, ...]. All arguments are
   *   serialized as strings, which is the documented format.
   * (Posting to the bare REST_URL root is not a valid route and returns 400.)
   */
  const pipelineUrl = `${BASE_URL.replace(/\/+$/, "")}/pipeline`;

  let res;
  try {
    res = await fetch(pipelineUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands.map((cmd) => cmd.map((arg) => String(arg)))),
    });
  } catch {
    throw new RedisUnavailableError("Could not reach Upstash Redis");
  }

  if (!res.ok) {
    /*
     * Log Upstash's own error body (truncated) so failures are diagnosable
     * from Vercel runtime logs. Never logs the URL or token.
     */
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {}
    throw new RedisUnavailableError(
      `Upstash Redis responded with HTTP ${res.status}${detail ? `: ${detail}` : ""}`
    );
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new RedisUnavailableError("Upstash Redis returned a malformed response");
  }

  if (!Array.isArray(data)) {
    throw new RedisUnavailableError("Upstash Redis pipeline response was not a list");
  }

  return data.map((entry) => {
    if (entry && typeof entry === "object" && "error" in entry) {
      throw new RedisUnavailableError(`Redis command failed: ${entry.error}`);
    }
    return entry?.result;
  });
}

/** Run a single command and return its result. */
async function redis1(command) {
  const [result] = await redis([command]);
  return result;
}

function _setOverride(fn) {
  override = fn;
}

module.exports = { redis, redis1, RedisUnavailableError, _setOverride };
