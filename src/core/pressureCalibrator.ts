/**
 * Raw -> pressure conversion.
 *
 * Pipeline: baseline (per-cell unloaded median) -> delta -> mmHg (or relative)
 * -> threshold (cells below visible_min become NaN and are excluded downstream).
 *
 * Because raw goes DOWN under load, the loaded "delta" is
 *   delta = max(0, baseline - raw).
 *
 * The mmHg mapping is intentionally config-driven. With real calibration
 * coefficients we report mmHg; without them we report a *relative* scale and
 * never label it mmHg (production safety rule).
 */

import { RAW_MAX, SENSOR_COUNT } from "./constants.js";
import { makeMatrix } from "./matrix.js";
import type { AppConfig, CalibrationState, Matrix, PressureFrame } from "./types.js";

/** Per-cell median of collected unloaded frames -> baseline matrix. */
export function buildBaseline(frames: Matrix[], cells = SENSOR_COUNT): Matrix {
  const baseline = makeMatrix(cells, 1);
  if (frames.length === 0) {
    baseline.fill(RAW_MAX); // uncalibrated fallback
    return baseline;
  }
  const column = new Float64Array(frames.length);
  for (let c = 0; c < cells; c++) {
    for (let f = 0; f < frames.length; f++) column[f] = frames[f][c];
    baseline[c] = median(column);
  }
  return baseline;
}

function median(values: Float64Array): number {
  const arr = Float64Array.from(values).sort();
  const n = arr.length;
  if (n === 0) return RAW_MAX;
  const mid = n >> 1;
  return n % 2 ? arr[mid] : 0.5 * (arr[mid - 1] + arr[mid]);
}

/**
 * delta[c] = max(0, baseline[c] - raw[c] - deadband).
 *
 * The optional `deadband` (raw counts) suppresses small per-cell baseline jitter
 * so it never becomes a faint false reading; set 0 to disable.
 */
export function rawToDelta(raw: Matrix, baseline: Matrix, deadband = 0): Matrix {
  const out = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const d = baseline[i] - raw[i] - deadband;
    out[i] = d > 0 ? d : 0;
  }
  return out;
}

/** Convert a single delta value to pressure using the configured formula. */
export function deltaToMmHg(delta: number, config: AppConfig): number {
  switch (config.formula) {
    case "piecewise_linear": {
      const ranges = config.x_ranges;
      for (let i = 0; i < ranges.length; i++) {
        const [lo, hi] = ranges[i];
        if (delta >= lo && delta < hi) {
          const [a, b] = config.coefficients[i];
          return a * delta + b;
        }
      }
      // Above the last range: extrapolate with the last segment's coefficients.
      const last = config.coefficients[config.coefficients.length - 1] ?? [0, 0];
      return last[0] * delta + last[1];
    }
    case "linear_scale":
      return delta * config.scale; // TEST mode only
    case "relative":
    default:
      return delta * config.scale; // relative units (UI must not say mmHg)
  }
}

/** Whether the active formula yields physically calibrated mmHg. */
export function calibrationState(config: AppConfig, hasBaseline: boolean): CalibrationState {
  const calibratedFormula = config.formula === "piecewise_linear";
  return calibratedFormula && hasBaseline ? "calibrated" : "uncalibrated";
}

export class PressureCalibrator {
  private baseline: Matrix;
  private hasBaseline = false;
  private readonly buffer: Matrix[] = [];

  constructor(private config: AppConfig) {
    this.baseline = makeMatrix(SENSOR_COUNT, 1);
    this.baseline.fill(config.baseline.fallback_raw);
  }

  /** True once a real (non-fallback) baseline has been built. */
  get calibratedBaseline(): boolean {
    return this.hasBaseline;
  }

  /** Collect an unloaded frame toward the baseline; build it when enough seen. */
  collectBaselineFrame(raw: Matrix, framesNeeded: number): void {
    this.buffer.push(Float64Array.from(raw));
    if (this.buffer.length >= framesNeeded) this.finalizeBaseline();
  }

  finalizeBaseline(): void {
    if (this.buffer.length === 0) return;
    this.baseline = buildBaseline(this.buffer);
    this.hasBaseline = true;
    this.buffer.length = 0;
  }

  setConfig(config: AppConfig): void {
    this.config = config;
  }

  /** Copy in an existing baseline (e.g. to seed an isolated export pipeline). */
  setBaseline(baseline: Matrix, hasBaseline: boolean): void {
    this.baseline = Float64Array.from(baseline);
    this.hasBaseline = hasBaseline;
  }

  /**
   * Convert a raw matrix to a thresholded pressure frame. Cells below
   * `visible_min_mmhg` are set to NaN so they are invisible and excluded from
   * statistics. Thresholding is done here (BEFORE any smoothing/blur) so that
   * smoothing cannot reintroduce sub-threshold bleed.
   */
  toPressureFrame(raw: Matrix): PressureFrame {
    const delta = rawToDelta(raw, this.baseline, this.config.noise.deadband_raw);
    const out = new Float64Array(raw.length);
    const visibleMin = this.config.pressure_thresholds.visible_min_mmhg;
    for (let i = 0; i < delta.length; i++) {
      const p = deltaToMmHg(delta[i], this.config);
      out[i] = p >= visibleMin ? p : Number.NaN;
    }
    const state = calibrationState(this.config, this.hasBaseline);
    return { pressure: out, state, unit: state === "calibrated" ? "mmHg" : "rel" };
  }

  getBaseline(): Matrix {
    return this.baseline;
  }
}

/** Apply the visible threshold to an existing pressure matrix (NaN below min). */
export function applyThreshold(pressure: Matrix, visibleMin: number): Matrix {
  const out = new Float64Array(pressure.length);
  for (let i = 0; i < pressure.length; i++) {
    out[i] = pressure[i] >= visibleMin ? pressure[i] : Number.NaN;
  }
  return out;
}
