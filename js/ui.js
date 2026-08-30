const $ = (id) => document.getElementById(id);

export const els = {
  video: $("cam-video"),
  canvas: $("game-canvas"),
  preview: $("cam-preview"),
  barBee: $("bar-bee"),
  valBee: $("val-bee"),
  barEco: $("bar-eco"),
  valEco: $("val-eco"),
  flowers: $("val-flowers"),
  startOverlay: $("start-overlay"),
  startBtn: $("start-btn"),
  error: $("error-msg"),
  status: $("vision-status"),
  gameover: $("gameover-overlay"),
  tier: $("tier-badge"),
  impFlowers: $("imp-flowers"),
  impClean: $("imp-clean"),
  impZones: $("imp-zones"),
  impNative: $("imp-native"),
  impBee: $("imp-bee"),
  impEco: $("imp-eco"),
  score: $("final-score"),
  fact: $("fact-text"),
  nameStart: $("player-name-start"),
  submitNote: $("submit-note"),
  againBtn: $("play-again"),
  retryBtn: $("retry-btn"),
  newGameBtn: $("new-game-btn"),
  overPlayer: $("over-player"),
  bestNote: $("best-note"),
  board: $("leaderboard"),
  aggPlayers: $("agg-players"),
  aggGames: $("agg-games"),
  aggFlowers: $("agg-flowers"),
  aggEco: $("agg-eco"),
  boardStatus: $("board-status"),
  toastEl: $("toast"),
  fsBtn: $("fs-btn"),
  muteBtn: $("mute-btn"),
  combo: $("combo"),
  impClose: $("imp-close"),
  impCombo: $("imp-combo"),
  timer: $("timer-pill"),
};

let toastTimer = null;

export function toast(msg) {
  els.toastEl.textContent = msg;
  els.toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toastEl.classList.remove("show"), 2400);
}

export function setStartStatus(text) {
  els.status.textContent = text;
}

export function startError(text) {
  els.error.textContent = text;
  els.startBtn.disabled = false;
  els.startBtn.textContent = "Try again";
}

export function hideStart() {
  els.startOverlay.classList.add("hidden");
}

export function showGameOver(r, tierTitle, fact) {
  els.tier.textContent = tierTitle;
  els.impFlowers.textContent = r.flowers;
  els.impClean.textContent = r.cleanup;
  els.impZones.textContent = r.pipes;
  els.impClose.textContent = r.closeCalls;
  els.impCombo.textContent = r.bestCombo ?? 0;
  els.impNative.textContent = r.natives;
  els.impBee.textContent = `${Math.round(r.bee)}%`;
  els.impEco.textContent = `${Math.round(r.eco)}%`;
  els.score.textContent = r.score;
  els.fact.textContent = fact;
  els.submitNote.textContent = "";
  els.gameover.classList.remove("hidden");
}

/* Step 4: "Best: N" / "🏆 NEW BEST!" line on the results screen. */
export function setBestNote(best, newBest) {
  if (best == null) {
    els.bestNote.textContent = "";
    els.bestNote.classList.remove("new-best");
    return;
  }
  els.bestNote.textContent = newBest ? "🏆 NEW BEST!" : `Best: ${best}`;
  els.bestNote.classList.toggle("new-best", !!newBest);
}

export function updateHUD(bee, eco, flowers) {
  els.barBee.style.width = `${bee}%`;
  els.valBee.textContent = `${Math.round(bee)}%`;
  els.barBee.style.background = bee >= 60 ? "#37d67a" : bee >= 30 ? "#ffb020" : "#ff6b6b";
  els.barEco.style.width = `${eco}%`;
  els.valEco.textContent = `${Math.round(eco)}%`;
  els.flowers.textContent = flowers;
}

const MEDALS = ["🥇", "🥈", "🥉"];

/*
 * Render the Champions Board. `entries` comes either from the global API
 * (name, score, flowers, eco, rank) or from the localStorage fallback
 * ({ name, score } — extra fields render as 0).
 * `agg` = { games, flowers, avgEco }.
 */
