/**
 * Artifact parsers for the result player.
 *
 * Pure functions with no DOM dependency: the Web Worker wraps them, and the
 * tests call them directly. Every parser emits flat TypedArrays ready to hand to
 * `SampleTrack` without a second copy.
 */

import { GRID_COLS, GRID_ROWS, RAW_MAX, SENSOR_COUNT } from "../core/constants.js";
import {
  ANGLE_STRIDE,
  computeAngleSample,
} from "./skeletonSchema.js";

const NS_PER_SEC = 1e9;

export interface ParsedPressure {
  /** One per frame, ns, from the CSV `time` column. */
  timestampsNs: BigInt64Array;
  /** `frames * SENSOR_COUNT` RAW ADC counts, row-major per frame. */
  raw: Float32Array;
  /** Per-cell unloaded reference (p95 of the session), RAW counts. */
  baseline: Float32Array;
  /** Per-frame total load: sum of max(0, baseline - raw). */
  totals: Float32Array;
  /** Largest single-cell load in the session, for a fixed colour normalisation. */
  loadMax: number;
  rows: number;
  cols: number;
  frames: number;
}

export interface ParsedPose {
  /** One per DETECTED frame, ns. Undetected frames are omitted, not zero-filled. */
  timestampsNs: BigInt64Array;
  /** `frames * slots * 3` as [x, y, conf] per slot, original-resolution pixels. */
  keypoints: Float32Array;
  /** `frames * ANGLE_STRIDE`: 16 joint angles then 16 confidence floors. */
  angles: Float32Array;
  slots: number;
  frames: number;
  /** Frame period in ns, from `fps_source`. */
  periodNs: number;
  width: number;
  height: number;
  /** Total frames in the video, including undetected ones. */
  totalFrames: number;
  detectedFrames: number;
  /** Slot chains to draw, taken from the document rather than assumed. */
  limbChains: Record<string, number[]> | null;
}

/**
 * Parse the `canine_gait` pressure CSV: `frame_id,time,p_0_0,...,p_39_39`.
 *
 * `time` is seconds from the start of the recording and is NOT evenly spaced.
 * It is carried through to nanoseconds verbatim; nothing here resamples it onto
 * a nominal rate.
 */
export function parsePressureCsv(
  text: string,
  rows = GRID_ROWS,
  cols = GRID_COLS,
): ParsedPressure {
  const cells = rows * cols;
  const headerEnd = text.indexOf("\n");
  if (headerEnd < 0) throw new Error("pressure CSV has no header row");

  const header = text.slice(0, headerEnd).trim().split(",");
  const timeCol = header.indexOf("time");
  if (timeCol < 0) {
    throw new Error(`pressure CSV has no 'time' column (found: ${header.slice(0, 4).join(", ")}...)`);
  }
  const firstCell = header.findIndex((h) => /^p_\d+_\d+$/.test(h));
  if (firstCell < 0) throw new Error("pressure CSV has no p_ROW_COL grid columns");
  const gridCols = header.length - firstCell;
  if (gridCols !== cells) {
    throw new Error(`pressure CSV has ${gridCols} grid columns, expected ${cells} (${rows}x${cols})`);
  }

  const lineStarts = collectLineStarts(text, headerEnd + 1);
  const frames = lineStarts.length;
  const timestampsNs = new BigInt64Array(frames);
  const raw = new Float32Array(frames * cells);

  for (let f = 0; f < frames; f++) {
    const start = lineStarts[f];
    const end = f + 1 < frames ? lineStarts[f + 1] : text.length;
    scanPos = start;
    let seconds = 0;
    for (let c = 0; c <= timeCol; c++) {
      const v = scanNumber(text, end);
      if (c === timeCol) seconds = v;
    }
    timestampsNs[f] = BigInt(Math.round(seconds * NS_PER_SEC));

    // Skip any columns between `time` and the first grid column.
    for (let c = timeCol + 1; c < firstCell; c++) scanNumber(text, end);

    const base = f * cells;
    for (let k = 0; k < cells; k++) raw[base + k] = scanNumber(text, end);
  }

  assertAscendingTimes(timestampsNs);
  const baseline = perCellUnloadedBaseline(raw, frames, cells);
  const { totals, loadMax } = perFrameLoad(raw, baseline, frames, cells);

  return { timestampsNs, raw, baseline, totals, loadMax, rows, cols, frames };
}

