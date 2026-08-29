/*
 * Server-side score authority.
 *
 * The client never sends a final score — it sends raw gameplay statistics
 * and this module recomputes the score from the same base constants the
 * game uses in js/game.js:
 *
 *   flower collect  = 10   (game.js registerCollect)
 *   plastic cleanup = 20
 *   native plant    = 50
 *   pipe passed     = 5
 *   close call      = 25
 *   eco bonus       = round(eco * 2)   (main.js endGame)
 *
 * NOTE: the live game applies a combo multiplier (up to x5) to collect
 * points depending on the *order* of pickups vs hits. That history is not
 * sent to the server, so the ranked score uses the base values — fully
 * deterministic and impossible to inflate by combo farming.
 */

const CAPS = {
  durationMinMs: 5000,  // a round shorter than ~5s is not real gameplay
  durationMaxMs: 95000, // the round is capped at 90s in game.js
  flowers: 60,          // collectibles spawn with 62% chance per pipe; ~86 pipes max
  cleanup: 40,
  natives: 15,          // natives only spawn below 85 eco on a 10% roll
  pipes: 90,            // pipe interval >= 1.05s over a 90s round
  bestCombo: 60,
  beeMax: 100,
  ecoMax: 100,
};

/** UTC date key used for the daily leaderboard, e.g. "20260829". */
function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}

function computeScore({ flowers, cleanup, natives, pipes, closeCalls, eco }) {
  return (
    flowers * 10 +
    cleanup * 20 +
    natives * 50 +
    pipes * 5 +
    closeCalls * 25 +
    Math.round(eco * 2)
  );
}

module.exports = { CAPS, todayKey, computeScore };
