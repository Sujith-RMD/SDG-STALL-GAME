import { Ecosystem } from "./ecosystem.js";
import { VisionManager } from "./vision.js";
import { Game } from "./game.js";
import { els, toast, setStartStatus, startError, hideStart, showGameOver, updateHUD, updateTimer, renderBoard, drawPreview, toggleFullscreen, updateCombo, setBoardStatus, setBestNote } from "./ui.js";

const STORAGE_KEY = "pollinator-panic-v1";
window.__boothBooted = false;

window.addEventListener("error", (ev) => {
  const box = document.getElementById("error-msg");
  if (box) box.textContent = `Error: ${ev.message || "unknown"} — hard-refresh (Ctrl+F5)`;
});
const FACTS = [
  "Pollinators support about 75% of the world's food crops — losing them means losing food. (SDG 2)",
  "A single bee colony can pollinate 300 million flowers in one day.",
  "SDG 15 calls on us to protect and restore land ecosystems — exactly what you just did in miniature.",
  "Without pollinators we would lose coffee, chocolate, mangoes, apples and almonds.",
  "Nearly 40% of invertebrate pollinator species face extinction. Every garden patch helps.",
];

let state = "boot";
let handLostShown = false;
let pendingReport = null;
let lastTickSec = -1;
let prevGrace = 10;
let lastCombo = -1;
let lastMult = -1;
let overAt = 0; // when the results screen appeared — gates pinch-to-restart

// Global leaderboard state. backendUp: null = unknown, true/false once the
// API has answered (or failed) at least once. All API failures degrade to
// the localStorage fallback below — the game never crashes on them.
let playerName = "";
let sessionId = null;
let backendUp = null;

/* ---------- Step 4: retry identity ----------
 * playerToken: server-issued identity grouping one student's retry attempts
 * into a single personal-best leaderboard entry. Stored in sessionStorage —
 * per-tab, so closing/refreshing the tab safely defaults to "a new student"
 * (no false merges; worst case a duplicate entry, same as pre-Step-4).
 * The remembered NAME is convenience-only (prefills the start input) and is
 * never treated as identity.
 */
const TOKEN_KEY = "pp_player_token";
const NAME_KEY = "pp_player_name";
let playerToken = null;
try { playerToken = sessionStorage.getItem(TOKEN_KEY) || null; } catch {}
try {
  const savedName = localStorage.getItem(NAME_KEY);
  if (savedName) {
    playerName = savedName;
    els.nameStart.value = savedName;
  }
} catch {}
function rememberName() {
  try { localStorage.setItem(NAME_KEY, playerName); } catch {}
}
function forgetIdentity() {
  playerToken = null;
  playerName = "";
  sessionId = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  try { localStorage.removeItem(NAME_KEY); } catch {}
  els.nameStart.value = "";
}

const eco = new Ecosystem();
const game = new Game(els.canvas, eco);
const vision = new VisionManager();
const previewCtx = els.preview.getContext("2d");

const store = loadStore();

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return {
        entries: Array.isArray(d.entries) ? d.entries : [],
        totals: { games: 0, flowers: 0, sumEco: 0, ...(d.totals || {}) },
      };
    }
  } catch {}
  return { entries: [], totals: { games: 0, flowers: 0, sumEco: 0 } };
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {}
}

// Global board first: show a neutral loading state and fetch immediately.
// localStorage is ONLY a fallback for when the global API genuinely fails —
// never the initial render.
setBoardStatus("Loading global leaderboard…");
loadBoard();
setInterval(loadBoard, 30000); // keep the board fresh while players watch
game.startDemo(); // attract loop runs behind the start overlay

function waitFor(pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (performance.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error("timeout"));
      }
    }, 80);
  });
}

els.startBtn.addEventListener("click", onStart);
els.retryBtn.addEventListener("click", () => { if (state === "over") retryGame(); });
els.newGameBtn.addEventListener("click", () => { if (state === "over") newGame(); });
els.fsBtn.addEventListener("click", toggleFullscreen);

els.muteBtn.textContent = game.music.muted ? "🔇" : "🔊";
els.muteBtn.addEventListener("click", () => {
  const muted = game.music.toggle();
  els.muteBtn.textContent = muted ? "🔇" : "🔊";
  toast(muted ? "Sound off" : "Sound on 🔊");
});

window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  // Don't hijack Space while the player is typing their name on the board.
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  e.preventDefault();
  handleAction(true);
});

