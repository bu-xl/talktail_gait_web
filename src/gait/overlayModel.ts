/**
 * Paw-overlay model — pure, DOM-free.
 *
 * Turns the gait engine's tracks / per-frame results into a compact, per-frame
 * list of "what to draw": one box + label per paw contact, in GRID coordinates
 * (row/col). The actual pixel drawing lives in `src/render/pawOverlayRenderer.ts`
 * (live canvas + GIF + PNG all share it). Keeping the model separate from any
 * canvas makes it unit-testable and reusable across the live view and exports.
 *
 * Coordinate convention: grid (row = y, col = x), matching PawBlob.copX/copY and
 * BBox.minRow..maxRow / minCol..maxCol. The renderer scales grid -> pixels.
 */

import type {
  BBox,
  FrameResult,
  PawLabelOrUnknown,
  PawTrack,
} from "./types.js";
import { FF_PROVISIONAL_CONFIDENCE_MAX } from "./footfall/constants.js";
import { trackLabelAtFrame } from "./footfall/session.js";

/** One paw contact to annotate in a single frame. */
export interface PawOverlayItem {
  readonly trackId: number;
  readonly label: PawLabelOrUnknown;
  readonly confidence: number;
  /** integer grid bounding box (inclusive) */
  readonly bbox: BBox;
  /** pressure-weighted centre of the contact (grid units) */
  readonly copRow: number;
  readonly copCol: number;
  readonly area: number;
  /** engine-space peak / sum (scaled delta) — display peak is computed at render
   *  time from the heatmap field so the printed number matches the colours. */
  readonly enginePeak: number;
  readonly engineForce: number;
}

export interface PawOverlayFrame {
  /** -1 for a session-summary (peak) frame */
  readonly frameIndex: number;
  readonly items: PawOverlayItem[];
}

/**
 * Contact-quality gates — only annotate REAL, sustained paw contacts (filters
 * noise specks, faint touches and momentary blips). Applied to both the live and
 * the recorded overlays so weak/transient data is never boxed.
 */
export interface OverlayQuality {
  /** Only draw while the paw is in contact (live: hysteresis state; session:
   *  inside a real contact event). */
  readonly requireContact: boolean;
  /** Minimum contact area (grid cells). */
  readonly minArea: number;
  /** Minimum contact peak (engine magnitude, i.e. PawBlob.peakPressure). */
  readonly minPeak: number;
  /** Live: a track must persist this many frames before being drawn. */
  readonly minTrackFrames: number;
  /** Session: a contact event must last this many frames to count as a step. */
  readonly minContactFrames: number;
}

export const DEFAULT_OVERLAY_QUALITY: OverlayQuality = {
  requireContact: true,
  minArea: 3,
  minPeak: 60,
  minTrackFrames: 3,
  minContactFrames: 3,
};

export interface SessionOverlayOptions {
  /** draw boxes for tracks that never got a confident L/R-F/H label */
  readonly includeUnknown?: boolean;
  /** contact-quality gates (defaults to DEFAULT_OVERLAY_QUALITY) */
  readonly quality?: OverlayQuality;
}

/** True if `frame` lies inside any [start,end] contact interval (inclusive). */
function inAnyContact(frame: number, intervals: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [s, e] of intervals) if (frame >= s && frame <= e) return true;
  return false;
}

/** Per-paw overlay colours (RGB). Matches the side-panel legend. */
export const PAW_COLORS: Record<PawLabelOrUnknown, readonly [number, number, number]> = {
  LF: [60, 130, 246], // blue
  RF: [235, 70, 60], // red
  LH: [40, 200, 220], // cyan
  RH: [255, 150, 40], // orange
  Unknown: [165, 170, 178], // grey
};

/** Ordered colour list (for building a stable GIF palette). */
export const PAW_COLOR_LIST: ReadonlyArray<readonly [number, number, number]> = [
  PAW_COLORS.LF,
  PAW_COLORS.RF,
  PAW_COLORS.LH,
  PAW_COLORS.RH,
  PAW_COLORS.Unknown,
];

function finalLabel(track: PawTrack, frameIndex?: number): PawLabelOrUnknown {
  if (track.lockedLabel) return track.lockedLabel;
  if (frameIndex !== undefined) {
    const frozen = trackLabelAtFrame(track, frameIndex);
    if (frozen) return frozen;
  }
  if (track.label !== "Unknown") return track.label;
  return track.lockedLabel ?? track.label;
}

function itemFromBlob(
  trackId: number,
  label: PawLabelOrUnknown,
  confidence: number,
  blob: PawTrack["history"][number],
): PawOverlayItem {
  return {
    trackId,
    label,
    confidence,
    bbox: blob.bbox,
    copRow: blob.copY,
    copCol: blob.copX,
    area: blob.area,
    enginePeak: blob.peakPressure,
    engineForce: blob.pressureSum,
  };
}

/**
 * Back-apply each track's FINAL label to every frame it was present in.
 *
 * This is the authoritative, post-recording overlay: the whole walk decides
 * L/R + F/H once, then that stable label is shown on every frame (no flicker as
 * the dog walks). Tracks must carry full history (set a large
 * `maxTrackHistoryFrames` before processing a long session).
 */