/**
 * Per-cell unloaded reference, as the p95 of that cell across the session.
 *
 * RAW goes DOWN under load, so the unloaded state sits at the high end. The
 * median used by the live calibrator is not available here because replay has no
 * separately-recorded unloaded window; p95 tracks the unloaded level while still
 * rejecting single high spikes. Values are 12-bit, so an exact percentile comes
 * from a per-cell histogram in one pass.
 */
function perCellUnloadedBaseline(raw: Float32Array, frames: number, cells: number): Float32Array {
  const baseline = new Float32Array(cells);
  if (frames === 0) {
    baseline.fill(RAW_MAX);
    return baseline;
  }
  const bins = RAW_MAX + 1;
  const hist = new Uint16Array(cells * bins);
  for (let f = 0; f < frames; f++) {
    const base = f * cells;
    for (let k = 0; k < cells; k++) {
      const v = raw[base + k];
      const bin = Number.isFinite(v) ? Math.min(RAW_MAX, Math.max(0, Math.round(v))) : RAW_MAX;
      hist[k * bins + bin] += 1;
    }
  }
  const target = frames * 0.95;
  for (let k = 0; k < cells; k++) {
    const off = k * bins;
    let cum = 0;
    let picked = RAW_MAX;
    for (let b = 0; b < bins; b++) {
      cum += hist[off + b];
      if (cum >= target) {
        picked = b;
        break;
      }
    }
    baseline[k] = picked;
  }
  return baseline;
}

/**
 * Per-frame total load (the timeline curve) and the session's peak cell load.
 *
 * `loadMax` is taken here, in the one pass that already computes the deltas, so
 * the heatmap can fix its colour scale once instead of rescaling per frame.
 * Rescaling per frame makes the colours pulse as the dog steps on and off.
 */
function perFrameLoad(
  raw: Float32Array,
  baseline: Float32Array,
  frames: number,
  cells: number,
): { totals: Float32Array; loadMax: number } {
  const totals = new Float32Array(frames);
  let loadMax = 0;
  for (let f = 0; f < frames; f++) {
    const base = f * cells;
    let sum = 0;
    for (let k = 0; k < cells; k++) {
      const d = baseline[k] - raw[base + k];
      if (d > 0) {
        sum += d;
        if (d > loadMax) loadMax = d;
      }
    }
    totals[f] = sum;
  }
  return { totals, loadMax };
}

export interface KeypointDoc {
  width?: number;
  height?: number;
  fps_source?: number;
  frames?: number;
  frames_detected?: number;
  schema?: { n_slots?: number; limb_chains?: Record<string, number[]> };
  per_frame?: Array<{
    i: number;
    detected: boolean;
    keypoints?: Array<[number, number, number]> | null;
  }>;
}

/**
 * Parse `{stem}_keypoints.json` into a pose track plus a derived angle track.
 *
 * The document carries no timestamps, only a frame index and `fps_source`, so
 * sample times are `i / fps_source`. That makes pose a REGULAR track locked to
 * the video's own frame grid, which is why it is looked up with `nearest`:
 * blending two pose frames invents positions the detector never reported.
 *
 * Undetected frames are dropped rather than zero-filled, so the gap logic marks
 * them as missing and the overlay draws nothing there.
 */