// Tap / click anywhere on the game as a backup flap (mobile + mouse-friendly).
els.canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  handleAction(true);
});

async function onStart() {
  const raw = typeof els.nameStart.value === "string" ? els.nameStart.value : "";
  const name = raw.trim().slice(0, 14);
  if (!name) {
    els.error.textContent = "Enter your name first — it goes on the Champions Board 🐝";
    return;
  }
  playerName = name;
  rememberName(); // convenience-only prefill for future sessions on this device
  els.error.textContent = "";
  els.startBtn.disabled = true;
  setStartStatus("Connecting to the global board…");
  sessionId = null;
  if (await mintSession()) {
    setStartStatus("Connected to the global board ✅");
  } else {
    setStartStatus("Global board offline — scores will stay on this device");
  }
  game.demo = false;
  game.entities = [];
  game.particles = [];
  try {
    await vision.init(els.video);
  } catch (err) {
    console.error(err);
    const name = err?.name || "";
    if (name === "NotAllowedError") startError("Camera permission blocked. Allow it in the browser, then try again.");
    else if (name === "NotFoundError") startError("No camera found on this device.");
    else startError("Could not start (internet needed for first AI download). Try again.");
    return;
  }

  state = "calib";
  let attempt = 0;
  while (attempt <= 1) {
    try {
      setStartStatus("Show your open hand to the camera 👋");
      await waitFor(() => vision.landmarks != null, 20000);
      setStartStatus("Open WIDE, then pinch fully shut — repeat till time's up ✊👉");
      vision.startCalibration(3200);
      await waitFor(() => vision.calibrationState?.done === true, 15000);
      const st = vision.calibrationState;
      if (st.quality === "low" && attempt < 1) {
        setStartStatus("Barely saw movement — one more time, big motions!");
        await new Promise((r) => setTimeout(r, 1000));
        attempt += 1;
        continue;
      }
      break;
    } catch {
      startError("Couldn't see your hand clearly. Check lighting, then try again.");
      return;
    }
  }

  setStartStatus("Calibrated! ✅ Pinch your fingers to launch");
  state = "ready";
}

function handleAction(fromKey = false) {
  if (state === "ready") startGame();
  else if (state === "playing") {
    // The game pauses while the hand is out of frame; don't let flaps queued
    // during the pause fling the bee upward the moment it resumes.
    if (!vision.lostFor(1600)) game.flap();
  } else if (state === "over") {
    // Hands-only restart for the next challenger: ignore pinches for a short
    // grace period so the death flap can't skip the results, and never
    // restart while the player is typing in any input.
    const el = document.activeElement;
    const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    const settled = performance.now() - overAt > 2500;
    if (!typing && (fromKey || settled)) retryGame();
  }
}

vision.onPinch = () => handleAction(false);

function startGame() {
  state = "playing";
  handLostShown = false;
  lastTickSec = -1;
  prevGrace = 10;
  hideStart();
  els.gameover.classList.add("hidden");
  game.reset();
  game.music.start();
  updateTimer(90);
  toast("🛡️ Safe ground for the first 10s!");
}

function tierTitle(ecoVal) {
  if (ecoVal >= 80) return "🌍 Ecosystem Champion";
  if (ecoVal >= 60) return "🌱 Restoration Hero";
  if (ecoVal >= 40) return "🌿 Green Apprentice";
  return "🥀 Seedling — the land needs you again!";
}

function endGame() {
  state = "over";
  overAt = performance.now();
  game.music.stop();
  toast(game.timeUp ? "⏱ Time's up — next challenger!" : "💀 The bee has fallen…");
  pendingReport = {
    ...game.stats,
    bee: game.beeHealth,
    eco: eco.value,
    bestCombo: game.bestCombo,
    score: game.liveScore + Math.round(eco.value * 2),
  };
  els.overPlayer.textContent = playerName || "Anonymous Bee";
  setBestNote(null, false); // filled in when the submission answers
  showGameOver(pendingReport, tierTitle(pendingReport.eco), FACTS[Math.floor(Math.random() * FACTS.length)]);

  // Auto-submit: no save button. Global when available, local otherwise.
  if (sessionId) {
    // The server is the score authority (its ranked score excludes the live
    // combo multiplier), so show a placeholder instead of the combo-inflated
    // client estimate until the official score arrives.
    els.score.textContent = "…";
    els.submitNote.textContent = "🌍 Submitting to the global board…";
    submitScore(pendingReport);
  } else {
    saveLocalFallback(pendingReport);
  }
}

