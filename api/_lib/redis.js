/*
 * Tiny Upstash Redis REST client — zero dependencies.
 *
 * Uses the REST pipeline endpoint: one POST can carry many commands and
 * returns one result per command. Credentials come from environment
 * variables and are only ever read server-side — this file runs exclusively
 * inside Vercel Serverless Functions and is never bundled for the browser.
 */

const BASE_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

  let res;
  try {
    res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
  } catch {
    throw new RedisUnavailableError("Could not reach Upstash Redis");
  }

  if (!res.ok) {
    throw new RedisUnavailableError(`Upstash Redis responded with HTTP ${res.status}`);
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
