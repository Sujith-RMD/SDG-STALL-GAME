import { Ecosystem } from "./ecosystem.js";
import { VisionManager } from "./vision.js";
import { Game } from "./game.js";
import { els, toast, setStartStatus, startError, hideStart, showGameOver, updateHUD, updateTimer, renderBoard, drawPreview, toggleFullscreen, updateCombo } from "./ui.js";

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

renderBoard(store.entries, store.totals);
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
els.saveBtn.addEventListener("click", onSaveScore);
els.againBtn.addEventListener("click", () => {
  if (state === "over") startGame();
});
els.reset.addEventListener("click", () => {
  store.entries = [];
  store.totals = { games: 0, flowers: 0, sumEco: 0 };
  saveStore();
  renderBoard(store.entries, store.totals);
  toast("Champions board cleared 🧹");
});
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
  els.startBtn.disabled = true;
  setStartStatus("Requesting camera…");
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
    // restart while the player is typing their name.
    const typing = document.activeElement === els.name;
    const settled = performance.now() - overAt > 2500;
    if (!typing && (fromKey || settled)) startGame();
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
  showGameOver(pendingReport, tierTitle(pendingReport.eco), FACTS[Math.floor(Math.random() * FACTS.length)]);
}

function onSaveScore() {
  if (!pendingReport) return;
  const rawName = els.name.value.trim().slice(0, 14) || "Anonymous Bee";
  store.entries.push({ name: rawName, score: pendingReport.score });
  store.entries.sort((a, b) => b.score - a.score);
  store.entries = store.entries.slice(0, 50);
  store.totals.games += 1;
  store.totals.flowers += pendingReport.flowers;
  store.totals.sumEco += pendingReport.eco;
  saveStore();
  renderBoard(store.entries, store.totals);
  els.saveBtn.disabled = true;
  toast(`🏆 ${rawName} entered the Champions Board!`);
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
