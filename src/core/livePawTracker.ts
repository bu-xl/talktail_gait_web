/**
 * Live paw tracker — runs the gait engine on the LIVE stream so the heatmap can
 * show LF/RF/LH/RH boxes in real time.
 *
 * Empty-mat / post-walk noise:
 *   Adaptive scale uses a decaying running peak. After the dog leaves, that peak
 *   can stay high while residual jitter remains — inflating noise to paw-sized
 *   magnitudes. We gate on total delta sum + peak, collapse the scale reference
 *   on unload, and reset the engine immediately so stale tracks cannot box noise.
 */

import {
  PawGaitEngine,
  overlayFrameFromResult,
  pressureSumThresholdForWeightKg,
  type OverlayQuality,
  type PawOverlayFrame,
} from "../gait/index.js";
import { buildEngineConfig } from "./gaitAnalysis.js";
import { GRID_COLS, GRID_ROWS } from "./constants.js";
import { applyOrientation } from "./matrix.js";
import type { AppConfig, Matrix } from "./types.js";

const CELLS = GRID_ROWS * GRID_COLS;

export class LivePawTracker {
  private engine: PawGaitEngine;
  private readonly delta = new Float32Array(CELLS);
  private livePeak = 0;
  private idleFrames = 0;
  private active = false; // paw(s) on the mat this frame
  private tracking = false; // walk direction established -> labels are real

  constructor(
    private config: AppConfig,
    private weightKg: number,
    private readonly hz = 38,
  ) {
    this.engine = this.makeEngine();
  }

  private makeEngine(): PawGaitEngine {
    return new PawGaitEngine(buildEngineConfig(this.config.gait, this.weightKg, this.hz));
  }

  /** Rebuild on weight/config change (sensitivity profile depends on weight). */
  setWeight(weightKg: number): void {
    if (weightKg === this.weightKg || !Number.isFinite(weightKg)) return;
    this.weightKg = weightKg;
    this.reset();
  }

  setConfig(config: AppConfig): void {
    this.config = config;
    this.reset();
  }

  reset(): void {
    this.engine = this.makeEngine();
    this.livePeak = 0;
    this.idleFrames = 0;
    this.active = false;
    this.tracking = false;
  }

  /** Live status for the on-screen indicator. */
  getStatus(): { active: boolean; tracking: boolean } {
    return { active: this.active, tracking: this.tracking };
  }

  private matLoadSumMin(): number {
    return pressureSumThresholdForWeightKg(this.weightKg);
  }

  private isMatLoaded(frameMax: number, frameSum: number): boolean {
    const po = this.config.paw_overlay;
    const loadSum = this.matLoadSumMin();
    return frameSum >= loadSum && frameMax >= po.live_min_peak;
  }

  private isMatUnloaded(frameMax: number, frameSum: number): boolean {
    const po = this.config.paw_overlay;
    const loadSum = this.matLoadSumMin();
    const sumCut = loadSum * po.live_unload_sum_ratio;
    const peakCut = po.live_min_peak * po.live_unload_peak_ratio;
    return frameSum < sumCut || frameMax < peakCut;
  }

  /**
   * Scale reference for engine normalisation. Never divide by a peak much larger
   * than the current frame — that would amplify post-walk noise.
   */
  private scaleReference(frameMax: number): number {
    const po = this.config.paw_overlay;
    this.livePeak = Math.max(frameMax, this.livePeak * po.live_scale_decay);
    if (frameMax < this.livePeak * po.live_unload_peak_ratio) {
      this.livePeak = Math.max(frameMax, po.live_min_peak);
    }
    return Math.max(this.livePeak, frameMax, po.live_min_peak);
  }

  /**
   * Process one live frame.
   * @returns overlay for this frame, or null when the mat is empty / idle.
   */
  process(raw: Matrix, baseline: Matrix, nowMs: number): PawOverlayFrame | null {
    const g = this.config.gait;
    const po = this.config.paw_overlay;
    const oriented = applyOrientation(raw, this.config.orientation, GRID_ROWS, GRID_COLS).matrix;

    const d = this.delta;
    let frameMax = 0;
    let frameSum = 0;
    for (let i = 0; i < CELLS; i++) {
      const v = baseline[i]! - oriented[i]!;
      const p = v > 0 ? v : 0;
      d[i] = p;
      frameSum += p;
      if (p > frameMax) frameMax = p;
    }

    const loaded = this.isMatLoaded(frameMax, frameSum);
    const unloaded = this.isMatUnloaded(frameMax, frameSum);

    if (!loaded) {
      this.active = false;
      this.livePeak = Math.max(frameMax, this.livePeak * po.live_scale_decay);
      if ((this.tracking || this.active) && unloaded) {
        this.reset();
      } else if (++this.idleFrames > this.hz * 2) {
        this.reset();
      }
      return null;
    }

    this.idleFrames = 0;
    const scaleRef = this.scaleReference(frameMax);

    let scale: number;
    if (g.pressure_scale != null && g.pressure_scale > 0) {
      scale = g.pressure_scale;
    } else {
      scale = g.normalize_target_peak / Math.max(scaleRef, 1e-6);
    }
    if (scale !== 1) {
      for (let i = 0; i < CELLS; i++) d[i] *= scale;
    }

    const result = this.engine.processFlatFrame(d, nowMs);
    this.active = result.blobs.length > 0;
    this.tracking = result.readyForClassification;

    if (result.blobs.length === 0) {
      if (++this.idleFrames > this.hz * 1) this.reset();
      return null;
    }
    this.idleFrames = 0;

    const quality: OverlayQuality = {
      requireContact: po.require_contact,
      minArea: po.min_contact_area,
      minPeak: po.min_contact_peak_frac * g.normalize_target_peak,
      minTrackFrames: Math.max(po.min_track_frames, po.live_min_track_frames),
      minContactFrames: Math.max(1, Math.round(po.min_contact_sec * this.hz)),
    };

    const showUnknown =
      po.show_unknown && (!po.live_require_tracking_for_unknown || this.tracking);
    const overlay = overlayFrameFromResult(result, showUnknown, quality);

    if (!this.tracking) {
      const labeled = overlay.items.filter((it) => it.label !== "Unknown");
      if (labeled.length === 0) return null;
      return { frameIndex: overlay.frameIndex, items: labeled };
    }

    return overlay.items.length > 0 ? overlay : null;
  }
}
