import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export class VisionManager {
  constructor() {
    this.landmarker = null;
    this.video = null;

    this.lastVideoTime = -1;
    this.landmarks = null;

    // Smoothed thumb-index distance.
    this.gap = null;

    this.pinched = false;
    this.onPinch = null;

    this.lastSeen = 0;
    this.prevGap = null;

    // Prevent repeated firing.
    this.lastFire = 0;
    this.firedFlash = 0;

    this.lowSince = null;

    // Open-hand reference.
    this.restLvl = null;

    // Thresholds exposed to the UI/debugging.
    this.thDown = null;
    this.thUp = null;

    // Whether another pinch can fire.
    this.armed = false;

    // Calibration.
    this.calib = null;

    // MediaPipe recovery.
    this.failCount = 0;
    this.aiError = false;
    this.usedDelegate = "GPU";

    /*
     * ========================================================
     * PINCH GESTURE STATE
     * ========================================================
     */

    // Local baseline from which a small pinch is measured.
    this.localGapBaseline = null;

    // Gap at the beginning of the current pinch attempt.
    this.pinchStartGap = null;

    // Amount the fingers have moved inward.
    this.pinchDelta = 0;

    // Number of consecutive frames satisfying pinch conditions.
    this.pinchFrames = 0;

    // Frames spent reopening.
    this.releaseFrames = 0;

    // Gap + baseline captured when the last flap fired — lets re-arm be
    // relative to the player's own pinch depth instead of a fixed threshold.
    this.fireGap = null;
    this.fireBaseline = null;

    // Guards against overlapping landmarker re-creations.
    this.recreating = false;
  }

  async init(video) {
    this.video = video;

    /*
     * Retries (e.g. after a failed calibration) used to request a second
     * camera stream and leak the first one — release it before asking
     * for a new one.
     */
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    const stream =
      await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: false,
      },
    );

    video.srcObject = stream;
    this.stream = stream;

    await new Promise((resolve) => {
      if (video.readyState >= 1) {
        resolve();
      } else {
        video.onloadedmetadata = () => resolve();
      }
    });

    await video.play();

    const vision =
      await FilesetResolver.forVisionTasks(
        WASM_BASE
      );

    try {
      this.landmarker =
        await this.create(
          vision,
          "GPU"
        );
    } catch {
      console.warn(
        "[vision] GPU unavailable, falling back to CPU"
      );

      this.landmarker =
        await this.create(
          vision,
          "CPU"
        );
    }
  }

  create(vision, delegate) {
    this.usedDelegate = delegate;

    return HandLandmarker.createFromOptions(
      vision,
      {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate,
        },

        runningMode: "VIDEO",

        numHands: 1,
      }
    );
  }

  async recreate() {
    /*
     * detect() triggers recreate at two failure marks; if a previous
     * recreation is still awaiting its model, don't start a second one —
     * two racing recreations can toggle GPU/CPU twice and land on the
     * delegate that was failing.
     */
    if (this.recreating) return;
    this.recreating = true;
    try {
      const nextDelegate =
        this.usedDelegate === "GPU"
          ? "CPU"
          : "GPU";

      console.warn(
        `[vision] recreating landmarker with ${nextDelegate}`
      );

      const vision =
        await FilesetResolver.forVisionTasks(
          WASM_BASE
        );

      this.landmarker =
        await this.create(
          vision,
          nextDelegate
        );

      this.failCount = 0;
      this.aiError = false;
      this.lastVideoTime = -1;
    } catch (err) {
      console.error(
        "[vision] recreate failed",
        err
      );

      this.aiError = true;
    } finally {
      this.recreating = false;
    }
  }

  detect() {
    if (
      !this.landmarker ||
      !this.video ||
      this.video.readyState < 2
    ) {
      return;
    }

    // Don't process the same video frame twice.
    if (
      this.video.currentTime ===
      this.lastVideoTime
    ) {
      return;
    }

    this.lastVideoTime =
      this.video.currentTime;

    let res = null;

    try {
      res =
        this.landmarker.detectForVideo(
          this.video,
          performance.now()
        );

      if (this.failCount > 0) {
        this.failCount = 0;
      }

      this.aiError = false;
    } catch (err) {
      console.error(
        "[vision] detect failed",
        err
      );

      this.failCount += 1;
      this.aiError = true;
      this.landmarks = null;

      if (
        this.failCount === 20 ||
        this.failCount === 90
      ) {
        this.recreate();
      }

      return;
    }

    const lm =
      res?.landmarks?.[0];

    /*
     * ========================================================
     * NO HAND DETECTED
     * ========================================================
     */

    if (!lm) {
      this.landmarks = null;

      this.pinched = false;

      this.lowSince = null;
      this.prevGap = null;

      this.pinchStartGap = null;
      this.pinchDelta = 0;
      this.pinchFrames = 0;
      this.releaseFrames = 0;

      this.localGapBaseline = null;

      /*
       * Drop the stale gap so the first frame after the hand returns
       * starts from a fresh measurement instead of blending with an
       * old value.
       */
      this.gap = null;

      return;
    }

    this.landmarks = lm;
    this.lastSeen =
      performance.now();

    /*
     * ========================================================
     * THUMB ↔ INDEX DISTANCE
     * ========================================================
     *
     * MediaPipe:
     *
     *   4 = thumb tip
     *   8 = index tip
     *
     * The distance is normalized against the thumb/index
     * MCP span so the measurement is less affected by
     * distance from the camera.
     */

    const pinchDist =
      Math.hypot(
        lm[4].x - lm[8].x,
        lm[4].y - lm[8].y
      );

    const span =
      Math.hypot(
        lm[2].x - lm[5].x,
        lm[2].y - lm[5].y
      );

    const raw =
      span > 0.015
        ? pinchDist / span
        : pinchDist * 6;

    /*
     * ========================================================
     * SMOOTHING
     * ========================================================
     *
     * 0.72 keeps the response fast enough for gameplay
     * while filtering MediaPipe landmark jitter.
     */

    this.gap =
      this.gap == null
        ? raw
        : this.gap +
          (raw - this.gap) * 0.72;

    /*
     * ========================================================
     * CALIBRATION
     * ========================================================
     */

    const c = this.calib;

    if (c && !c.done) {
      c.min =
        Math.min(
          c.min,
          this.gap
        );

      c.max =
        Math.max(
          c.max,
          this.gap
        );

      c.elapsed =
        performance.now() -
        c.start;

      if (
        c.elapsed >=
        c.duration
      ) {
        c.done = true;

        const range =
          c.max - c.min;

        c.quality =
          range < 0.3
            ? "low"
            : "ok";

        /*
         * Store the open-hand level.
         */
        this.restLvl =
          Math.max(
            this.gap ?? 1.1,
            (c.max || 1.4) * 0.9
          );

        /*
         * Ready to detect the first pinch.
         */
        this.armed = true;

        /*
         * Start the local baseline at the current
         * finger position.
         */
        this.localGapBaseline =
          this.gap;

        this.pinchStartGap = null;
        this.pinchDelta = 0;
        this.pinchFrames = 0;
        this.releaseFrames = 0;

        this.fireGap = null;
        this.fireBaseline = null;

        this.recomputeLine();

        this.prevGap = null;
        this.lowSince = null;
      }

      return;
    }

    this.evaluatePinch(
      performance.now()
    );
  }

  /*
   * ========================================================
   * SMALL PINCH DETECTION
   * ========================================================
   *
   * Desired behavior:
   *
   *   fingers apart
   *        ↓
   *   small pinch
   *        ↓
   *   fingers move closer
   *        ↓
   *      FLAP
   *
   * We intentionally DO NOT require the fingers to touch.
   *
   * We also don't trigger from a single frame of movement.
   */

  evaluatePinch(nowMs) {
    const vel =
      this.prevGap == null
        ? 0
        : this.gap -
          this.prevGap;

    /*
     * ========================================================
     * TUNING
     * ========================================================
     *
     * SMALL_PINCH_DELTA
     *
     * How much the fingers need to close.
     *
     * Smaller = easier.
     * Larger = less sensitive.
     *
     * 0.065 is deliberately more conservative than the
     * previous 0.035 setting.
     */
    const SMALL_PINCH_DELTA =
      0.065;

    /*
     * Minimum inward velocity.
     *
     * This prevents ordinary landmark jitter from being
     * treated as a pinch.
     */
    const CLOSE_VELOCITY =
      -0.018;

    /*
     * Don't start a pinch from a very wide finger position.
     */
    const MAX_GESTURE_GAP =
      0.72;

    /*
     * Emergency/absolute pinch threshold.
     *
     * If the fingers actually become very close, we allow
     * the gesture to register even if the movement wasn't
     * captured perfectly.
     */
    const HARD_PINCH_THRESHOLD =
      0.38;

    /*
     * Fingers need to open this far before another flap.
     */
    const REARM_THRESHOLD =
      0.52;

    /*
     * Require consecutive frames. 2 keeps jitter out (the closing motion
     * AND the 0.065 distance must both hold twice in a row) while adding
     * only ~1 video frame of latency — 3 made fast double pinches feel
     * unresponsive.
     */
    const REQUIRED_PINCH_FRAMES =
      2;

    /*
     * ========================================================
     * UPDATE LOCAL BASELINE
     * ========================================================
     */

    if (
      this.localGapBaseline ==
      null
    ) {
      this.localGapBaseline =
        this.gap;
    }

    /*
     * Determine whether the fingers are opening/stable.
     */
    const isOpening =
      vel > 0.004;

    const isStable =
      Math.abs(vel) <=
      0.004;

    /*
     * Only update the baseline when we are NOT actively
     * closing the fingers.
     *
     * This is extremely important.
     *
     * Otherwise:
     *
     *   baseline 0.60
     *   gap      0.57
     *
     * would immediately become:
     *
     *   baseline 0.57
     *
     * and the small pinch would disappear.
     */

    if (
      isOpening ||
      isStable
    ) {
      this.localGapBaseline +=
        (
          this.gap -
          this.localGapBaseline
        ) * 0.06;
    }

    /*
     * Keep baseline within sensible limits.
     */
    this.localGapBaseline =
      Math.max(
        0.25,
        Math.min(
          1.5,
          this.localGapBaseline
        )
      );

    /*
     * ========================================================
     * CLOSING DISTANCE
     * ========================================================
     */

    const closingDelta =
      this.localGapBaseline -
      this.gap;

    this.pinchDelta =
      Math.max(
        0,
        closingDelta
      );

    /*
     * ========================================================
     * BASIC PINCH CONDITIONS
     * ========================================================
     */

    /*
     * A small but meaningful pinch.
     */
    const smallPinch =
      closingDelta >=
        SMALL_PINCH_DELTA &&
      this.gap <
        MAX_GESTURE_GAP;

    /*
     * Very close thumb/index.
     */
    const hardPinch =
      this.gap <
      HARD_PINCH_THRESHOLD;

    /*
     * A real closing movement.
     *
     * IMPORTANT:
     *
     * This is NOT enough by itself to trigger.
     *
     * It must be combined with the closing-distance
     * requirement below.
     */
    const closingMotion =
      vel <
      CLOSE_VELOCITY;

    /*
     * ========================================================
     * RE-ARM
     * ========================================================
     *
     * Fingers have to separate again before another flap.
     */

    /*
     * A purely fixed REARM_THRESHOLD misses players whose whole
     * open-pinch range sits below it (hand angle, pinch style,
     * distance from the camera) — after one flap the bee would never
     * flap again. So also re-arm relative to the last pinch's actual
     * depth: reopening at least max(0.08, half the closing that was
     * measured) counts as "fingers apart" again.
     */
    const relativeRearm =
      this.fireGap != null &&
      this.gap - this.fireGap >=
        Math.max(
          0.08,
          0.5 *
            ((this.fireBaseline ?? this.gap) -
              this.fireGap)
        );

    if (
      this.gap >
        REARM_THRESHOLD ||
      relativeRearm
    ) {
      this.armed = true;

      this.pinched = false;

      this.pinchStartGap = null;

      this.pinchDelta = 0;

      this.pinchFrames = 0;

      this.fireGap = null;

      this.fireBaseline = null;

      /*
       * Fast double-pinch support: on a relative re-arm, raise the baseline
       * to the reopen apex immediately. Otherwise the next close is measured
       * against the stale low baseline, the required 0.065 closing distance
       * is never reached on a shallow reopen, and the second pinch only
       * fires after an extra-deep re-close.
       */
      if (
        relativeRearm
      ) {
        this.localGapBaseline =
          Math.max(
            this.localGapBaseline,
            Math.min(
              1.5,
              this.gap
            )
          );
      }

      this.releaseFrames += 1;

      /*
       * Once released for a couple frames, let the baseline
       * follow the user's new hand position.
       */
      if (
        this.releaseFrames >=
        2
      ) {
        this.localGapBaseline =
          this.gap;

        this.releaseFrames = 0;
      }
    } else {
      this.releaseFrames = 0;
    }

    /*
     * ========================================================
     * PINCH FRAME ACCUMULATION
     * ========================================================
     *
     * We require both:
     *
     *   1. enough movement
     *   2. actual inward movement
     *
     * This is what prevents random finger movement from
     * triggering the bird.
     */

    const pinchCandidate =
      (
        smallPinch &&
        closingMotion
      ) ||
      hardPinch;

    if (
      this.armed &&
      pinchCandidate
    ) {
      if (
        this.pinchStartGap ==
        null
      ) {
        this.pinchStartGap =
          this.localGapBaseline;
      }

      this.pinchFrames += 1;
    } else {
      /*
       * Don't accumulate stale pinch frames.
       */
      this.pinchFrames = 0;

      /*
       * If the hand moves back toward/above the baseline,
       * cancel the current pinch attempt.
       */
      if (
        this.gap >=
        this.localGapBaseline
      ) {
        this.pinchStartGap =
          null;

        this.pinchDelta = 0;
      }
    }

    /*
     * ========================================================
     * CONFIRM PINCH
     * ========================================================
     */

    const deliberateSmallPinch =
      this.pinchFrames >=
        REQUIRED_PINCH_FRAMES &&
      closingDelta >=
        SMALL_PINCH_DELTA &&
      closingMotion;

    const confirmedHardPinch =
      hardPinch &&
      this.pinchFrames >=
        REQUIRED_PINCH_FRAMES;

    const shouldFire =
      deliberateSmallPinch ||
      confirmedHardPinch;

    /*
     * ========================================================
     * FLAP
     * ========================================================
     */

    /*
     * Small burst guard only. The old 180 ms lockout was the main reason the
     * second flap of a fast double pinch fired late — the re-arm rule (must
     * reopen about half the pinch depth) already prevents double fires.
     */
    if (
      this.armed &&
      shouldFire &&
      nowMs -
        this.lastFire >
        70
    ) {
      /*
       * One pinch = one flap.
       */
      this.armed = false;

      /*
       * Remember how deep this pinch was, so re-arm can be
       * relative to the player's own pinch range.
       */
      this.fireGap =
        this.gap;

      this.fireBaseline =
        this.localGapBaseline;

      this.lastFire =
        nowMs;

      this.pinched = true;

      this.firedFlash =
        nowMs;

      this.lowSince = null;

      /*
       * Clear current pinch state.
       */
      this.pinchFrames = 0;

      this.pinchStartGap = null;

      this.pinchDelta = 0;

      /*
       * Trigger the game.
       */
      if (this.onPinch) {
        this.onPinch();
      }
    }

    /*
     * Store current gap for next frame's velocity.
     */
    this.prevGap =
      this.gap;
  }

  /*
   * ========================================================
   * THRESHOLD INFORMATION
   * ========================================================
   */

  recomputeLine() {
    this.thDown =
      0.38;

    this.thUp =
      0.52;
  }

  /*
   * ========================================================
   * START CALIBRATION
   * ========================================================
   */

  startCalibration(
    duration = 3400
  ) {
    this.calib = {
      start:
        performance.now(),

      duration,

      min: 99,

      max: -99,

      elapsed: 0,

      done: false,

      quality: null,
    };

    this.gap = null;

    this.prevGap = null;

    this.lastFire = 0;

    this.lowSince = null;

    this.restLvl = null;

    this.localGapBaseline = null;

    this.pinchStartGap = null;

    this.pinchDelta = 0;

    this.pinchFrames = 0;

    this.releaseFrames = 0;

    this.fireGap = null;

    this.fireBaseline = null;

    this.armed = false;

    this.pinched = false;
  }

  get calibrationState() {
    return this.calib;
  }

  /*
   * ========================================================
   * HAND LOST CHECK
   * ========================================================
   */

  lostFor(ms) {
    return (
      performance.now() -
        this.lastSeen >
      ms
    );
  }
}