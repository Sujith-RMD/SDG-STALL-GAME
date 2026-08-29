/*
 * Server-side validation. The client's limits (maxlength=14, the game's
 * own caps) are treated as untrusted hints — everything is re-checked here.
 */

const NAME_MAX = 14; // matches the existing maxlength=14 in index.html

/**
 * Validate and normalize a player name.
 * Returns the cleaned name, or null when the name is invalid.
 */
function cleanName(raw) {
  if (typeof raw !== "string") return null;
  // Strip control characters (incl. newlines) and trim surrounding whitespace.
  const name = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (name.length < 1 || name.length > NAME_MAX) return null;
  return name;
}

function isSessionId(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

/**
 * Validate raw gameplay statistics.
 * Returns { ok: true, stats } or { ok: false, error }.
 */
function validateStats(body, CAPS) {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "JSON body must be an object" };
  }

  const required = [
    "sessionId", "durationMs", "flowers", "cleanup", "natives",
    "pipes", "closeCalls", "bestCombo", "bee", "eco",
  ];
  for (const key of required) {
    if (!(key in body)) return { ok: false, error: `Missing field: ${key}` };
  }

  if (!isSessionId(body.sessionId)) return { ok: false, error: "Invalid sessionId" };

  const stats = { sessionId: body.sessionId };

  for (const key of ["durationMs", "flowers", "cleanup", "natives", "pipes", "closeCalls", "bestCombo"]) {
    const v = Number(body[key]);
    if (!Number.isFinite(v)) return { ok: false, error: `Field must be a number: ${key}` };
    stats[key] = Math.round(v);
  }
  for (const key of ["bee", "eco"]) {
    const v = Number(body[key]);
    if (!Number.isFinite(v) || v < 0 || v > CAPS[`${key}Max`]) {
      return { ok: false, error: `Impossible value: ${key}` };
    }
    stats[key] = v;
  }

  if (stats.durationMs < CAPS.durationMinMs || stats.durationMs > CAPS.durationMaxMs) {
    return { ok: false, error: "Impossible round duration" };
  }
  if (stats.flowers < 0 || stats.flowers > CAPS.flowers) return { ok: false, error: "Impossible flowers count" };
  if (stats.cleanup < 0 || stats.cleanup > CAPS.cleanup) return { ok: false, error: "Impossible cleanup count" };
  if (stats.natives < 0 || stats.natives > CAPS.natives) return { ok: false, error: "Impossible natives count" };
  if (stats.pipes < 0 || stats.pipes > CAPS.pipes) return { ok: false, error: "Impossible pipes count" };
  if (stats.closeCalls < 0 || stats.closeCalls > stats.pipes) return { ok: false, error: "Impossible close calls" };
  if (stats.bestCombo < 0 || stats.bestCombo > CAPS.bestCombo) return { ok: false, error: "Impossible combo" };

  // Collectibles only spawn alongside pipes (62% chance), so the total is bounded.
  const totalCollects = stats.flowers + stats.cleanup + stats.natives;
  if (totalCollects > CAPS.flowers) return { ok: false, error: "Impossible collectible total" };

  return { ok: true, stats };
}

module.exports = { cleanName, isSessionId, validateStats, NAME_MAX };
