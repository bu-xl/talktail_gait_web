/**
 * End-to-end processing pipeline shared by live serial AND playback:
 *
 *   raw 40x40 -> orientation -> calibrate+threshold -> temporal smoothing -> stats
 *
 * Keeping this in one place guarantees recorded data is processed identically to
 * live data (a hard requirement).
 */

import { GRID_COLS, GRID_ROWS } from "./constants.js";
import { applyOrientation } from "./matrix.js";
import { minNeighborGate, spatialMedian } from "./noiseReducer.js";
import { PressureCalibrator } from "./pressureCalibrator.js";
import { computeStats } from "./stats.js";
import { TemporalSmoother } from "./smoothing.js";
import type { AppConfig, CalibrationState, FrameStats, Matrix } from "./types.js";

export interface ProcessedFrame {
  pressure: Matrix; // smoothed + thresholded, row-major (rows x cols)
  rows: number;
  cols: number;
  stats: FrameStats;
  state: CalibrationState;
  unit: string;
}

export class ProcessingPipeline {
  private readonly calibrator: PressureCalibrator;
  private readonly smoother: TemporalSmoother;
  private collecting = false;
  private framesNeeded = 0;

  constructor(private config: AppConfig) {
    this.calibrator = new PressureCalibrator(config);
    this.smoother = new TemporalSmoother(
      config.smoothing.ema_alpha,
      config.smoothing.ema_alpha_rising,
      config.smoothing.fade_out_ms,
      config.pressure_thresholds.visible_min_mmhg,
    );
  }

  /** Begin baseline collection for `approxFps` * collect_seconds frames. */
  beginBaseline(approxFps: number): void {
    this.collecting = true;
    this.framesNeeded = Math.max(1, Math.round(approxFps * this.config.baseline.collect_seconds));
  }

  get isCalibrated(): boolean {
    return this.calibrator.calibratedBaseline;
  }

  /** Process one raw matrix into a render-ready, analysed frame. */
  process(raw: Matrix): ProcessedFrame {
    const oriented = applyOrientation(raw, this.config.orientation, GRID_ROWS, GRID_COLS);
    const { rows, cols } = oriented;

    // (1) Spatial median on the RAW frame removes single-pixel ADC spikes at the
    // source without blurring real contact regions (median preserves edges).
    const denoisedRaw = this.config.noise.spatial_median
      ? spatialMedian(oriented.matrix, rows, cols, 3)
      : oriented.matrix;

    if (this.collecting) {
      this.calibrator.collectBaselineFrame(denoisedRaw, this.framesNeeded);
      if (this.calibrator.calibratedBaseline) this.collecting = false;
    }

    // (2) Calibrate -> pressure (deadband applied inside, killing baseline jitter).
    const frame = this.calibrator.toPressureFrame(denoisedRaw);

    // (3) Drop isolated speckle cells (e.g. a single offset sensor) before
    // smoothing: real contact is always a connected blob, noise is not.
    const gated = minNeighborGate(
      frame.pressure,
      rows,
      cols,
      this.config.noise.min_active_neighbors,
    );

    const smoothed = this.smoother.step(gated);
    const stats = computeStats(smoothed, this.config);
    return {
      pressure: smoothed,
      rows,
      cols,
      stats,
      state: frame.state,
      unit: frame.unit,
    };
  }

  /** Advance the fade-out when the stream stalls (no new frame for dtMs). */
  fade(dtMs: number): Matrix {
    return this.smoother.fade(dtMs);
  }

  /** Clear temporal smoothing + any in-progress baseline collection (new source). */
  reset(): void {
    this.smoother.reset();
    this.collecting = false;
    this.framesNeeded = 0;
  }

  /** Snapshot the current baseline (for seeding an isolated export pipeline). */
  snapshotBaseline(): { baseline: Matrix; hasBaseline: boolean } {
    return { baseline: this.calibrator.getBaseline(), hasBaseline: this.calibrator.calibratedBaseline };
  }

  /** Seed this pipeline's baseline from a snapshot (keeps live state isolated). */
  loadBaseline(snap: { baseline: Matrix; hasBaseline: boolean }): void {
    this.calibrator.setBaseline(snap.baseline, snap.hasBaseline);
  }

  /**
   * Re-process a list of raw frames into pressure fields WITHOUT touching this
   * pipeline's live smoother — used by exporters. A fresh smoother gives the same
   * temporal continuity the live view had, but in isolation.
   */
  exportPressures(rawFrames: readonly Matrix[]): ProcessedFrame[] {
    const exporter = new ProcessingPipeline(this.config);
    exporter.loadBaseline(this.snapshotBaseline());
    return rawFrames.map((raw) => exporter.process(raw));
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
    this.calibrator.setConfig(config);
  }
}
