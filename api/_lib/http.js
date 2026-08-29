/*
 * Shared request/response helpers for the API routes.
 */

const MAX_BODY_BYTES = 4096;

function httpError(status, message) {
  return { status, message, __httpError: true };
}

function isErrorHttp(err) {
  return err && err.__httpError === true;
}

/**
 * Parse a JSON request body with a hard size cap.
 * Works with the Vercel Node runtime (which may pre-parse req.body)
 * and with plain streams (local test harness).
 * Throws { status, message } on problems.
 */
async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    const b = req.body;
    if (typeof b === "object" && !Buffer.isBuffer(b)) {
      return b; // already parsed by the platform
    }
    return parseJson(Buffer.isBuffer(b) ? b.toString("utf8") : String(b));
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError(413, "Request body too large");
    }
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString("utf8"));
}

function parseJson(text) {
  if (!text || !text.trim()) throw httpError(400, "Request body is required");
  if (text.length > MAX_BODY_BYTES) throw httpError(413, "Request body too large");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw httpError(400, "Malformed JSON body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw httpError(400, "JSON body must be an object");
  }
  return parsed;
}

module.exports = { readJsonBody, httpError, isErrorHttp, MAX_BODY_BYTES };