/* ---------- Step 4: RETRY (same player, new session) / NEW GAME ---------- */

let retrying = false;

async function retryGame() {
  if (state !== "over" || retrying) return;
  retrying = true;
  els.retryBtn.disabled = true;
  els.submitNote.textContent = "🌍 Starting your next run…";
  // A NEW session for the new attempt — one-submission-per-session still
  // holds; the SAME playerToken keeps the leaderboard entry unified as the
  // player's personal best.
  await mintSession();
  els.retryBtn.disabled = false;
  retrying = false;
  startGame(); // camera stream + calibration persist — instant restart
}

function newGame() {
  if (state !== "over" || retrying) return;
  forgetIdentity(); // clears token + name: the next student is a brand-new player
  if (vision.stream) {
    vision.stream.getTracks().forEach((t) => t.stop());
    vision.stream = null;
  }
  els.video.srcObject = null; // camera off while waiting for the next student
  els.gameover.classList.add("hidden");
  els.startOverlay.classList.remove("hidden");
  els.startBtn.disabled = false;
  els.error.textContent = "";
  setStartStatus("Camera is off · enter your name to play");
  state = "boot"; // back to the pre-start state; onStart() runs the full flow
  game.demo = true;
  game.startDemo();
  updateTimer(90);
}

/* ---------- Global leaderboard (with localStorage fallback) ---------- */

function localAgg() {
  const t = store.totals;
  return {
    games: t.games,
    flowers: t.flowers,
    avgEco: t.games ? Math.round(t.sumEco / t.games) : 0,
    // Offline there is no server identity — the closest honest "players"
    // count is distinct names on this device's local board.
    players: new Set(store.entries.map((e) => e.name)).size,
  };
}

async function apiFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(path, { ...options, signal: controller.signal });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function mintSession() {
  try {
    const r = await apiFetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // RETRY presents the existing playerToken (same player, NEW session);
      // without one the server mints a fresh identity (NEW GAME / first visit).
      body: JSON.stringify(playerToken ? { name: playerName, playerToken } : { name: playerName }),
    });
    if (r.ok && r.data && r.data.sessionId) {
      sessionId = r.data.sessionId;
      if (r.data.playerToken) {
        playerToken = r.data.playerToken;
        try { sessionStorage.setItem(TOKEN_KEY, playerToken); } catch {}
      }
      backendUp = true;
      return true;
    }
  } catch {}
  sessionId = null;
  backendUp = false;
  return false;
}

