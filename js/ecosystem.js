export function lerpHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return `rgb(${r},${g},${bl})`;
}

export class Ecosystem {
  constructor() {
    this.eco = 0;
  }

  reset() {
    this.eco = 0;
  }

  add(v) {
    this.eco = Math.max(0, Math.min(100, this.eco + v));
  }

  get value() {
    return this.eco;
  }

  get tier() {
    if (this.eco < 25) return 0;
    if (this.eco < 50) return 1;
    if (this.eco < 75) return 2;
    return 3;
  }

  skyTop() {
    return lerpHex("#494c55", "#8fd3f0", this.eco / 100);
  }

  skyBottom() {
    return lerpHex("#8a8272", "#eef9da", this.eco / 100);
  }

  hillFar() {
    return lerpHex("#6a6350", "#5aa85c", this.eco / 100);
  }

  hillNear() {
    return lerpHex("#585139", "#33853c", this.eco / 100);
  }

  ground() {
    return lerpHex("#7c7250", "#49b058", this.eco / 100);
  }

  canopy() {
    return lerpHex("#7a8f4a", "#2f9e44", this.eco / 100);
  }
}