export function buildSessionOverlayFrames(
  tracks: readonly PawTrack[],
  frameCount: number,
  opts: SessionOverlayOptions = {},
): PawOverlayFrame[] {
  const includeUnknown = opts.includeUnknown ?? false;
  const q = opts.quality ?? DEFAULT_OVERLAY_QUALITY;
  const frames: PawOverlayFrame[] = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) frames[i] = { frameIndex: i, items: [] };

  for (const track of tracks) {
    const sessionLabel = finalLabel(track);
    if (!includeUnknown && sessionLabel === "Unknown") continue;

    // A "real foot" must have at least one stance long enough to be a footfall.
    const contacts = track.contactEvents
      .filter((e) => e.endFrame - e.startFrame + 1 >= q.minContactFrames)
      .map((e) => [e.startFrame, e.endFrame] as const);
    if (q.requireContact && contacts.length === 0) continue;

    const conf = track.labelConfidence;
    const n = Math.min(track.history.length, track.frameIndices.length);
    for (let k = 0; k < n; k++) {
      const fi = track.frameIndices[k]!;
      if (fi < 0 || fi >= frameCount) continue;
      const blob = track.history[k]!;
      // Only draw during a genuine stance, and only for solid contacts.
      if (q.requireContact && !inAnyContact(fi, contacts)) continue;
      if (blob.area < q.minArea || blob.peakPressure < q.minPeak) continue;
      const labelAtFrame = finalLabel(track, fi);
      if (!includeUnknown && labelAtFrame === "Unknown") continue;
      frames[fi]!.items.push(itemFromBlob(track.trackId, labelAtFrame, conf, blob));
    }
  }
  return frames;
}

/** Live overlay for a single just-processed frame (progressive labels). */
export function overlayFrameFromResult(
  result: FrameResult,
  includeUnknown = false,
  quality: OverlayQuality = DEFAULT_OVERLAY_QUALITY,
): PawOverlayFrame {
  const q = quality;
  const items: PawOverlayItem[] = [];
  for (const track of result.tracks) {
    // Only paws actually in contact THIS frame (matched a blob) get a box.
    if (track.lastFrameIndex !== result.frameIndex || !track.lastBlob) continue;
    // Quality gates: solid, sustained, in-contact paws only (drop noise specks).
    if (q.requireContact && !track.contact) continue;
    if (track.history.length < q.minTrackFrames) continue;
    const blob = track.lastBlob;
    if (blob.area < q.minArea || blob.peakPressure < q.minPeak) continue;
    const label = finalLabel(track, result.frameIndex);
    if (!includeUnknown && label === "Unknown") continue;
    const conf = track.labelConfidence;
    items.push(itemFromBlob(track.trackId, label, conf, blob));
  }
  return { frameIndex: result.frameIndex, items };
}

/**
 * One item per labelled paw for the peak-footprint (PNG) view: union bbox over
 * the whole stance history, pressure-weighted centre, strongest peak. Keeps the
 * highest-force track when two share a label.
 */
export function buildPawSummaryOverlay(tracks: readonly PawTrack[]): PawOverlayFrame {
  const best = new Map<PawLabelOrUnknown, PawOverlayItem>();
  for (const track of tracks) {
    const label = finalLabel(track);
    if (label === "Unknown" || track.history.length === 0) continue;

    let minRow = Infinity;
    let maxRow = -Infinity;
    let minCol = Infinity;
    let maxCol = -Infinity;
    let wSum = 0;
    let cRow = 0;
    let cCol = 0;
    let peak = 0;
    let force = 0;
    let area = 0;
    for (const b of track.history) {
      minRow = Math.min(minRow, b.bbox.minRow);
      maxRow = Math.max(maxRow, b.bbox.maxRow);
      minCol = Math.min(minCol, b.bbox.minCol);
      maxCol = Math.max(maxCol, b.bbox.maxCol);
      const w = b.pressureSum;
      wSum += w;
      cRow += b.copY * w;
      cCol += b.copX * w;
      peak = Math.max(peak, b.peakPressure);
      force = Math.max(force, b.pressureSum);
      area = Math.max(area, b.area);
    }
    if (wSum <= 0) continue;
    const item: PawOverlayItem = {
      trackId: track.trackId,
      label,
      confidence: track.labelConfidence,
      bbox: { minRow, maxRow, minCol, maxCol },
      copRow: cRow / wSum,
      copCol: cCol / wSum,
      area,
      enginePeak: peak,
      engineForce: force,
    };
    const prev = best.get(label);
    if (!prev || item.engineForce > prev.engineForce) best.set(label, item);
  }
  return { frameIndex: -1, items: [...best.values()] };
}

/** Count items carrying a real (non-Unknown) paw label. */
export function countLabeled(frame: PawOverlayFrame): number {
  let n = 0;
  for (const it of frame.items) if (it.label !== "Unknown") n++;
  return n;
}

/**
 * Peak + summed value of a display field within a grid bbox. Used to print a
 * meaningful pressure number that matches the heatmap colours. NaN cells (below
 * the visible threshold) count as 0.
 */
export function fieldStatsInBBox(
  field: ArrayLike<number>,
  cols: number,
  bbox: BBox,
): { peak: number; force: number; cells: number } {
  let peak = 0;
  let force = 0;
  let cells = 0;
  for (let r = bbox.minRow; r <= bbox.maxRow; r++) {
    const base = r * cols;
    for (let c = bbox.minCol; c <= bbox.maxCol; c++) {
      const v = field[base + c];
      if (v == null || Number.isNaN(v) || v <= 0) continue;
      if (v > peak) peak = v;
      force += v;
      cells++;
    }
  }
  return { peak, force, cells };
}