export function parseKeypointsJson(doc: KeypointDoc): ParsedPose {
  const fps = doc.fps_source;
  if (!fps || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`keypoints JSON has no usable fps_source (got ${String(fps)})`);
  }
  const perFrame = doc.per_frame ?? [];
  if (perFrame.length === 0) throw new Error("keypoints JSON has an empty per_frame array");

  const detected = perFrame.filter(
    (r) => r.detected && Array.isArray(r.keypoints) && r.keypoints.length > 0,
  );
  if (detected.length === 0) {
    throw new Error(
      `keypoints JSON has no detected frames (${perFrame.length} frames, all without a dog)`,
    );
  }

  const slots = doc.schema?.n_slots || detected[0].keypoints!.length;
  const periodNs = NS_PER_SEC / fps;
  const frames = detected.length;

  const timestampsNs = new BigInt64Array(frames);
  const keypoints = new Float32Array(frames * slots * 3);
  const angles = new Float32Array(frames * ANGLE_STRIDE);
  const scratch = new Float32Array(slots * 3);

  for (let f = 0; f < frames; f++) {
    const rec = detected[f];
    timestampsNs[f] = BigInt(Math.round(rec.i * periodNs));
    const kps = rec.keypoints!;
    const base = f * slots * 3;
    for (let s = 0; s < slots; s++) {
      const kp = kps[s];
      const x = kp ? kp[0] : Number.NaN;
      const y = kp ? kp[1] : Number.NaN;
      const c = kp ? kp[2] : 0;
      keypoints[base + s * 3] = x;
      keypoints[base + s * 3 + 1] = y;
      keypoints[base + s * 3 + 2] = c;
      scratch[s * 3] = x;
      scratch[s * 3 + 1] = y;
      scratch[s * 3 + 2] = c;
    }
    computeAngleSample(scratch, angles.subarray(f * ANGLE_STRIDE, (f + 1) * ANGLE_STRIDE));
  }

  assertAscendingTimes(timestampsNs);

  return {
    timestampsNs,
    keypoints,
    angles,
    slots,
    frames,
    periodNs,
    width: doc.width ?? 0,
    height: doc.height ?? 0,
    totalFrames: doc.frames ?? perFrame.length,
    detectedFrames: doc.frames_detected ?? frames,
    limbChains: doc.schema?.limb_chains ?? null,
  };
}

/**
 * Gap threshold for a track sampled on a regular grid.
 *
 * A single dropped frame leaves a 2x interval, which the default `2 x p95` rule
 * would treat as healthy. Pose data must not be bridged across a frame the
 * detector never reported, so the threshold sits at 1.5 periods instead.
 */
export function regularGapThresholdNs(periodNs: number): bigint {
  return BigInt(Math.round(periodNs * 1.5));
}

/** Byte offsets of each non-empty line from `from` onwards. */
function collectLineStarts(text: string, from: number): Int32Array {
  const starts: number[] = [];
  let i = from;
  const len = text.length;
  while (i < len) {
    while (i < len && (text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13)) i++;
    if (i >= len) break;
    starts.push(i);
    const nl = text.indexOf("\n", i);
    if (nl < 0) break;
    i = nl + 1;
  }
  return Int32Array.from(starts);
}

/** Cursor for `scanNumber`, module-scoped so the scanner allocates nothing. */
let scanPos = 0;

/**
 * Read the next number between `scanPos` and `end`, skipping separators.
 * Returns NaN for an empty field, which is how the exporter writes a
 * non-finite cell.
 */
function scanNumber(s: string, end: number): number {
  let i = scanPos;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 44 /* , */ || c === 32 || c === 9 || c === 13) i++;
    else break;
  }
  let sign = 1;
  if (i < end && (s.charCodeAt(i) === 45 || s.charCodeAt(i) === 43)) {
    if (s.charCodeAt(i) === 45) sign = -1;
    i++;
  }
  let value = 0;
  let digits = 0;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    value = value * 10 + (c - 48);
    i++;
    digits++;
  }
  if (i < end && s.charCodeAt(i) === 46) {
    i++;
    let scale = 0.1;
    while (i < end) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 57) break;
      value += (c - 48) * scale;
      scale *= 0.1;
      i++;
      digits++;
    }
  }
  scanPos = i;
  return digits > 0 ? sign * value : Number.NaN;
}

function assertAscendingTimes(ts: BigInt64Array): void {
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] < ts[i - 1]) {
      throw new Error(
        `timestamps go backwards at sample ${i} (${ts[i - 1]} -> ${ts[i]}); the recording is corrupt`,
      );
    }
  }
}

export { SENSOR_COUNT };
