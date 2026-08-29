/*
 * Boot watchdog (moved out of index.html so the Content-Security-Policy
 * can stay free of 'unsafe-inline').
 *
 * If js/main.js never signals a successful boot (window.__boothBooted),
 * tell the player what to try. Runs once, 7s after page load.
 */
setTimeout(() => {
  if (!window.__boothBooted) {
    const el = document.getElementById("error-msg");
    if (el) el.textContent = "Game failed to fully load — check internet (AI library downloads from CDN) and hard-refresh with Ctrl+F5.";
  }
}, 7000);