async function submitScore(report) {
  const payload = {
    sessionId,
    durationMs: Math.round((game.elapsed || 0) * 1000),
    flowers: report.flowers ?? 0,
    cleanup: report.cleanup ?? 0,
    natives: report.natives ?? 0,
    pipes: report.pipes ?? 0,
    closeCalls: report.closeCalls ?? 0,
    bestCombo: report.bestCombo ?? 0,
    bee: report.bee ?? 0,
    eco: report.eco ?? 0,
  };
  if (playerToken) payload.playerToken = playerToken; // same-player identity for personal-best tracking
  try {
    let r = await apiFetch("/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Session expired mid-game — mint a fresh one and retry exactly once.
    if (r.status === 404 && (await mintSession())) {
      payload.sessionId = sessionId;
      r = await apiFetch("/api/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    if (r.ok && typeof r.data.score === "number") {
      backendUp = true;
      pendingReport.score = r.data.score; // server is the score authority
      els.score.textContent = r.data.score;
      const rank = r.data.rank ? ` · rank #${r.data.rank} today` : "";
      els.submitNote.textContent = `🌍 Submitted to the global board — ${r.data.score} pts${rank}`;
      toast(`🌍 Global score: ${r.data.score}${rank}`);
      setBestNote(r.data.best ?? null, !!r.data.newBest);
      // Cache-bypassing refresh so the just-submitted entry shows immediately
      // instead of the up-to-15s-stale edge-cached board.
      loadBoard({ fresh: true });
      return;
    }
    if (r.status === 409) {
      els.submitNote.textContent = "🌍 This run was already submitted.";
      els.score.textContent = report.score; // nothing better exists for this run — show the local estimate
      return;
    }
    throw new Error(`score submit failed (${r.status})`);
  } catch {
    saveLocalFallback(report);
  }
}

function saveLocalFallback(report) {
  backendUp = false;
  // Offline personal best: best score among this device's same-name entries.
  const prevBest = store.entries
    .filter((e) => e.name === (playerName || "Anonymous Bee"))
    .reduce((m, e) => Math.max(m, e.score), 0) || null;
  const newBest = prevBest == null || report.score > prevBest;
  setBestNote(newBest ? report.score : prevBest, newBest);
  els.score.textContent = report.score; // offline: the local score is the only score
  store.entries.push({ name: playerName || "Anonymous Bee", score: report.score });
  store.entries.sort((a, b) => b.score - a.score);
  store.entries = store.entries.slice(0, 50);
  store.totals.games += 1;
  store.totals.flowers += report.flowers ?? 0;
  store.totals.sumEco += report.eco ?? 0;
  saveStore();
  setBoardStatus("Global leaderboard unreachable — showing this device's local scores.");
  els.submitNote.textContent = "📴 Saved to the local board (global board unreachable).";
  renderBoard(store.entries, localAgg());
}

let boardRequestId = 0;

async function loadBoard({ fresh = false } = {}) {
  // Ordering guard: only the most recently STARTED board load may render.
  // Without this, a slow 30s poll (or a failed poll falling back to
  // localStorage) resolving after the post-submission refresh could
  // overwrite the fresh board with stale data.
  const requestId = ++boardRequestId;
  try {
    /*
     * A fresh refresh (right after a successful submission) must not read
     * the 15s edge cache — it would serve the board from BEFORE the
     * submission. A unique query string makes the URL unique, so the CDN
     * treats it as a cache miss and serves a live response. Regular
     * polling keeps using the cached URL, preserving normal caching.
     */
    const url = fresh ? `/api/leaderboard?_=${Date.now()}` : "/api/leaderboard";
    const r = await apiFetch(url);
    if (!r.ok) throw new Error("leaderboard fetch failed");
    backendUp = true;
    if (requestId !== boardRequestId) return; // superseded by a newer load
    setBoardStatus("🌍 Live global board — shared across every device.");
    renderBoard(r.data.entries || [], r.data.aggregates || { games: 0, flowers: 0, avgEco: 0 });
  } catch {
    if (requestId !== boardRequestId) return; // superseded by a newer load
    if (backendUp === true) return; // global board already loaded — never overwrite it with stale local data
    // Genuine failure before the global board ever loaded: local fallback.
    setBoardStatus(
      store.entries.length > 0
        ? "Global leaderboard unreachable — showing this device's local scores."
        : "Global leaderboard unreachable — no local scores on this device yet."
    );
    renderBoard(store.entries, localAgg());
  }
}

// Only touch the combo DOM when it actually changes — updateCombo() forces a
// layout reflow and replays the pop animation, so calling it every frame hangs.
function syncCombo(combo, mult) {
  if (combo === lastCombo && mult === lastMult) return;
  lastCombo = combo;
  lastMult = mult;
  updateCombo(combo, mult);
}

let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.033, (now - lastT) / 1000);
  lastT = now;

  vision.detect();

  if (state === "playing") {
    const lost = vision.lostFor(1600);
    if (lost && !handLostShown) {
      handLostShown = true;
      toast("🖐️ Hand lost — bring it back into frame!");
    }
    if (!lost && handLostShown) {
      handLostShown = false;
      toast("Back online ✅");
    }
    if (!lost) {
      const result = game.update(dt);
      if (result === "dead") endGame();
    }
    updateHUD(game.beeHealth, eco.value, game.stats.flowers);
    updateTimer(game.timeLeft);
    syncCombo(game.combo, game.comboMult);
    if (prevGrace > 0 && game.graceT <= 0) toast("☠️ Ground is deadly now!");
    prevGrace = game.graceT;
    const whole = Math.ceil(game.timeLeft);
    if (whole !== lastTickSec) {
      lastTickSec = whole;
      if (whole <= 5 && whole > 0) game.sfx.tick();
    }
  } else if (state === "boot") {
    game.updateDemo(dt);
    updateHUD(100, eco.value, 0);
    syncCombo(0, 1);
  } else {
    game.idle(dt);
    syncCombo(0, 1);
    if (state !== "over") updateHUD(100, eco.value, 0);
  }

  game.render();
  drawPreview(previewCtx, els.video, vision);

  requestAnimationFrame(loop);
  window.__boothBooted = true;
}
requestAnimationFrame(loop);
