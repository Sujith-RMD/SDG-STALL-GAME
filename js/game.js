import { lerpHex } from "./ecosystem.js";

const W = 1280;
const H = 720;
const GROUND_H = 74;

const spriteCache = new Map();

function glyphSprite(glyph, px) {
  const key = glyph + "_" + px;
  if (!spriteCache.has(key)) {
    const pad = Math.ceil(px * 0.4);
    const c = document.createElement("canvas");
    c.width = px + pad * 2;
    c.height = px + pad * 2;
    const x = c.getContext("2d");
    x.font = `${px}px serif`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,15,0,0.55)";
    x.shadowBlur = 12;
    x.fillText(glyph, c.width / 2, c.height / 2);
    spriteCache.set(key, c);
  }
  return spriteCache.get(key);
}

function beeSprite() {
  if (!spriteCache.has("bee")) {
    const S = 150;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const x = c.getContext("2d");
    x.translate(S / 2, S / 2);
    x.shadowColor = "rgba(255,190,20,0.75)";
    x.shadowBlur = 20;
    x.fillStyle = "#ffc61a";
    x.beginPath();
    x.ellipse(0, 0, 34, 25, 0, 0, Math.PI * 2);
    x.fill();
    x.shadowBlur = 0;
    x.save();
    x.beginPath();
    x.ellipse(0, 0, 34, 25, 0, 0, Math.PI * 2);
    x.clip();
    x.fillStyle = "#241a08";
    x.fillRect(6, -30, 11, 60);
    x.fillRect(-13, -30, 11, 60);
    x.fillRect(-32, -30, 9, 60);
    x.restore();
    x.strokeStyle = "#241a08";
    x.lineWidth = 4;
    x.beginPath();
    x.ellipse(0, 0, 34, 25, 0, 0, Math.PI * 2);
    x.stroke();
    x.fillStyle = "#241a08";
    x.beginPath();
    x.moveTo(-33, -5);
    x.lineTo(-48, 0);
    x.lineTo(-33, 5);
    x.closePath();
    x.fill();
    x.beginPath();
    x.arc(31, -3, 12.5, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#ffffff";
    x.beginPath();
    x.arc(34, -7, 4.2, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#141010";
    x.beginPath();
    x.arc(35.4, -7, 2.2, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = "#241a08";
    x.lineWidth = 3.5;
    x.beginPath();
    x.moveTo(-28, -10);
    x.quadraticCurveTo(-41, -27, -50, -23);
    x.moveTo(35, -15);
    x.quadraticCurveTo(44, -31, 54, -26);
    x.stroke();
    spriteCache.set("bee", c);
  }
  return spriteCache.get("bee");
}

const MELODY = [523.25, 0, 659.25, 783.99, 880, 0, 783.99, 659.25, 523.25, 0, 587.33, 659.25, 783.99, 659.25, 587.33, 0];
const BASS = [130.81, 0, 196, 0, 220, 0, 174.61, 0];
// Extra layers that fade in as the ecosystem heals (see MusicBox.schedule)
const PAD = [261.63, 329.63, 392.0, 329.63]; // C E G — warm major-triad pad
const ARP = [1046.5, 1318.51, 1567.98, 1318.51]; // C6 E6 G6 — high sparkle

// One AudioContext shared by SFX and music — browsers cap contexts per page,
// and a single clock keeps effects and the music grid in sync.
let sharedCtx = null;
function audioCtx() {
  if (!sharedCtx) {
    try {
      sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      sharedCtx = null;
    }
  }
  if (sharedCtx && sharedCtx.state === "suspended") sharedCtx.resume();
  return sharedCtx;
}

class Sfx {
  constructor() {
    this.music = null;
  }

  tone(f, dur, type = "sine", gain = 0.07, slide = 0) {
    if (this.music && this.music.muted) return;
    const ctx = audioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  flap() { this.tone(320, 0.09, "sine", 0.05, -140); }
  pass() { this.tone(700, 0.07, "triangle", 0.05); }
  collect() { this.tone(880, 0.12, "triangle", 0.09); }
  clean() { this.tone(520, 0.15, "square", 0.05, 150); }
  hurt() { this.tone(140, 0.25, "sawtooth", 0.12, -60); }
  closeCall() {
    this.tone(980, 0.14, "triangle", 0.07);
    setTimeout(() => this.tone(1320, 0.16, "triangle", 0.06), 90);
  }
  tick() { this.tone(1250, 0.06, "square", 0.05); }
  combo() {
    this.tone(760, 0.08, "triangle", 0.055);
    setTimeout(() => this.tone(1140, 0.09, "triangle", 0.05), 70);
  }
  restore() {
    this.tone(660, 0.28, "sine", 0.07);
    setTimeout(() => this.tone(990, 0.3, "sine", 0.06), 90);
  }
  die() { this.tone(220, 0.6, "sawtooth", 0.09, -170); }
}

class MusicBox {
  constructor() {
    this.timer = null;
    this.step = 0;
    this.nextTime = 0;
    this.muted = localStorage.getItem("pp_mute") === "1";
    this.level = 0; // 0..3, follows ecosystem tier; more layers as the land heals
  }

  start() {
    const ctx = audioCtx();
    if (!ctx || this.timer) return;
    this.nextTime = ctx.currentTime + 0.15;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), 90);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  toggle() {
    this.muted = !this.muted;
    localStorage.setItem("pp_mute", this.muted ? "1" : "0");
    return this.muted;
  }

  note(f, t, dur, type, gain) {
    const ctx = sharedCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  schedule() {
    const ctx = sharedCtx;
    if (!ctx) return;
    const STEP = 0.32;
    // Timers get throttled when the tab hides or the booth laptop dozes off.
    // Jump to "now" instead of dumping a burst of overdue notes at once.
    if (this.nextTime < ctx.currentTime - 0.25) this.nextTime = ctx.currentTime + 0.15;
    while (this.nextTime < ctx.currentTime + 0.35) {
      if (!this.muted) {
        const i = this.step % 16;
        const lvl = this.level; // 0..3 — rises as the ecosystem recovers
        const t = this.nextTime;

        // Bass — the heartbeat, always present
        const b = BASS[i % 8];
        if (b) this.note(b, t, STEP * 1.8, "sine", 0.05);

        // Melody — fades in and brightens as the land comes back
        const m = MELODY[i];
        if (m) this.note(m, t, STEP * 0.92, "triangle", 0.03 + lvl * 0.006);

        // Warm pad chord on the downbeats once life returns (tier 1+)
        if (lvl >= 1 && i % 4 === 0) {
          this.note(PAD[(this.step >> 2) % PAD.length], t, STEP * 3.6, "sine", 0.03);
        }
        // A fifth above the melody adds fullness (tier 2+)
        if (lvl >= 2 && m) this.note(m * 1.5, t, STEP * 0.6, "triangle", 0.018);
        // High sparkle arpeggio when the ecosystem is thriving (tier 3)
        if (lvl >= 3 && i % 2 === 0) {
          this.note(ARP[(this.step >> 1) % ARP.length], t, STEP * 0.45, "triangle", 0.02);
        }
      }
      this.step += 1;
      this.nextTime += STEP;
    }
  }
}

export class Game {
  constructor(canvas, eco) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.eco = eco;
    this.music = new MusicBox();
    this.sfx = new Sfx();
    this.sfx.music = this.music;
    this.t = 0;
    this.reset();
  }

  reset() {
    this.bee = { x: 250, y: 84, vy: -240, r: 22 };
    this.eco.reset();
    this.beeHealth = 100;
    this.entities = [];
    this.particles = [];
    this.ambient = [];
    this.stats = { flowers: 0, cleanup: 0, natives: 0, pipes: 0, closeCalls: 0 };
    this.elapsed = 0;
    this.timeLeft = 90;
    this.timeUp = false;
    this.graceT = 10;
    this.scroll = 0;
    this.pipeT = 1.4;
    this.invulnT = 0;
    this.flashRed = 0;
    this.shake = 0;
    this.alive = true;
    this.liveScore = 0;
    this.texts = [];
    this.combo = 0;
    this.comboMult = 1;
    this.bestCombo = 0;
    this.demo = false;
  }

  idle(dt) {
    this.scroll += 42 * dt;
    this.t += dt;
    this.updateAmbient(dt, true);
  }

  // Attract mode: a self-flying "ghost" bee that keeps the booth screen alive
  // behind the start overlay. No health, no stats — purely to draw a crowd.
  startDemo() {
    this.reset();
    this.demo = true;
    this.eco.reset();
    this.eco.add(52); // start mid-recovery so the world already looks inviting
    this.bee.x = 250;
    this.bee.y = H / 2;
    this.bee.vy = 0;
    this.pipeT = 0.6;
  }

  updateDemo(dt) {
    this.t += dt;
    this.pipeT -= dt;
    const eff = 250;
    this.scroll += eff * dt;
    this.music.level = this.eco.tier;

    const b = this.bee;

    // Autopilot: aim at the gap of the next pipe ahead, hover with gentle flaps.
    let targetY = H / 2;
    for (const en of this.entities) {
      if (en.type === "pipe" && en.x + en.w > b.x - 4) { targetY = en.gapY; break; }
    }
    b.vy = Math.min(b.vy + 1650 * dt, 900);
    if (b.y > targetY && b.vy > -160) b.vy = -430;
    b.y += b.vy * dt;
    if (b.y < b.r) { b.y = b.r; b.vy = 0; }
    const floorY = H - GROUND_H - b.r;
    if (b.y > floorY) { b.y = floorY; b.vy = -430; }

    if (this.pipeT <= 0) {
      this.spawnPipe();
      this.pipeT = 1.7 + Math.random() * 0.3;
    }

    for (let i = this.entities.length - 1; i >= 0; i--) {
      const en = this.entities[i];
      en.x -= eff * dt;
      if (en.x < -(en.w || 120) - 80) { this.entities.splice(i, 1); continue; }
      if (en.type === "pipe") continue;
      const rr = en.r + b.r;
      if ((b.x - en.x) ** 2 + (b.y - en.y) ** 2 < rr * rr) {
        this.entities.splice(i, 1);
        this.eco.add(en.type === "native" ? 8 : en.type === "plastic" ? 3 : 2);
        this.burst(en.x, en.y, en.type === "flower" ? "🌸" : en.type === "plastic" ? "💨" : "✨", 5);
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += (p.g || 0) * dt;
    }

    // Let it breathe: ease back down when fully healed so the scene keeps evolving.
    if (this.eco.value > 90) this.eco.add(-3 * dt);
    this.updateAmbient(dt, false);
  }

  flap() {
    if (!this.alive) return;
    this.bee.vy = -540;
    this.sfx.flap();
  }

  update(dt) {
    if (!this.alive) return "dead";
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.timeUp = true;
      this.alive = false;
      return "dead";
    }
    this.elapsed += dt;
    this.pipeT -= dt;
    this.graceT = Math.max(0, this.graceT - dt);

    const base = Math.min(520, 260 + this.elapsed * 7.5);
    const eff = base;
    this.scroll += eff * dt;
    this.t += dt;
    this.music.level = this.eco.tier;

    this.invulnT = Math.max(0, this.invulnT - dt);
    this.flashRed = Math.max(0, this.flashRed - dt * 2);
    this.shake = Math.max(0, this.shake - dt);

    const b = this.bee;
    b.vy = Math.min(b.vy + 1650 * dt, 900);
    b.y += b.vy * dt;
    if (b.y < b.r) {
      b.y = b.r;
      b.vy = Math.max(b.vy, 0);
    }
    const floorY = H - GROUND_H - b.r;
    if (b.y >= floorY) {
      if (this.graceT > 0) {
        b.y = floorY;
        b.vy = -340;
        this.burst(b.x, H - GROUND_H - 6, "💨", 5);
      } else {
        this.alive = false;
        this.timeUp = false;
        this.burst(b.x, floorY + b.r * 0.6, "💥", 14, true);
        this.sfx.die();
        return "dead";
      }
    }

    if (this.pipeT <= 0) {
      this.spawnPipe();
      this.pipeT = Math.max(1.05, 1.65 - this.elapsed * 0.014) + Math.random() * 0.25;
    }

    for (let i = this.entities.length - 1; i >= 0; i--) {
      const en = this.entities[i];
      en.x -= eff * dt;
      if (en.x < -(en.w || 120) - 80) {
        this.entities.splice(i, 1);
        continue;
      }
      if (en.dead) continue;

      if (en.type === "pipe") {
        const half = en.gapH / 2;
        const topEdge = en.gapY - half;
        const botEdge = en.gapY + half;
        if (b.x > en.x - b.r && b.x < en.x + en.w + b.r) {
          const clear = Math.min(b.y - topEdge, botEdge - b.y);
          if (clear < (en.minClear ?? 999)) en.minClear = clear;
        }
        if (!en.passed && en.x + en.w < b.x - b.r) {
          en.passed = true;
          if (!en.hitPlayer) {
            this.stats.pipes += 1;
            this.liveScore += 5;
            if (en.minClear != null && en.minClear < 50) {
              this.stats.closeCalls += 1;
              this.liveScore += 25;
              this.addText("CLOSE CALL! +25", b.x, b.y - 70, "#ffd166", 27);
              this.shake = Math.max(this.shake, 0.25);
              this.sfx.closeCall();
            }
            this.sfx.pass();
          }
        }
        if (this.invulnT <= 0 && this.pipeHit(b, en)) {
          en.hitPlayer = true;
          this.beeHealth -= 28;
          this.invulnT = 1.2;
          this.flashRed = 0.6;
          this.shake = 0.45;
          this.eco.add(-2);
          if (this.combo >= 3) this.addText("COMBO LOST", b.x, b.y - 62, "#ff8a8a", 22);
          this.combo = 0;
          this.comboMult = 1;
          this.burst(b.x, b.y, "💥", 10);
          this.sfx.hurt();
        }
        continue;
      }

      const rr = en.r + b.r;
      if ((b.x - en.x) ** 2 + (b.y - en.y) ** 2 < rr * rr) {
        en.dead = true;
        this.entities.splice(i, 1);
        this.registerCollect(en);
      }
    }

    this.beeHealth = Math.max(0, Math.min(100, this.beeHealth));
    if (this.beeHealth <= 0) {
      this.alive = false;
      this.burst(this.bee.x, this.bee.y, "💔", 14, true);
      this.sfx.die();
      return "dead";
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += (p.g || 0) * dt;
    }

    for (let i = this.texts.length - 1; i >= 0; i--) {
      const tx = this.texts[i];
      tx.life -= dt * 1.1;
      if (tx.life <= 0) {
        this.texts.splice(i, 1);
        continue;
      }
      tx.y += tx.vy * dt;
    }

    this.updateAmbient(dt, false);
    return "ok";
  }

  registerCollect(en) {
    let pts = 10;
    if (en.type === "flower") {
      this.stats.flowers += 1;
      this.eco.add(2);
      this.burst(en.x, en.y, "🌸", 6);
      this.sfx.collect();
    } else if (en.type === "plastic") {
      pts = 20;
      this.stats.cleanup += 1;
      this.eco.add(3);
      this.burst(en.x, en.y, "💨", 6);
      this.sfx.clean();
    } else {
      pts = 50;
      this.stats.natives += 1;
      this.eco.add(12);
      this.beeHealth = Math.min(100, this.beeHealth + 12);
      this.burst(en.x, en.y, "✨", 14, true);
      this.sfx.restore();
    }

    // Combo: every catch without taking a hit extends the chain and its multiplier.
    this.combo += 1;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.comboMult = Math.min(5, 1 + Math.floor(this.combo / 3));
    const gained = pts * this.comboMult;
    this.liveScore += gained;

    const hot = this.comboMult > 1;
    this.addText(hot ? `+${gained}  x${this.comboMult}` : `+${gained}`, en.x, en.y - 26, hot ? "#ffcf40" : "#bff0a0", hot ? 25 : 20);
    if (hot && this.combo % 3 === 0) this.sfx.combo();
  }

  addText(text, x, y, color, size) {
    this.texts.push({ text, x, y, vy: -55, life: 1, max: 1, color, size });
  }

  spawnPipe() {
    const shrink = Math.min(90, this.elapsed * 3.0);
    const gapH = 230 - shrink;
    const minY = 150;
    const maxY = H - GROUND_H - 150;
    const gapY = minY + Math.random() * (maxY - minY);
    this.entities.push({ type: "pipe", x: W + 40, w: 88, gapY, gapH, passed: false });

    if (Math.random() < 0.62) {
      const roll = Math.random();
      let type = "flower";
      if (roll > 0.9 && this.eco.value < 85) type = "native";
      else if (roll > 0.72) type = "plastic";
      const cfg = {
        flower: { r: 24, glyph: "🌸" },
        plastic: { r: 27, glyph: "🗑️" },
        native: { r: 32, glyph: "🌳" },
      }[type];
      const half = gapH / 2;
      let y;
      if (type === "plastic") {
        // Risky: plastic clings to a pipe edge, so grabbing it means skimming the wall.
        const side = Math.random() < 0.5 ? -1 : 1;
        y = gapY + side * Math.max(0, half - 28);
      } else {
        y = gapY + (Math.random() * 2 - 1) * (half - 50);
      }
      this.entities.push({ type, x: W + 84, y, r: cfg.r, glyph: cfg.glyph });
    }
  }

  rectCircle(b, rx, ry, rw, rh) {
    const cx = Math.max(rx, Math.min(b.x, rx + rw));
    const cy = Math.max(ry, Math.min(b.y, ry + rh));
    const dx = b.x - cx;
    const dy = b.y - cy;
    return dx * dx + dy * dy < b.r * b.r;
  }

  pipeHit(b, en) {
    const half = en.gapH / 2;
    const topH = en.gapY - half;
    const botY = en.gapY + half;
    if (this.rectCircle(b, en.x, -10, en.w, topH + 10)) return true;
    return this.rectCircle(b, en.x, botY, en.w, H - GROUND_H - botY);
  }

  burst(x, y, glyph, n, big = false) {
    for (let i = 0; i < n; i++) {
      this.particles.push({
        glyph,
        x,
        y,
        vx: -160 + Math.random() * 300,
        vy: -220 + Math.random() * 280,
        life: 0.8,
        max: 0.8,
        size: big ? 26 : 20,
      });
    }
  }

  updateAmbient(dt, idleMode) {
    const ecoVal = this.eco.value;
    const wantButterflies = idleMode ? 2 : Math.floor(ecoVal / 28);
    const wantBirds = !idleMode && ecoVal >= 75 ? 2 : 0;
    const flies = this.ambient.filter((a) => a.glyph === "🦋").length;
    const birds = this.ambient.filter((a) => a.glyph === "🐦").length;

    if (flies < wantButterflies && Math.random() < dt * 0.8) {
      const y = 90 + Math.random() * (H - GROUND_H - 220);
      this.ambient.push({ glyph: "🦋", x: -40, y, y0: y, vx: 46 + Math.random() * 34, ph: Math.random() * 6 });
    }
    if (birds < wantBirds && Math.random() < dt * 0.4) {
      const y = 60 + Math.random() * 160;
      this.ambient.push({ glyph: "🐦", x: W + 50, y, y0: y, vx: -(120 + Math.random() * 60), ph: Math.random() * 6 });
    }

    for (let i = this.ambient.length - 1; i >= 0; i--) {
      const a = this.ambient[i];
      a.x += a.vx * dt * (idleMode ? 0.5 : 1);
      a.y = a.y0 + Math.sin(this.t * 2 + a.ph) * 16;
      if (a.x < -60 || a.x > W + 80) this.ambient.splice(i, 1);
    }
    if (this.ambient.length > 8) this.ambient.splice(0, this.ambient.length - 8);
  }

  render() {
    const ctx = this.ctx;
    const e = this.eco.value / 100;

    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * 10 * this.shake, (Math.random() - 0.5) * 10 * this.shake);
    }

    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, lerpHex("#494c55", "#8fd3f0", e));
    sky.addColorStop(1, lerpHex("#8a8272", "#eef9da", e));
    ctx.fillStyle = sky;
    ctx.fillRect(-12, -12, W + 24, H + 24);

    ctx.save();
    ctx.globalAlpha = 0.15 + 0.7 * e;
    ctx.fillStyle = "#ffe9a8";
    ctx.beginPath();
    ctx.arc(1050, 110, 55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this.drawHills(ctx, H - GROUND_H - 60, 46, 0.22, lerpHex("#6a6350", "#5aa85c", e), 1.7);
    this.drawHills(ctx, H - GROUND_H - 24, 30, 0.35, lerpHex("#585139", "#33853c", e), 2.6);

    this.drawTrees(ctx, e);
    this.drawGround(ctx, e);

    for (const a of this.ambient) {
      ctx.font = "26px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(a.glyph, a.x, a.y);
    }

    this.drawEntities(ctx);

    const blink = this.invulnT > 0 && Math.floor(this.invulnT * 10) % 2 === 0;
    if (blink) {
      ctx.save();
      ctx.globalAlpha = 0.3;
    }
    ctx.save();
    ctx.translate(this.bee.x, this.bee.y);
    ctx.rotate(Math.max(-0.5, Math.min(0.8, this.bee.vy * 0.002)));

    const flapW = 0.5 + 0.5 * Math.abs(Math.sin(this.t * 44));
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.35 * flapW;
    ctx.fillStyle = "#eaf4ff";
    ctx.strokeStyle = "#4c6f9c";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(-4, -28, 19, 9 * (0.55 + 0.45 * flapW), -0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(13, -24, 16, 8 * (0.55 + 0.45 * flapW), 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const bs = beeSprite();
    ctx.drawImage(bs, -bs.width / 2, -bs.height / 2);
    ctx.restore();
    if (blink) ctx.restore();

    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.max);
      if (p.glyph) {
        const spr = glyphSprite(p.glyph, p.size);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(spr, p.x - spr.width / 2, p.y - spr.height / 2);
        ctx.restore();
      } else {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const tx of this.texts) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, tx.life * 1.4));
      ctx.font = `800 ${tx.size}px Outfit, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(6,16,10,0.78)";
      ctx.strokeText(tx.text, tx.x, tx.y);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.text, tx.x, tx.y);
      ctx.restore();
    }
    ctx.restore();

    const haze = 0.05 + (1 - e) * 0.1;
    ctx.fillStyle = `rgba(96,96,104,${haze})`;
    ctx.fillRect(-12, -12, W + 24, H + 24);

    if (this.flashRed > 0) {
      ctx.fillStyle = `rgba(255,60,60,${this.flashRed * 0.35})`;
      ctx.fillRect(-12, -12, W + 24, H + 24);
    }

    ctx.restore();
  }

  drawHills(ctx, yBase, amp, factor, color, freq) {
    const off = (this.scroll * factor) % (W / 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-20, H);
    for (let x = -20; x <= W + 20; x += 16) {
      const y = yBase - amp * (0.6 + 0.4 * Math.sin((x + off) * 0.008 * freq) * Math.cos((x + off) * 0.0021 * freq));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W + 20, H);
    ctx.closePath();
    ctx.fill();
  }

  drawTrees(ctx, e) {
    const spacing = 310;
    const scrollFar = this.scroll * 0.5;
    const first = Math.floor(scrollFar / spacing);
    for (let k = first - 1; k <= first + Math.ceil(W / spacing) + 1; k++) {
      const seed = ((k * 137) % 97) / 97;
      const x = k * spacing - scrollFar + seed * 120;
      if (x < -80 || x > W + 80) continue;
      const size = 0.75 + seed * 0.5;
      ctx.fillStyle = "#5d4a33";
      ctx.fillRect(x - 5 * size, H - GROUND_H - 66 * size, 10 * size, 70 * size);
      if (e < 0.25) {
        ctx.strokeStyle = "#5d4a33";
        ctx.lineWidth = 4 * size;
        ctx.beginPath();
        ctx.moveTo(x, H - GROUND_H - 62 * size);
        ctx.lineTo(x - 20 * size, H - GROUND_H - 92 * size);
        ctx.moveTo(x, H - GROUND_H - 72 * size);
        ctx.lineTo(x + 22 * size, H - GROUND_H - 104 * size);
        ctx.stroke();
      } else {
        ctx.fillStyle = lerpHex("#7a8f4a", "#2f9e44", e);
        const cr = (22 + e * 26) * size;
        ctx.beginPath();
        ctx.arc(x, H - GROUND_H - 86 * size, cr, 0, Math.PI * 2);
        ctx.arc(x - cr * 0.7, H - GROUND_H - 70 * size, cr * 0.7, 0, Math.PI * 2);
        ctx.arc(x + cr * 0.7, H - GROUND_H - 72 * size, cr * 0.75, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawGround(ctx, e) {
    ctx.fillStyle = lerpHex("#7c7250", "#49b058", e);
    ctx.fillRect(-12, H - GROUND_H, W + 24, GROUND_H + 12);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(-12, H - GROUND_H, W + 24, 5);

    const tufts = Math.floor(e * 42);
    for (let i = 0; i < tufts; i++) {
      const x = (((i * 173 - this.scroll) % W) + W) % W;
      const h = 8 + ((i * 61) % 12);
      ctx.strokeStyle = "#2f7d3a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, H - GROUND_H + 4);
      ctx.quadraticCurveTo(x + 4, H - GROUND_H + 4 - h, x + 8, H - GROUND_H + 2 - h);
      ctx.stroke();
    }

    const flowers = Math.floor(e * 16);
    ctx.font = "19px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < flowers; i++) {
      const x = (((i * 211 + 57 - this.scroll) % W) + W) % W;
      ctx.fillText(i % 3 === 0 ? "🌼" : "🌸", x, H - GROUND_H + 34);
    }
  }

  drawEntities(ctx) {
    for (const en of this.entities) {
      if (en.type === "pipe") {
        this.drawPipe(ctx, en);
        continue;
      }
      const bob = en.type === "flower" || en.type === "plastic" ? Math.sin(this.t * 3 + en.x * 0.02) * 5 : 0;
      if (en.type === "native") {
        ctx.save();
        ctx.strokeStyle = `rgba(255,207,64,${0.5 + 0.4 * Math.sin(this.t * 5)})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(en.x, en.y, en.r + 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      const spr = glyphSprite(en.glyph, Math.round(en.r * 2));
      ctx.drawImage(spr, en.x - spr.width / 2, en.y + bob - spr.height / 2);
    }
  }

  drawPipe(ctx, en) {
    const half = en.gapH / 2;
    const topH = en.gapY - half;
    const botY = en.gapY + half;
    const botH = H - GROUND_H - botY;

    ctx.fillStyle = "#46505e";
    ctx.fillRect(en.x, -10, en.w, topH + 10);
    ctx.fillRect(en.x, botY, en.w, botH);

    ctx.fillStyle = "#333b47";
    ctx.fillRect(en.x - 7, topH - 20, en.w + 14, 20);
    ctx.fillRect(en.x - 7, botY, en.w + 14, 20);

    ctx.fillStyle = "rgba(234,179,8,0.85)";
    const segW = (en.w + 8) / 7;
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(en.x - 4 + i * segW * 2 - segW * 0.5, topH - 15, segW, 10);
      ctx.fillRect(en.x - 4 + i * segW * 2 - segW * 0.5, botY + 5, segW, 10);
    }

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(en.x + 4, -10, 6, topH + 10);
    ctx.fillRect(en.x + 4, botY, 6, botH);
  }
}