export function renderBoard(entries, agg) {
  const a = agg || {};
  els.board.innerHTML = "";
  if (!entries || entries.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No champions yet — be the first! 🐝";
    els.board.appendChild(li);
  } else {
    entries.slice(0, 10).forEach((en, i) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = MEDALS[i] || `${i + 1}.`;
      const name = document.createElement("span");
      name.textContent = en.name;
      const score = document.createElement("b");
      score.textContent = en.score;
      li.append(rank, name, score);
      els.board.appendChild(li);
    });
  }
  els.aggPlayers.textContent = a.players ?? 0; // unique players (one entry per playerToken)
  els.aggGames.textContent = a.games ?? 0; // finished runs (retries included)
  els.aggFlowers.textContent = a.flowers ?? 0;
  els.aggEco.textContent = `${a.avgEco ?? 0}%`;
}

/* Persistent status line under the board (global-online / fallback notice). */
export function setBoardStatus(text) {
  els.boardStatus.textContent = text || "";
}

export function updateCombo(combo, mult) {
  const el = els.combo;
  if (combo >= 3) {
    el.classList.remove("hidden");
    el.textContent = `COMBO x${mult} · ${combo} 🔥`;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
  } else {
    el.classList.add("hidden");
  }
}

export function updateTimer(secondsLeft) {
  const s = Math.max(0, Math.ceil(secondsLeft));
  els.timer.textContent = `⏱ ${s}s`;
  els.timer.classList.toggle("low", secondsLeft > 0 && s <= 10);
}

export function drawPreview(ctx, video, vision) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  if (video.readyState >= 2) ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();
  ctx.fillStyle = "#00000066";
  ctx.fillRect(0, 0, w, h);

  if (vision.aiError) {
    ctx.fillStyle = "#ff6b6b";
    ctx.font = "700 13px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("AI glitch — restarting…", w / 2, h / 2);
    return;
  }

  if (!vision.landmarks) {
    ctx.fillStyle = "#ffffffaa";
    ctx.font = "13px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("show your hand 🖐️", w / 2, h - 12);
    return;
  }

  for (let i = 0; i < vision.landmarks.length; i++) {
    const x = w - vision.landmarks[i].x * w;
    const y = vision.landmarks[i].y * h;
    ctx.fillStyle = i === 4 || i === 8 ? "#37d67a" : "#ffffffcc";
    ctx.beginPath();
    ctx.arc(x, y, i === 4 || i === 8 ? 4 : 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = vision.landmarks[4];
  const idx = vision.landmarks[8];
  ctx.strokeStyle = "#37d67a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w - t.x * w, t.y * h);
  ctx.lineTo(w - idx.x * w, idx.y * h);
  ctx.stroke();

  const hi = Math.max(vision.restLvl ?? 1, (vision.thDown ?? 0.5) + 0.25);
  const g = vision.gap ?? hi;
  const pct = Math.max(0, Math.min(1, g / hi));
  const bx = 10;
  const by = h - 26;
  const bw = w - 20;
  const bh = 10;
  ctx.fillStyle = "#ffffff22";
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = g < (vision.thDown ?? 0.5) ? "#37d67a" : "#ffcf40";
  ctx.fillRect(bx, by, bw * pct, bh);
  const tickX = bx + bw * Math.max(0, Math.min(1, (vision.thDown ?? 0.5) / hi));
  ctx.fillStyle = "#ff5f5f";
  ctx.fillRect(tickX - 1, by - 4, 3, bh + 8);

  ctx.font = "700 13px Outfit, sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = performance.now() - vision.firedFlash < 180 ? "#37d67a" : "#ffffffcc";
  ctx.fillText(performance.now() - vision.firedFlash < 180 ? "FLAP! 🔥" : `gap ${g.toFixed(2)}`, 10, 18);
}

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    /* unsupported */
  }
}
